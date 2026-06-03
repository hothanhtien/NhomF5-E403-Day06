import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from database import get_db
from models import TravelPlan
from agents.intent_agent import parse_intent, is_intent_complete
from agents.itinerary_agent import build_itinerary
from tools.places import search_places, get_place_details, search_hotels, search_restaurants
from tools.routes import calculate_route
from tools.budget import estimate_budget, validate_itinerary

router = APIRouter()


class Message(BaseModel):
    role: str   # "user" | "assistant"
    content: str


class ChatRequest(BaseModel):
    conversation: list[Message]
    regenerate_style: str | None = None  # "cheaper" | "relaxed" | "more_food" | None


class ChatResponse(BaseModel):
    type: str  # "clarification" | "plan"
    clarification: str | None = None
    plan: dict | None = None


@router.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest, db: AsyncSession = Depends(get_db)):
    messages = [m.model_dump() for m in req.conversation]

    # If regenerate style requested, inject modifier into last user message
    if req.regenerate_style:
        style_map = {
            "cheaper": "Hãy làm lịch trình rẻ hơn, ưu tiên điểm miễn phí và khách sạn bình dân.",
            "relaxed": "Hãy làm lịch trình nhẹ nhàng hơn, ít điểm hơn, nhiều thời gian nghỉ ngơi.",
            "more_food": "Hãy thêm nhiều quán ăn và cafe địa phương vào lịch trình.",
        }
        hint = style_map.get(req.regenerate_style, "")
        if hint:
            messages.append({"role": "user", "content": hint})

    # Step 1: Parse intent
    try:
        intent = await parse_intent(messages)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    # Step 2: Clarify if needed
    if not is_intent_complete(intent):
        return ChatResponse(type="clarification", clarification=intent.get("clarification"))

    # Step 3: Fetch places
    destination = intent["destination"]
    preferences = intent.get("preferences", [])

    try:
        attraction_raw = await search_places(destination, "tourist_attraction", preferences)
        place_details = list(await asyncio.gather(*[
            get_place_details(p["place_id"]) for p in attraction_raw[:12] if p.get("place_id")
        ]))
        hotels = await search_hotels(destination)
        restaurants = await search_restaurants(destination, preferences)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Places API error: {exc}")

    # Step 4: Build itinerary
    try:
        itinerary = await build_itinerary(intent, place_details, hotels, restaurants)
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    # Step 4b: Inject real photoUrl using placeId lookup (GPT outputs placeId from provided data)
    all_real_places = place_details + hotels + restaurants
    photo_by_id: dict[str, str] = {
        p["placeId"]: p["photoUrl"]
        for p in all_real_places
        if p.get("placeId") and p.get("photoUrl")
    }

    for day in itinerary:
        for item in day.get("items", []):
            pid = item.get("placeId")
            if pid and pid in photo_by_id:
                item["photoUrl"] = photo_by_id[pid]
            else:
                item["photoUrl"] = ""

    # Step 5: Calculate routes per day (all days in parallel)
    day_colors = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"]

    def _day_coords(day: dict) -> list[tuple[float, float]]:
        return [
            (item["lng"], item["lat"])
            for item in day.get("items", [])
            if item.get("lat") and item.get("lng")
        ]

    async def _empty() -> dict:
        return {}

    coords_per_day = [_day_coords(day) for day in itinerary]
    routes = await asyncio.gather(*[
        calculate_route(c) if len(c) >= 2 else _empty()
        for c in coords_per_day
    ])

    map_days = []
    for i, (day, route) in enumerate(zip(itinerary, routes)):
        legs = route.get("legs", [])
        for j, item in enumerate(day.get("items", [])):
            if j > 0 and j - 1 < len(legs):
                item["travelTimeFromPrevious"] = f"{legs[j - 1]['duration_minutes']} phút"

        markers = [
            {
                "lat": item["lat"],
                "lng": item["lng"],
                "name": item["name"],
                "photoUrl": item.get("photoUrl", ""),
                "rating": item.get("rating", 0),
                "cost": item.get("estimatedCost", 0),
            }
            for item in day.get("items", [])
            if item.get("lat") and item.get("lng")
        ]
        map_days.append({
            "day": day["day"],
            "color": day_colors[i % len(day_colors)],
            "markers": markers,
            "routePolyline": route.get("polyline", ""),
        })

    map_data = {"days": map_days}

    # Step 6: Budget + validation
    hotel = hotels[0] if hotels else {}
    budget_summary = estimate_budget(intent, itinerary, hotel)
    warnings = validate_itinerary(intent, itinerary, budget_summary)

    plan = {
        "intent": intent,
        "itinerary": itinerary,
        "budgetSummary": budget_summary,
        "mapData": map_data,
        "warnings": warnings,
        "optionalPlaces": [],
        "hotel": hotel,
    }

    # Step 7: Save to DB
    record = TravelPlan(
        intent=intent,
        itinerary=itinerary,
        budget_summary=budget_summary,
        map_data=map_data,
        warnings=warnings,
        optional_places=[],
    )
    db.add(record)
    await db.commit()
    plan["planId"] = record.id

    return ChatResponse(type="plan", plan=plan)
