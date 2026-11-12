"""Request/response Pydantic models.

The request model is deliberately permissive (extra fields kept, types loose)
because hard validation errors would reject a whole batch at once. Strict
per-event validation lives in the ingestion service so every event gets its
own acceptance/rejection verdict.
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class EventIn(BaseModel):
    event_id: str = Field(min_length=1, max_length=128)
    session_id: str = Field(min_length=1, max_length=128)
    player_id: str = Field(min_length=1, max_length=128)
    event_type: str = Field(min_length=1, max_length=64)
    occurred_at: str = Field(min_length=1, max_length=64)
    sequence: int
    schema_version: str = Field(min_length=1, max_length=16)
    payload: dict[str, Any]

    model_config = {"extra": "forbid"}


class ItemResult(BaseModel):
    event_id: str | None = None
    accepted: bool
    reason: str | None = None
    code: str


class BatchResponse(BaseModel):
    accepted: int
    rejected: int
    duplicate: int
    results: list[ItemResult]
    session_ids: list[str]
