"""FastAPI application entry point."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import router
from .config import RULES_VERSION, SUPPORTED_SCHEMA_VERSIONS
from .database import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Game Event Replay Analytics", version="1.0.0", lifespan=lifespan)

# Local dev: Vite dev server runs on a different port.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "rules_version": RULES_VERSION,
        "supported_schema_versions": sorted(SUPPORTED_SCHEMA_VERSIONS),
    }


app.include_router(router)
