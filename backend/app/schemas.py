"""Pydantic 请求/响应模型。"""
from __future__ import annotations

from pydantic import BaseModel, Field


class TaskCreate(BaseModel):
    file_id: str
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=1)
    format: str
    video_codec: str
    audio_codec: str
    crf: int | None = Field(default=None, ge=0, le=63)
    preset: str | None = None
    video_bitrate: str | None = None
    audio_bitrate: str | None = None


class CancelResponse(BaseModel):
    task_id: str
    canceled: bool
    message: str


class CleanupResponse(BaseModel):
    removed_temp: int
    freed_bytes: int
