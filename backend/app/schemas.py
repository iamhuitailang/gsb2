"""Request and response schemas for the API."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class AnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    peer: str = Field(default="", description="连接对端地址，可带端口")
    headers: dict[str, Any] = Field(
        default_factory=dict,
        description="转发字段，键为字段名或标准请求头名，值为字符串或字符串列表",
    )
    config: dict[str, Any] = Field(description="本次判定使用的信任配置")
    save: bool = True
    source: str = "manual"
    demo_slug: str | None = None


class ConfigSaveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    config: dict[str, Any]
    config_id: int | None = None


class DemoRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    save: bool = True
