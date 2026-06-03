import asyncio
import os
import re
import httpx

GOOGLE_API_KEY = os.environ["GOOGLE_MAPS_API_KEY"]
PLACES_BASE = "https://maps.googleapis.com/maps/api/place"

# Pattern expected for Google Places photo references (alphanumeric + dash/underscore)
_PHOTO_REF_RE = re.compile(r"^[A-Za-z0-9_\-]+$")


async def search_places(destination: str, place_type: str, preferences: list[str]) -> list[dict]:
    """
    place_type: "tourist_attraction" | "cafe" | "restaurant" | "lodging"
    Returns list of place dicts with basic info.
    """
    parts = [p for p in [place_type, destination] + preferences if p]
    query = " ".join(parts)
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{PLACES_BASE}/textsearch/json",
            params={
                "query": query,
                "key": GOOGLE_API_KEY,
                "language": "vi",
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
        photo_ref = _extract_photo_ref(data.get("photos", []))
        photo_url = f"/api/photo?ref={photo_ref}" if photo_ref else ""
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
            "photoRef": photo_ref,
            "category": _primary_type(data.get("types", [])),
            "priceLevel": price_level,
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
