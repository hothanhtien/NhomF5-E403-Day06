import os
import httpx

MAPBOX_TOKEN = os.environ["MAPBOX_ACCESS_TOKEN"]


async def calculate_route(coordinates: list[tuple[float, float]]) -> dict:
    """
    coordinates: list of (lng, lat) tuples in order.
    Returns {"polyline": str, "duration_minutes": int, "distance_km": float, "legs": list}
    """
    if len(coordinates) < 2:
        return {"polyline": "", "duration_minutes": 0, "distance_km": 0.0, "legs": []}

    coords_str = ";".join(f"{lng},{lat}" for lng, lat in coordinates)
    url = f"https://api.mapbox.com/directions/v5/mapbox/driving/{coords_str}"

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            url,
            params={
                "access_token": MAPBOX_TOKEN,
                "geometries": "polyline6",
                "overview": "full",
            },
        )
        resp.raise_for_status()
        data = resp.json()

    if not data.get("routes"):
        return {"polyline": "", "duration_minutes": 0, "distance_km": 0.0, "legs": []}

    route = data["routes"][0]
    legs = [
        {
            "duration_minutes": round(leg["duration"] / 60),
            "distance_km": round(leg["distance"] / 1000, 1),
        }
        for leg in route.get("legs", [])
    ]

    return {
        "polyline": route["geometry"],
        "duration_minutes": round(route["duration"] / 60),
        "distance_km": round(route["distance"] / 1000, 1),
        "legs": legs,
    }
