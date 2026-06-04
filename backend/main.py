from contextlib import asynccontextmanager
from fastapi import FastAPI, Query, HTTPException
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from database import engine, Base
from routers import chat, plans
from tools.places import fetch_photo_bytes


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Add new columns if they don't exist (safe to run multiple times)
        migrations = [
            "ALTER TABLE travel_plans ADD COLUMN IF NOT EXISTS destination VARCHAR(200) NOT NULL DEFAULT ''",
            "ALTER TABLE travel_plans ADD COLUMN IF NOT EXISTS budget INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE travel_plans ADD COLUMN IF NOT EXISTS people INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE travel_plans ADD COLUMN IF NOT EXISTS duration_days INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE travel_plans ADD COLUMN IF NOT EXISTS within_budget BOOLEAN NOT NULL DEFAULT TRUE",
            "ALTER TABLE travel_plans ADD COLUMN IF NOT EXISTS total_cost INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE travel_plans ADD COLUMN IF NOT EXISTS prompt TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE travel_plans ADD COLUMN IF NOT EXISTS preferences JSON DEFAULT '[]'",
            "CREATE INDEX IF NOT EXISTS ix_travel_plans_destination ON travel_plans (destination)",
            "CREATE INDEX IF NOT EXISTS ix_travel_plans_created_at ON travel_plans (created_at)",
        ]
        for sql in migrations:
            await conn.execute(__import__("sqlalchemy").text(sql))
        # Backfill denormalized columns from intent JSON for existing rows
        await conn.execute(__import__("sqlalchemy").text("""
            UPDATE travel_plans SET
                destination  = COALESCE(intent->>'destination', ''),
                budget       = COALESCE((intent->>'budget')::int, 0),
                people       = COALESCE((intent->>'people')::int, 1),
                within_budget = COALESCE((budget_summary->>'withinBudget')::boolean, true),
                total_cost   = COALESCE((budget_summary->>'total')::int, 0),
                preferences  = COALESCE(intent->'preferences', '[]'::json)
            WHERE destination = ''
        """))
    yield


app = FastAPI(title="AI Travel Planner", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat.router, prefix="/api")
app.include_router(plans.router, prefix="/api")


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/config")
def get_config():
    """Return public client-side config (Mapbox token is public-safe)."""
    import os
    return {"mapboxToken": os.environ.get("MAPBOX_ACCESS_TOKEN", "")}


@app.get("/api/photo")
async def proxy_photo(ref: str = Query(..., description="Google Places photo_reference")):
    """Proxy Google Places photo so the API key never leaves the server."""
    try:
        data = await fetch_photo_bytes(ref)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Photo fetch failed: {exc}")
    return Response(content=data, media_type="image/jpeg")
