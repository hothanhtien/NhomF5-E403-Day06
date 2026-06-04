from datetime import datetime
from sqlalchemy import String, JSON, DateTime, Integer, Boolean, Text, func, Index
from sqlalchemy.orm import Mapped, mapped_column
from database import Base
import uuid


class TravelPlan(Base):
    __tablename__ = "travel_plans"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))

    # Denormalized for fast dashboard queries
    destination: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    budget: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    people: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    duration_days: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    within_budget: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    total_cost: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    prompt: Mapped[str] = mapped_column(Text, nullable=False, default="")

    # Full data
    intent: Mapped[dict] = mapped_column(JSON, nullable=False)
    itinerary: Mapped[list] = mapped_column(JSON, nullable=False)
    budget_summary: Mapped[dict] = mapped_column(JSON, nullable=False)
    map_data: Mapped[dict] = mapped_column(JSON, nullable=False)
    warnings: Mapped[list] = mapped_column(JSON, default=list)
    optional_places: Mapped[list] = mapped_column(JSON, default=list)
    preferences: Mapped[list] = mapped_column(JSON, default=list)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        Index("ix_travel_plans_destination", "destination"),
        Index("ix_travel_plans_created_at", "created_at"),
    )
