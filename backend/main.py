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
