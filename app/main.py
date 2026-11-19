"""HTTP API and static page serving."""
from __future__ import annotations

import os
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import service
from .db import init_db, reset_db

app = FastAPI(title="Temperature Probe Batch Service", version="1.0")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
SAMPLES_DIR = os.path.join(os.path.dirname(__file__), "..", "samples")


class BatchRequest(BaseModel):
    records: list[dict[str, Any]]
    note: Optional[str] = None


class RecomputeRequest(BaseModel):
    device_id: str
    start: str = Field(description="ISO-8601 instant, range start (inclusive)")
    end: str = Field(description="ISO-8601 instant, range end (exclusive)")


@app.on_event("startup")
def _startup() -> None:
    init_db()


@app.post("/api/batches")
def post_batch(req: BatchRequest) -> dict:
    if not req.records:
        raise HTTPException(status_code=400, detail="records must not be empty")
    return service.ingest_batch(req.records, req.note)


@app.get("/api/batches")
def get_batches() -> list[dict]:
    return service.list_batches()


@app.get("/api/batches/{batch_id}")
def get_batch(batch_id: int) -> dict:
    batch = service.get_batch(batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="batch not found")
    return batch


@app.get("/api/devices")
def get_devices() -> list[str]:
    return service.list_devices()


@app.get("/api/devices/{device_id}/windows")
def get_device_windows(device_id: str, start: Optional[str] = None,
                       end: Optional[str] = None) -> list[dict]:
    try:
        start_dt = service.parse_instant(start) if start else None
        end_dt = service.parse_instant(end) if end else None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if start_dt and end_dt and end_dt <= start_dt:
        raise HTTPException(status_code=400, detail="end must be after start")
    return service.get_windows(device_id, start_dt, end_dt)


@app.get("/api/devices/{device_id}/readings")
def get_window_readings(device_id: str, window_start: str) -> dict:
    try:
        instant = service.parse_instant(window_start)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    w = service.window_iso(instant)
    return {
        "device_id": device_id,
        "window_start": w,
        "readings": service.get_window_readings(device_id, w),
    }


@app.get("/api/readings/{device_id}/{reading_id}/history")
def get_reading_history(device_id: str, reading_id: str) -> dict:
    return service.get_reading_history(device_id, reading_id)


@app.post("/api/recompute")
def post_recompute(req: RecomputeRequest) -> dict:
    try:
        start_dt = service.parse_instant(req.start)
        end_dt = service.parse_instant(req.end)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if end_dt <= start_dt:
        raise HTTPException(status_code=400, detail="end must be after start")
    return service.recompute_device_range(req.device_id, start_dt, end_dt)


@app.get("/api/recompute")
def get_recompute_jobs() -> list[dict]:
    return service.list_recompute_jobs()


@app.get("/api/recompute/{job_id}")
def get_recompute_job(job_id: int) -> dict:
    job = service.get_recompute_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job


@app.post("/api/admin/reset")
def post_reset() -> dict:
    reset_db()
    init_db()
    return {"status": "reset"}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/api/samples")
def list_samples() -> list[str]:
    if not os.path.isdir(SAMPLES_DIR):
        return []
    return sorted(f for f in os.listdir(SAMPLES_DIR) if f.endswith(".json"))


@app.get("/api/samples/{name}")
def get_sample(name: str) -> FileResponse:
    # Keep the hand on the door: only bare filenames inside SAMPLES_DIR.
    if "/" in name or "\\" in name or ".." in name or not name.endswith(".json"):
        raise HTTPException(status_code=400, detail="bad sample name")
    path = os.path.join(SAMPLES_DIR, name)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="sample not found")
    return FileResponse(path, media_type="application/json")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
