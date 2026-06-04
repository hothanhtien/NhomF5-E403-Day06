import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from database import get_db
from models import TravelPlan
from agents.intent_agent import parse_intent, is_intent_complete
from agents.itinerary_agent import build_itinerary
from tools.places import search_places, get_place_details, search_unsplash_photo
from tools.routes import calculate_route
from tools.budget import estimate_budget, validate_itinerary
from tools.optimizer import (
    optimize_route,
    revise_for_budget,
    attach_travel_times,
    parse_duration_days,
)

router = APIRouter()


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    conversation: list[Message]
    regenerate_style: str | None = None


class ChatResponse(BaseModel):
    type: str
    clarification: str | None = None
    plan: dict | None = None


DAY_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"]

ATTRACTION_LIMIT = 18
HOTEL_LIMIT = 5
RESTAURANT_LIMIT = 10
CAFE_LIMIT = 8


async def _safe_details(place_ids: list[str]) -> list[dict]:
    """Fetch place details with per-item error tolerance."""
    results = await asyncio.gather(
        *[get_place_details(pid) for pid in place_ids],
        return_exceptions=True,
    )
    return [r for r in results if isinstance(r, dict)]


@router.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest, db: AsyncSession = Depends(get_db)):
    messages = [m.model_dump() for m in req.conversation]

    if req.regenerate_style:
        style_map = {
            "cheaper": "Hãy làm lịch trình rẻ hơn, ưu tiên điểm miễn phí và khách sạn bình dân.",
            "relaxed": "Hãy làm lịch trình nhẹ nhàng hơn, ít điểm hơn, nhiều thời gian nghỉ ngơi.",
            "more_food": "Hãy thêm nhiều quán ăn và cafe địa phương vào lịch trình.",
        }
        hint = style_map.get(req.regenerate_style, "")
        if hint:
            messages.append({"role": "user", "content": hint})

    # ── Step 1: Parse intent ───────────────────────────────
    try:
        intent = await parse_intent(messages)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    if not is_intent_complete(intent):
        return ChatResponse(type="clarification", clarification=intent.get("clarification"))

    destination = intent["destination"]
    preferences = intent.get("preferences", [])

    # ── Step 2: Search places in parallel (4 types) ────────
    try:
        attraction_raw, hotels_raw, restaurants_raw, cafes_raw = await asyncio.gather(
            search_places(destination, "tourist_attraction", preferences),
            search_places(destination, "lodging", []),
            search_places(destination, "restaurant", preferences),
            search_places(destination, "cafe", []),
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Places search error: {exc}")

    attraction_ids = [p["place_id"] for p in attraction_raw[:ATTRACTION_LIMIT] if p.get("place_id")]
    hotel_ids = [p["place_id"] for p in hotels_raw[:HOTEL_LIMIT] if p.get("place_id")]
    restaurant_ids = [p["place_id"] for p in restaurants_raw[:RESTAURANT_LIMIT] if p.get("place_id")]
    cafe_ids = [p["place_id"] for p in cafes_raw[:CAFE_LIMIT] if p.get("place_id")]

    # ── Step 3: Fetch details in parallel, resilient ───────
    try:
        place_details, hotels, restaurants, cafes = await asyncio.gather(
            _safe_details(attraction_ids),
            _safe_details(hotel_ids),
            _safe_details(restaurant_ids),
            _safe_details(cafe_ids),
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Place details error: {exc}")

    # Tag cafes with type so GPT knows they are cafes
    for c in cafes:
        c.setdefault("category", "cafe")

    # Merge cafes into the restaurant list for GPT context (labelled)
    all_restaurants = restaurants + cafes

    # ── Step 4: Build itinerary via GPT-4o ────────────────
    try:
        itinerary, suggested_hotel = await build_itinerary(intent, place_details, hotels, all_restaurants)
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    # Use suggested_hotel from GPT as fallback when Google Places returns nothing
    effective_hotel = hotels[0] if hotels else (suggested_hotel or {})

    # ── Step 4a: Build a rich lookup for photo/coord enrichment
    # Key by placeId AND by normalized name for fuzzy fallback
    all_real_places = place_details + hotels + all_restaurants
    photo_by_id: dict[str, dict] = {p["placeId"]: p for p in all_real_places if p.get("placeId")}
    photo_by_name: dict[str, dict] = {_norm(p.get("name", "")): p for p in all_real_places if p.get("name")}

    flat_items: list[dict] = []
    for day in itinerary:
        for item in day.get("items", []):
            ref = None
            pid = item.get("placeId")
            if pid and pid in photo_by_id:
                ref = photo_by_id[pid]
            else:
                # Fuzzy fallback: match by normalized name
                nname = _norm(item.get("name", ""))
                ref = photo_by_name.get(nname)

            if ref:
                item["photoUrl"] = ref.get("photoUrl") or ""
                item["photoUrls"] = ref.get("photoUrls") or []
                item["lat"] = item.get("lat") or ref.get("lat")
                item["lng"] = item.get("lng") or ref.get("lng")
                item["rating"] = item.get("rating") or ref.get("rating") or 0
                item["address"] = ref.get("address") or ""
                # Back-fill placeId if GPT left it null
                if not item.get("placeId"):
                    item["placeId"] = ref.get("placeId", "")
            else:
                item.setdefault("photoUrl", "")
                item.setdefault("photoUrls", [])
            flat_items.append(item)

    # ── Step 4a-2: Unsplash fallback for items without photos ─
    await _fill_unsplash_photos(flat_items, destination)

    # ── Step 4b: Nearest-neighbor route optimization ───────
    days = parse_duration_days(intent.get("duration", "2 đêm"))
    day_chunks = optimize_route(flat_items, days=days)

    # Ensure each day has at least 1 food/cafe item
    _ensure_food_per_day(day_chunks)

    # ── Step 4c: Inject hotel as anchor for each day ───────
    # Remove all hotel-related items GPT placed (type hotel/check-out, or name matches
    # hotel name) so we can inject deterministically at correct positions.
    if effective_hotel:
        hotel_name = effective_hotel.get("name", "")
        for chunk in day_chunks:
            chunk[:] = [
                it for it in chunk
                if it.get("type") not in ("hotel",)
                and (not hotel_name or it.get("name") != hotel_name)
            ]
        _inject_hotel_anchors(day_chunks, effective_hotel)

    # ── Step 5: Calculate Mapbox routes per day ────────────
    def _day_coords(day: list[dict]) -> list[tuple[float, float]]:
        return [
            (float(item["lng"]), float(item["lat"]))
            for item in day
            if item.get("lat") and item.get("lng")
        ]

    coords_per_day = [_day_coords(d) for d in day_chunks]
    routes = await asyncio.gather(*[
        calculate_route(c) if len(c) >= 2 else _empty_route()
        for c in coords_per_day
    ])

    # Attach travel times
    final_itinerary: list[dict] = []
    for i, (day_items, route) in enumerate(zip(day_chunks, routes)):
        legs = route.get("legs", [])
        leg_minutes = [leg.get("duration_minutes", 0) for leg in legs]
        attach_travel_times(day_items, leg_minutes)
        final_itinerary.append({
            "day": i + 1,
            "title": day_items[0].get("dayTitle", f"Ngày {i + 1}") if day_items else f"Ngày {i + 1}",
            "items": day_items,
        })

    # ── Step 6: Budget + revise ────────────────────────────
    hotel = effective_hotel
    people = intent.get("people", 2)
    budget = intent.get("budget", 0) or 0

    provisional = estimate_budget(intent, final_itinerary, hotel)
    hotel_cost = provisional["hotel"]

    revised_chunks, removed = revise_for_budget(
        [d["items"] for d in final_itinerary],
        hotel_cost=hotel_cost,
        people=people,
        budget=budget,
    )

    final_itinerary = [
        {"day": i + 1, "title": day["title"], "items": chunk}
        for i, (day, chunk) in enumerate(zip(final_itinerary, revised_chunks))
    ]

    # Recompute routes after budget revision
    coords_per_day = [_day_coords(d["items"]) for d in final_itinerary]
    routes2 = await asyncio.gather(*[
        calculate_route(c) if len(c) >= 2 else _empty_route()
        for c in coords_per_day
    ])
    for day, route in zip(final_itinerary, routes2):
        legs = route.get("legs", [])
        leg_minutes = [leg.get("duration_minutes", 0) for leg in legs]
        attach_travel_times(day["items"], leg_minutes)

    # ── Step 7: Final budget + validation ─────────────────
    budget_summary = estimate_budget(intent, final_itinerary, hotel)
    warnings = validate_itinerary(intent, final_itinerary, budget_summary)
    if removed:
        warnings.insert(
            0,
            "Đã tự động bỏ " + str(len(removed)) +
            " điểm để vừa ngân sách: " +
            ", ".join(removed[:5]) + ("…" if len(removed) > 5 else ""),
        )

    # ── Step 8: Build map data ─────────────────────────────
    map_days = []
    for i, (day, route) in enumerate(zip(final_itinerary, routes2)):
        markers = [
            {
                "lat": item.get("lat"),
                "lng": item.get("lng"),
                "name": item.get("name", ""),
                "photoUrl": item.get("photoUrl", ""),
                "photoUrls": item.get("photoUrls", []),
                "rating": item.get("rating", 0),
                "cost": item.get("estimatedCost", 0),
                "type": item.get("type", ""),
                "time": item.get("time", ""),
                "reason": item.get("reason", ""),
                "estimatedDuration": item.get("estimatedDuration", 0),
                "address": item.get("address", ""),
            }
            for item in day["items"]
            if item.get("lat") and item.get("lng")
        ]
        map_days.append({
            "day": day["day"],
            "color": DAY_COLORS[i % len(DAY_COLORS)],
            "markers": markers,
            "routePolyline": route.get("polyline", ""),
        })

    map_data = {"days": map_days}

    plan = {
        "intent": intent,
        "itinerary": final_itinerary,
        "budgetSummary": budget_summary,
        "mapData": map_data,
        "warnings": warnings,
        "optionalPlaces": [],
        "hotel": hotel,
    }

    # ── Step 9: Persist to DB ──────────────────────────────
    original_prompt = next(
        (m["content"] for m in reversed(messages) if m["role"] == "user"), ""
    )
    record = TravelPlan(
        destination=intent.get("destination", ""),
        budget=intent.get("budget", 0) or 0,
        people=intent.get("people", 1) or 1,
        duration_days=parse_duration_days(intent.get("duration", "1 ngày")),
        within_budget=budget_summary.get("withinBudget", True),
        total_cost=budget_summary.get("total", 0),
        prompt=original_prompt,
        preferences=intent.get("preferences", []),
        intent=intent,
        itinerary=final_itinerary,
        budget_summary=budget_summary,
        map_data=map_data,
        warnings=warnings,
        optional_places=[],
    )
    db.add(record)
    try:
        await db.commit()
        plan["planId"] = record.id
    except Exception:
        await db.rollback()
        plan["planId"] = None

    return ChatResponse(type="plan", plan=plan)


# ── Helpers ────────────────────────────────────────────────

async def _empty_route() -> dict:
    return {"polyline": "", "duration_minutes": 0, "distance_km": 0.0, "legs": []}


async def _fill_unsplash_photos(items: list[dict], destination: str) -> None:
    """
    For each item that has no photoUrl, fetch one from Unsplash.
    Batches all requests in parallel to keep latency low.
    Items with type 'hotel' use the hotel name + destination as query.
    """
    needs_photo = [it for it in items if not it.get("photoUrl")]
    if not needs_photo:
        return

    async def _fetch(item: dict) -> str:
        name = item.get("name", "")
        query = f"{name} {destination}" if name else destination
        return await search_unsplash_photo(query)

    urls = await asyncio.gather(*[_fetch(it) for it in needs_photo], return_exceptions=True)
    for item, url in zip(needs_photo, urls):
        if isinstance(url, str) and url:
            item["photoUrl"] = url
            item["photoUrls"] = [url]


def _norm(s: str) -> str:
    """Normalize place name for fuzzy matching (lowercase, strip)."""
    return s.lower().strip()


def _inject_hotel_anchors(day_chunks: list[list[dict]], hotel: dict) -> None:
    """
    Prepend hotel item to each day as the morning departure anchor.
    Last day gets an extra check-out item appended at the end.
    """
    total_days = len(day_chunks)
    for i, chunk in enumerate(day_chunks):
        is_first = i == 0
        is_last = i == total_days - 1

        morning_item = {
            "time": "08:00",
            "name": hotel.get("name", "Khách sạn"),
            "placeId": hotel.get("placeId", ""),
            "type": "hotel",
            "reason": "Check-in và nghỉ ngơi tại khách sạn." if is_first else "Xuất phát từ khách sạn buổi sáng.",
            "estimatedCost": 0,
            "estimatedDuration": 30,
            "travelTimeFromPrevious": "",
            "lat": hotel.get("lat"),
            "lng": hotel.get("lng"),
            "photoUrl": hotel.get("photoUrl", ""),
            "photoUrls": hotel.get("photoUrls", []),
            "rating": hotel.get("rating", 0),
            "address": hotel.get("address", ""),
            "bookingName": hotel.get("name", ""),
        }
        chunk.insert(0, morning_item)

        if is_last:
            checkout_item = dict(morning_item)
            checkout_item["time"] = "12:00"
            checkout_item["reason"] = "Trả phòng và chuẩn bị về."
            checkout_item["estimatedDuration"] = 60
            chunk.append(checkout_item)


def _ensure_food_per_day(day_chunks: list[list[dict]]) -> None:
    """Move one restaurant/cafe to any day that has zero food items."""
    food_types = {"restaurant", "cafe", "food"}
    for i, day in enumerate(day_chunks):
        if not any(it.get("type") in food_types for it in day):
            donor_idx = max(
                range(len(day_chunks)),
                key=lambda j: sum(1 for it in day_chunks[j] if it.get("type") in food_types),
                default=-1,
            )
            if donor_idx < 0 or donor_idx == i:
                continue
            for j, item in enumerate(day_chunks[donor_idx]):
                if item.get("type") in food_types:
                    day_chunks[i].append(day_chunks[donor_idx].pop(j))
                    break
