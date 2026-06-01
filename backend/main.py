from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Counter API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

COUNTER = {"value": 0}


@app.get("/api/count")
def get_count():
    return {"count": COUNTER["value"]}


@app.post("/api/increment")
def increment():
    COUNTER["value"] += 1
    return {"count": COUNTER["value"]}


@app.post("/api/decrement")
def decrement():
    COUNTER["value"] -= 1
    return {"count": COUNTER["value"]}


@app.post("/api/reset")
def reset():
    COUNTER["value"] = 0
    return {"count": COUNTER["value"]}
