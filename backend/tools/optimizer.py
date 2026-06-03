"""
Route + budget optimizer.

Tách khỏi itinerary_agent (GPT-4o) để có kiểm soát deterministic:
- nearest-neighbor theo khoảng cách thực giữa các địa điểm
- chunk theo số ngày
- nếu vượt ngân sách: cắt điểm đắt nhất trước (cost/benefit ratio thấp nhất)
- re-estimate routes theo thứ tự mới
"""
from __future__ import annotations

import math
import re
from typing import Iterable


# Haversine — km
def _haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lng1 = a
    lat2, lng2 = b
    R = 6371.0
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    h = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(d_lng / 2) ** 2
    )
    return 2 * R * math.asin(math.sqrt(h))


def _has_coords(item: dict) -> bool:
    return bool(item.get("lat")) and bool(item.get("lng"))


def _item_key(item: dict) -> str:
    """Stable key so we can match items across optimize/revise calls."""
    return (
        item.get("placeId")
        or f"{item.get('name','')}|{round(item.get('lat') or 0, 5)}|{round(item.get('lng') or 0, 5)}"
    )


def _parse_nights(duration: str) -> int:
    m = re.search(r"(\d+)\s*đêm", duration or "")
    if m:
        return int(m.group(1))
    m = re.search(r"(\d+)\s*ngày", duration or "")
    if m:
        return max(1, int(m.group(1)) - 1)
    return 2


def _score_item(item: dict) -> float:
    """
    Benefit per VND spent.
    Ưu tiên rating cao + rẻ → score cao → giữ lại khi phải cắt.
    """
    rating = float(item.get("rating") or 0)
    cost = float(item.get("estimatedCost") or 0)
    if cost <= 0:
        return rating + 1.0  # free places are almost always worth keeping
    return (rating + 1.0) / cost


def _items_total_cost(items: Iterable[dict], people: int) -> int:
    return sum(int(item.get("estimatedCost") or 0) * people for item in items)


def _split_by_day(items: list[dict], days: int) -> list[list[dict]]:
    """Chunk items into N days preserving order (already ordered from optimize)."""
    if days <= 0:
        return [items]
    if not items:
        return [[] for _ in range(days)]
    # Greedy round-robin by day target count
    target = max(1, round(len(items) / days))
    chunks: list[list[dict]] = []
    i = 0
    for _ in range(days):
        chunk = items[i : i + target]
        i += target
        chunks.append(chunk)
    if i < len(items):
        chunks[-1].extend(items[i:])
    return chunks


def optimize_route(items: list[dict], days: int) -> list[list[dict]]:
    """
    Order items by nearest-neighbor starting from the highest-rated place,
    then split into `days` day-chunks. Items without coords are appended
    to whichever day has fewest items (so they don't break the route).
    """
    with_coords = [it for it in items if _has_coords(it)]
    without_coords = [it for it in items if not _has_coords(it)]

    if not with_coords:
        return _split_by_day(items, days)

    # Start from highest-rated place (best place first thing in the morning)
    start = max(with_coords, key=lambda it: float(it.get("rating") or 0))
    start_idx = with_coords.index(start)
    remaining = with_coords[:start_idx] + with_coords[start_idx + 1 :]
    ordered = [start]

    while remaining:
        last = ordered[-1]
        last_pos = (last["lat"], last["lng"])
        nxt = min(
            remaining,
            key=lambda it: _haversine_km(last_pos, (it["lat"], it["lng"])),
        )
        ordered.append(nxt)
        remaining.remove(nxt)

    # Re-distribute items without coords to keep day sizes balanced
    day_chunks = _split_by_day(ordered, days)
    for extra in without_coords:
        day_chunks.sort(key=len)
        day_chunks[0].append(extra)

    return day_chunks


def revise_for_budget(
    day_chunks: list[list[dict]],
    hotel_cost: int,
    people: int,
    budget: int,
) -> tuple[list[list[dict]], list[str]]:
    """
    If total > budget, drop the lowest benefit/cost items first until
    total <= budget OR nothing more can be cut.
    Returns (revised_chunks, list_of_removed_items).
    """
    if budget <= 0 or hotel_cost <= 0:
        return day_chunks, []

    # Build flat list of removable items (everything except hotel)
    flat: list[tuple[int, int, dict]] = []  # (day_idx, item_idx, item)
    for di, day in enumerate(day_chunks):
        for ii, item in enumerate(day):
            flat.append((di, ii, item))

    # Try to keep at least 2 items per day, prefer keeping hotel markers
    # (any item with type=="hotel" is treated as anchor)
    def current_total() -> int:
        subtotal = hotel_cost
        for _, _, it in flat:
            subtotal += int(it.get("estimatedCost") or 0) * people
        backup = round(subtotal * 0.1 / 10_000) * 10_000
        return subtotal + backup

    removed: list[str] = []
    while current_total() > budget:
        # Candidates: items we can drop without emptying a day
        candidates = [
            (di, ii, it)
            for di, ii, it in flat
            if len(day_chunks[di]) > 2 and it.get("type") != "hotel"
        ]
        if not candidates:
            break
        # Lowest benefit/cost first
        candidates.sort(key=lambda t: _score_item(t[2]))
        di, ii, it = candidates[0]
        removed.append(it.get("name", "điểm"))
        day_chunks[di].pop(ii)
        flat = [(d, i, x) for d, i, x in flat if not (d == di and i == ii)]
        # Reindex
        flat = []
        for d, day in enumerate(day_chunks):
            for i, x in enumerate(day):
                flat.append((d, i, x))

    return day_chunks, removed


def attach_travel_times(items_or_days, leg_minutes: list[int]) -> None:
    """
    Set travelTimeFromPrevious on each item from a precomputed legs list.
    Mutates items in place.

    Accepts either:
      - list[dict]: a single day's items (caller passes one day at a time)
      - list[list[dict]]: day_chunks
    """
    # Detect shape: items[0] is a dict (item) → single day; else nested list
    if not items_or_days:
        return
    first = items_or_days[0]
    if isinstance(first, list):
        # day_chunks form
        for day in items_or_days:
            _apply_legs(day, leg_minutes)
    else:
        # single day form
        _apply_legs(items_or_days, leg_minutes)


def _apply_legs(day: list[dict], leg_minutes: list[int]) -> None:
    for j, item in enumerate(day):
        if j == 0:
            continue
        idx = j - 1
        if idx < len(leg_minutes):
            item["travelTimeFromPrevious"] = f"{leg_minutes[idx]} phút"


def parse_duration_days(duration: str) -> int:
    """Returns number of day-rows (nights + 1)."""
    return _parse_nights(duration) + 1
