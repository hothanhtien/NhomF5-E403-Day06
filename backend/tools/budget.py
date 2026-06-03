import re

PRICE_LEVEL_COST = {
    "PRICE_LEVEL_FREE": 0,
    "PRICE_LEVEL_INEXPENSIVE": 80_000,
    "PRICE_LEVEL_MODERATE": 150_000,
    "PRICE_LEVEL_EXPENSIVE": 300_000,
    "PRICE_LEVEL_VERY_EXPENSIVE": 600_000,
    "PRICE_LEVEL_UNSPECIFIED": 100_000,
}

HOTEL_COST_PER_NIGHT = {
    "PRICE_LEVEL_FREE": 0,
    "PRICE_LEVEL_INEXPENSIVE": 400_000,
    "PRICE_LEVEL_MODERATE": 800_000,
    "PRICE_LEVEL_EXPENSIVE": 1_500_000,
    "PRICE_LEVEL_VERY_EXPENSIVE": 3_000_000,
    "PRICE_LEVEL_UNSPECIFIED": 700_000,
}


def estimate_budget(intent: dict, itinerary: list[dict], hotel: dict) -> dict:
    """
    Returns budgetSummary dict.
    intent must have: budget (int), people (int), duration (str)
    Hotel cost is per room per night (not multiplied by people).
    """
    people = intent.get("people", 2)
    nights = _parse_nights(intent.get("duration", "2 đêm"))

    # Hotel cost: per room per night (not per person)
    hotel_price = HOTEL_COST_PER_NIGHT.get(
        hotel.get("priceLevel", "PRICE_LEVEL_UNSPECIFIED"), 700_000
    )
    hotel_total = hotel_price * nights

    # Food + cafe from itinerary items (estimatedCost is per person)
    food_total = 0
    cafe_total = 0
    ticket_total = 0
    transport_total = 0

    for day in itinerary:
        for item in day.get("items", []):
            cost = item.get("estimatedCost", 0) * people
            category = item.get("type", "")
            if category == "cafe":
                cafe_total += cost
            elif category in ("restaurant", "food"):
                food_total += cost
            elif category in ("attraction", "check-in"):
                ticket_total += cost
            elif category == "transport":
                transport_total += cost

    # Fallback transport estimate: 200k/person/day
    if transport_total == 0:
        days = nights + 1
        transport_total = 200_000 * people * days

    subtotal = hotel_total + food_total + cafe_total + ticket_total + transport_total
    backup = round(subtotal * 0.1 / 10_000) * 10_000
    total = subtotal + backup
    budget = intent.get("budget", 0)

    return {
        "hotel": hotel_total,
        "food": food_total,
        "cafe": cafe_total,
        "tickets": ticket_total,
        "transport": transport_total,
        "backup": backup,
        "total": total,
        "withinBudget": total <= budget,
        "budgetGap": max(0, total - budget),
    }


def validate_itinerary(intent: dict, itinerary: list[dict], budget_summary: dict) -> list[str]:
    """Returns list of warning strings. Empty list = valid."""
    warnings = []

    if not budget_summary["withinBudget"]:
        gap = budget_summary["budgetGap"]
        warnings.append(f"Vượt ngân sách {gap:,} VND. Cân nhắc bỏ bớt điểm có phí hoặc chọn khách sạn rẻ hơn.")

    for day in itinerary:
        items = day.get("items", [])
        if len(items) > 6:
            day_num = day.get("day", "?")
            warnings.append(f"Ngày {day_num} có {len(items)} điểm — có thể quá dày. Nên <= 6 điểm/ngày.")

    return warnings


def _parse_nights(duration: str) -> int:
    """Parse '3 ngày 2 đêm' → 2. Returns 2 as default for unrecognised formats."""
    m = re.search(r"(\d+)\s*đêm", duration)
    if m:
        return int(m.group(1))
    m = re.search(r"(\d+)\s*ngày", duration)
    if m:
        return max(1, int(m.group(1)) - 1)
    return 2
