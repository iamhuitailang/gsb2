"""时间表的二次编辑: 重开后只改某段, 原片与原始轨迹不动。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .ffmpegutil import dump_json


def list_segments(schedule: dict[str, Any]) -> list[dict[str, Any]]:
    return schedule.get("segments", [])


def list_overrides(schedule: dict[str, Any]) -> list[dict[str, Any]]:
    return schedule.get("overrides", [])


def add_override(
    schedule: dict[str, Any],
    start: float,
    end: float,
    center_x_norm: float,
    name: str = "manual",
) -> dict[str, Any]:
    """在 [start, end) 区间插入人工取景点 (归一化中心 x)。"""
    if not (0.0 <= center_x_norm <= 1.0):
        raise ValueError("center_x_norm 必须在 0..1 之间")
    if end <= start:
        raise ValueError("end 必须大于 start")
    ov = {"start": float(start), "end": float(end),
          "center_x_norm": float(center_x_norm), "name": str(name)}
    overrides = [o for o in schedule.get("overrides", [])
                 if not (o["start"] < end and start < o["end"])]  # 去掉重叠段
    overrides.append(ov)
    schedule["overrides"] = sorted(overrides, key=lambda o: o["start"])
    return ov


def remove_override(schedule: dict[str, Any], name: str) -> int:
    before = len(schedule.get("overrides", []))
    schedule["overrides"] = [o for o in schedule.get("overrides", []) if o.get("name") != name]
    return before - len(schedule["overrides"])


def update_motion(schedule: dict[str, Any], **params: Any) -> dict[str, Any]:
    motion = dict(schedule.get("motion", {}))
    motion.update({k: v for k, v in params.items() if v is not None})
    schedule["motion"] = motion
    return motion


def save_schedule(schedule: dict[str, Any], path: str | Path) -> None:
    dump_json(schedule, path)
