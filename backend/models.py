from datetime import datetime
from sqlalchemy import String, JSON, DateTime, func
from sqlalchemy.orm import Mapped, mapped_column
from database import Base
import uuid


class TravelPlan(Base):
    __tablename__ = "travel_plans"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    intent: Mapped[dict] = mapped_column(JSON, nullable=False)
    itinerary: Mapped[list] = mapped_column(JSON, nullable=False)
    budget_summary: Mapped[dict] = mapped_column(JSON, nullable=False)
    map_data: Mapped[dict] = mapped_column(JSON, nullable=False)
    warnings: Mapped[list] = mapped_column(JSON, default=list)
    optional_places: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
