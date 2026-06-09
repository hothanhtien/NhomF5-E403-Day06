from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, desc, delete
from database import get_db
from models import TravelPlan

router = APIRouter()


# ── List plans (paginated) ─────────────────────────────────────────────────

@router.get("/plans")
async def list_plans(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    destination: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    offset = (page - 1) * limit
    q = select(TravelPlan).order_by(desc(TravelPlan.created_at))
    count_q = select(func.count()).select_from(TravelPlan)

    if destination:
        q = q.where(TravelPlan.destination.ilike(f"%{destination}%"))
        count_q = count_q.where(TravelPlan.destination.ilike(f"%{destination}%"))

    total = (await db.execute(count_q)).scalar_one()
    result = await db.execute(q.offset(offset).limit(limit))
    plans = result.scalars().all()

    return {
        "total": total,
        "page": page,
        "limit": limit,
        "items": [_plan_summary(p) for p in plans],
    }


# ── Get single plan ────────────────────────────────────────────────────────

@router.get("/plans/{plan_id}")
async def get_plan(plan_id: str, db: AsyncSession = Depends(get_db)):
    plan = await _get_or_404(plan_id, db)
    return _plan_detail(plan)


# ── Delete plan ────────────────────────────────────────────────────────────

@router.delete("/plans/{plan_id}")
async def delete_plan(plan_id: str, db: AsyncSession = Depends(get_db)):
    await _get_or_404(plan_id, db)
    await db.execute(delete(TravelPlan).where(TravelPlan.id == plan_id))
    await db.commit()
    return {"deleted": plan_id}


# ── Dashboard stats ────────────────────────────────────────────────────────

@router.get("/dashboard/stats")
async def dashboard_stats(db: AsyncSession = Depends(get_db)):
    total_plans = (await db.execute(select(func.count()).select_from(TravelPlan))).scalar_one()

    if total_plans == 0:
        return _empty_stats()

    avg_budget = (await db.execute(
        select(func.avg(TravelPlan.budget)).where(TravelPlan.budget > 0)
    )).scalar_one() or 0

    avg_cost = (await db.execute(
        select(func.avg(TravelPlan.total_cost)).where(TravelPlan.total_cost > 0)
    )).scalar_one() or 0

    total_people = (await db.execute(
        select(func.sum(TravelPlan.people))
    )).scalar_one() or 0

    within_budget_count = (await db.execute(
        select(func.count()).select_from(TravelPlan).where(TravelPlan.within_budget == True)
    )).scalar_one()

    # Top 8 destinations
    top_dest_rows = (await db.execute(
        select(TravelPlan.destination, func.count().label("cnt"))
        .group_by(TravelPlan.destination)
        .order_by(desc("cnt"))
        .limit(8)
    )).all()

    # Plans per day (last 30 days)
    daily_rows = (await db.execute(
        select(
            func.date(TravelPlan.created_at).label("day"),
            func.count().label("cnt"),
        )
        .group_by("day")
        .order_by("day")
        .limit(30)
    )).all()

    # Unique destinations count
    unique_destinations = (await db.execute(
        select(func.count(func.distinct(TravelPlan.destination)))
    )).scalar_one()

    # Recent 5 plans
    recent_rows = (await db.execute(
        select(TravelPlan).order_by(desc(TravelPlan.created_at)).limit(5)
    )).scalars().all()

    return {
        "totalPlans": total_plans,
        "uniqueDestinations": unique_destinations,
        "totalPeople": int(total_people),
        "avgBudget": int(avg_budget),
        "avgCost": int(avg_cost),
        "withinBudgetCount": within_budget_count,
        "overBudgetCount": total_plans - within_budget_count,
        "withinBudgetRate": round(within_budget_count / total_plans * 100, 1) if total_plans else 0,
        "topDestinations": [{"name": r.destination, "count": r.cnt} for r in top_dest_rows],
        "dailyPlans": [{"day": str(r.day), "count": r.cnt} for r in daily_rows],
        "recentPlans": [_plan_summary(p) for p in recent_rows],
    }


# ── Helpers ────────────────────────────────────────────────────────────────

async def _get_or_404(plan_id: str, db: AsyncSession) -> TravelPlan:
    result = await db.execute(select(TravelPlan).where(TravelPlan.id == plan_id))
    plan = result.scalar_one_or_none()
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    return plan


def _plan_summary(p: TravelPlan) -> dict:
    return {
        "id": p.id,
        "destination": p.destination,
        "duration": p.intent.get("duration", ""),
        "durationDays": p.duration_days,
        "budget": p.budget,
        "totalCost": p.total_cost,
        "people": p.people,
        "withinBudget": p.within_budget,
        "preferences": p.preferences or [],
        "prompt": p.prompt,
        "createdAt": p.created_at.isoformat() if p.created_at else None,
    }


def _plan_detail(p: TravelPlan) -> dict:
    return {
        **_plan_summary(p),
        "intent": p.intent,
        "itinerary": p.itinerary,
        "budgetSummary": p.budget_summary,
        "mapData": p.map_data,
        "warnings": p.warnings,
        "optionalPlaces": p.optional_places,
    }


def _empty_stats() -> dict:
    return {
        "totalPlans": 0,
        "uniqueDestinations": 0,
        "totalPeople": 0,
        "avgBudget": 0,
        "avgCost": 0,
        "withinBudgetCount": 0,
        "overBudgetCount": 0,
        "withinBudgetRate": 0,
        "topDestinations": [],
        "dailyPlans": [],
        "recentPlans": [],
    }
