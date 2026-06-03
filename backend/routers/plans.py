from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from database import get_db
from models import TravelPlan

router = APIRouter()


@router.get("/plans")
async def list_plans(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(TravelPlan).order_by(TravelPlan.created_at.desc()).limit(20)
    )
    plans = result.scalars().all()
    return [
        {
            "id": p.id,
            "destination": p.intent.get("destination"),
            "duration": p.intent.get("duration"),
            "createdAt": p.created_at.isoformat() if p.created_at else None,
        }
        for p in plans
    ]


@router.get("/plans/{plan_id}")
async def get_plan(plan_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(TravelPlan).where(TravelPlan.id == plan_id))
    plan = result.scalar_one_or_none()
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    return {
        "id": plan.id,
        "intent": plan.intent,
        "itinerary": plan.itinerary,
        "budgetSummary": plan.budget_summary,
        "mapData": plan.map_data,
        "warnings": plan.warnings,
        "optionalPlaces": plan.optional_places,
    }
