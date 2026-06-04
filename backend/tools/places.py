import asyncio
import os
import re
import httpx

GOOGLE_API_KEY = os.environ["GOOGLE_MAPS_API_KEY"]
PLACES_BASE = "https://maps.googleapis.com/maps/api/place"
UNSPLASH_KEY = os.environ.get("UNSPLASH_ACCESS_KEY", "")
UNSPLASH_BASE = "https://api.unsplash.com"

# Pattern expected for Google Places photo references (alphanumeric + dash/underscore)
_PHOTO_REF_RE = re.compile(r"^[A-Za-z0-9_\-]+$")


_TYPE_QUERY = {
    "tourist_attraction": "địa điểm tham quan nổi tiếng",
    "cafe": "quán cafe",
    "restaurant": "nhà hàng quán ăn",
    "lodging": "khách sạn homestay",
}


async def search_places(destination: str, place_type: str, preferences: list[str]) -> list[dict]:
    """
    place_type: "tourist_attraction" | "cafe" | "restaurant" | "lodging"
    Returns list of place dicts with basic info.
    """
    type_phrase = _TYPE_QUERY.get(place_type, place_type)
    pref_phrase = " ".join(preferences[:3]) if preferences else ""
    parts = [type_phrase, destination]
    if pref_phrase:
        parts.append(pref_phrase)
    query = " ".join(parts)

    async with httpx.AsyncClient(timeout=12.0) as client:
        resp = await client.get(
            f"{PLACES_BASE}/textsearch/json",
            params={
                "query": query,
                "key": GOOGLE_API_KEY,
                "language": "vi",
                "type": place_type if place_type in ("cafe", "restaurant", "lodging") else "",
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("results", [])


async def get_place_details(place_id: str) -> dict:
    """Fetch full details including photos, address, opening hours."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{PLACES_BASE}/details/json",
            params={
                "place_id": place_id,
                "fields": "place_id,name,geometry,rating,user_ratings_total,formatted_address,opening_hours,photos,types,price_level",
                "key": GOOGLE_API_KEY,
                "language": "vi",
            },
        )
        resp.raise_for_status()
        data = resp.json().get("result", {})
        photos = data.get("photos", []) or []
        photo_refs = [p.get("photo_reference", "") for p in photos[:5]]
        photo_refs = [r for r in photo_refs if r and _PHOTO_REF_RE.match(r)]
        photo_urls = [f"/api/photo?ref={r}" for r in photo_refs]
        photo_url = photo_urls[0] if photo_urls else ""
        location = data.get("geometry", {}).get("location", {})
        price_level = _map_price_level(data.get("price_level"))
        return {
            "placeId": place_id,
            "name": data.get("name", ""),
            "lat": location.get("lat"),
            "lng": location.get("lng"),
            "rating": data.get("rating", 0),
            "reviewCount": data.get("user_ratings_total", 0),
            "address": data.get("formatted_address", ""),
            "photoUrl": photo_url,
            "photoUrls": photo_urls,
            "photoRef": photo_refs[0] if photo_refs else "",
            "category": _primary_type(data.get("types", [])),
            "priceLevel": price_level,
            "types": data.get("types", []),
        }


async def search_hotels(destination: str) -> list[dict]:
    raw = await search_places(destination, "lodging", [])
    return list(await asyncio.gather(*[get_place_details(p["place_id"]) for p in raw[:5]]))


async def search_restaurants(destination: str, preferences: list[str]) -> list[dict]:
    raw = await search_places(destination, "restaurant", preferences)
    return list(await asyncio.gather(*[get_place_details(p["place_id"]) for p in raw[:8]]))


async def fetch_photo_bytes(photo_ref: str) -> bytes:
    """Proxy Google Places photo fetch server-side. Called by /api/photo endpoint."""
    if not _PHOTO_REF_RE.match(photo_ref):
        raise ValueError(f"Invalid photo reference: {photo_ref}")
    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
        resp = await client.get(
            f"{PLACES_BASE}/photo",
            params={
                "maxwidth": 800,
                "photo_reference": photo_ref,
                "key": GOOGLE_API_KEY,
            },
        )
        resp.raise_for_status()
        return resp.content


async def search_unsplash_photo(query: str) -> str:
    """
    Search Unsplash for a landscape photo matching the query.
    Returns the 'regular' image URL or "" if not found / key missing.
    """
    if not UNSPLASH_KEY:
        return ""
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(
                f"{UNSPLASH_BASE}/search/photos",
                headers={"Authorization": f"Client-ID {UNSPLASH_KEY}"},
                params={
                    "query": query,
                    "per_page": 1,
                    "orientation": "landscape",
                    "content_filter": "high",
                },
            )
            resp.raise_for_status()
            results = resp.json().get("results", [])
            if results:
                return results[0]["urls"]["regular"]
    except Exception:
        pass
    return ""


def _extract_photo_ref(photos: list) -> str:
    if not photos:
        return ""
    ref = photos[0].get("photo_reference", "")
    if not ref or not _PHOTO_REF_RE.match(ref):
        return ""
    return ref


def _map_price_level(level) -> str:
    mapping = {
        0: "PRICE_LEVEL_FREE",
        1: "PRICE_LEVEL_INEXPENSIVE",
        2: "PRICE_LEVEL_MODERATE",
        3: "PRICE_LEVEL_EXPENSIVE",
        4: "PRICE_LEVEL_VERY_EXPENSIVE",
    }
    return mapping.get(level, "PRICE_LEVEL_UNSPECIFIED")


def _primary_type(types: list[str]) -> str:
    priority = ["cafe", "restaurant", "lodging", "tourist_attraction", "park", "museum", "bar"]
    for t in priority:
        if t in types:
            return t
    return types[0] if types else ""
