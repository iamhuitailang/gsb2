"""关注框轨迹文件的读写与逐时刻插值。"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from .ffmpegutil import load_json, dump_json
from .model import Rect, SafeZone, Shot, Track


@dataclass
class TracksDoc:
    """tracks.json 的完整内容。"""

    source: str
    width: int
    height: int
    fps: float
    duration: float
    tracks: list[Track]
    shots: list[Shot]
    safe_zones: list[SafeZone]
    speakers: dict[str, list[list[float]]]      # track_id -> [[start,end],...]
    config: dict[str, Any]

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "TracksDoc":
        tracks = [Track.from_dict(t) for t in d["tracks"]]
        shots = [Shot.from_dict(s) for s in d.get("shots", [])]
        zones = [SafeZone.from_dict(z) for z in d.get("safe_zones", [])]
        speakers = {
            str(k): [[float(a), float(b)] for a, b in v]
            for k, v in d.get("speakers", {}).items()
        }
        cfg = d.get("config", {}) or {}
        return TracksDoc(
            source=str(d["source"]),
            width=int(d["width"]),
            height=int(d["height"]),
            fps=float(d["fps"]),
            duration=float(d["duration"]),
            tracks=tracks,
            shots=shots,
            safe_zones=zones,
            speakers=speakers,
            config=cfg,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": "reframer.tracks/v1",
            "source": self.source,
            "width": self.width,
            "height": self.height,
            "fps": self.fps,
            "duration": self.duration,
            "tracks": [t.to_dict() for t in self.tracks],
            "shots": [s.to_dict() for s in self.shots],
            "safe_zones": [z.to_dict() for z in self.safe_zones],
            "speakers": self.speakers,
            "config": self.config,
        }

    def track(self, track_id: str) -> Track:
        for t in self.tracks:
            if t.id == track_id:
                return t
        raise KeyError(f"轨迹里没有对象 {track_id!r}")


def load_tracks(path: str | Path) -> TracksDoc:
    return TracksDoc.from_dict(load_json(path))


def save_tracks(doc: TracksDoc, path: str | Path) -> None:
    dump_json(doc.to_dict(), path)


def rect_at(track: Track, t: float) -> Optional[Rect]:
    """t 时刻的关注框; 关键帧之间线性插值, null 区间返回 None。

    规则:
    - 两端之外取最近端点;
    - 相邻两帧任一为 null -> 该区间无数据;
    - 两帧均有框 -> 对 x/y/w/h 线性插值。
    """
    kfs = sorted(track.keyframes, key=lambda k: k.t)
    if not kfs:
        return None
    if t <= kfs[0].t:
        return kfs[0].rect
    if t >= kfs[-1].t:
        return kfs[-1].rect
    for a, b in zip(kfs, kfs[1:]):
        if a.t <= t < b.t:
            # null 关键帧表示从该时刻起框消失, 直到下一个关键帧时刻恢复
            if a.rect is None or b.rect is None:
                return None
            span = b.t - a.t
            p = 0.0 if span <= 0 else (t - a.t) / span
            return Rect(
                x=a.rect.x + (b.rect.x - a.rect.x) * p,
                y=a.rect.y + (b.rect.y - a.rect.y) * p,
                w=a.rect.w + (b.rect.w - a.rect.w) * p,
                h=a.rect.h + (b.rect.h - a.rect.h) * p,
            )
    return kfs[-1].rect


def is_speaking(track_id: str, speakers: dict[str, list[list[float]]], t: float) -> bool:
    for start, end in speakers.get(track_id, []):
        if start <= t < end:
            return True
    return False


def shot_at(shots: list[Shot], t: float) -> Optional[Shot]:
    for s in shots:
        if s.start <= t < s.end:
            return s
    return shots[-1] if shots else None
