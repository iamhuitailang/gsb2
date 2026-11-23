"""按切分点配置生成两档分段，并写出可信索引。

关键原则：
- 切分点先吸附到最近的源帧（切点必须落在帧边界上）；
- 每个分段实际重编码后再 ffprobe 回读时长、抽首帧、算像素哈希——
  索引里记录的是“实测事实”，不是生成时的估计值；
- 音频不进各档分段，单独导出一条连续 master 音轨，预览只从这一条出声。
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from . import SCHEMA
from .ffmpeg_utils import (
    FFprobeError,
    cut_segments,
    extract_audio,
    first_frame_hash,
    first_frame_png,
    probe,
)
from .sources import Timeline, build_timeline


@dataclass
class TierConfig:
    name: str
    width: int
    height: int
    cutpoints: list[float]  # 该档可用的切分点（全局源秒），吸附到帧后生效


@dataclass
class SegmentRecord:
    seq: int
    file: str  # 相对工作区路径
    source_start: float  # 全局源时间起点（吸附后）
    source_end: float
    planned_duration: float  # 请求时长
    actual_duration: float  # ffprobe 实测
    start_clip_index: int  # 实际首帧所在源片（0 基）
    start_frame_index: int  # 实际首帧在源片内的帧号
    frame_label: str  # 如 src1/f000
    global_frame: int  # 全局连续帧号
    first_frame_hash: str | None  # 同档重核验用
    thumb: str | None
    openable: bool = True
    error: str | None = None


@dataclass
class TierRecord:
    name: str
    width: int
    height: int
    fps: float
    cutpoints_effective: list[float]
    segments: list[SegmentRecord] = field(default_factory=list)


@dataclass
class Manifest:
    schema_version: str
    created_at: float
    source_dir: str
    source_fps: float
    source_duration: float
    sources: list[dict]
    tiers: list[TierRecord]
    audio_track: str | None
    markers: dict

    def to_dict(self) -> dict:
        return {
            "schema_version": self.schema_version,
            "created_at": self.created_at,
            "source_dir": self.source_dir,
            "source_fps": self.source_fps,
            "source_duration": self.source_duration,
            "sources": self.sources,
            "tiers": [
                {
                    "name": t.name,
                    "width": t.width,
                    "height": t.height,
                    "fps": t.fps,
                    "cutpoints_effective": t.cutpoints_effective,
                    "segments": [asdict(s) for s in t.segments],
                }
                for t in self.tiers
            ],
            "audio_track": self.audio_track,
            "markers": self.markers,
        }

    def save(self, workspace: Path) -> Path:
        path = workspace / "manifest.json"
        path.write_text(json.dumps(self.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
        return path


def load_manifest(workspace: str | Path) -> dict:
    path = Path(workspace) / "manifest.json"
    if not path.is_file():
        raise FileNotFoundError(f"{path} 不存在，先用 build 生成")
    return json.loads(path.read_text(encoding="utf-8"))


def snap_cutpoints(raw: list[float], timeline: Timeline) -> list[float]:
    """切分点吸附到最近源帧边界，并补齐 0 与总时长、去重排序。"""
    fps = timeline.fps
    snapped = {0.0, round(timeline.duration * fps) / fps}
    for t in raw:
        t = max(0.0, min(float(t), timeline.duration))
        snapped.add(round(t * fps) / fps)
    return sorted(snapped)


def _intervals(points: list[float]) -> list[tuple[float, float]]:
    return [(a, b) for a, b in zip(points, points[1:]) if b - a > 1e-6]


def _interval_source_specs(timeline: Timeline, start: float, end: float) -> list[tuple[str, float, float]]:
    """把一个全局源区间翻译成 ffmpeg 的 (源文件, 源内起点, 时长) 列表。"""
    specs: list[tuple[str, float, float]] = []
    cursor = start
    for clip in timeline.clips:
        if clip.end <= cursor:
            continue
        if clip.offset >= end:
            break
        seg_start = max(cursor, clip.offset) - clip.offset
        seg_end = min(end, clip.end) - clip.offset
        if seg_end - seg_start > 1e-6:
            specs.append((str(clip.path), seg_start, seg_end - seg_start))
    return specs


def build_tier(
    tier: TierConfig,
    timeline: Timeline,
    workspace: Path,
    thumb_dir: Path,
) -> TierRecord:
    tier_dir = workspace / tier.name
    tier_dir.mkdir(parents=True, exist_ok=True)
    points = snap_cutpoints(tier.cutpoints, timeline)
    record = TierRecord(
        name=tier.name,
        width=tier.width,
        height=tier.height,
        fps=timeline.fps,
        cutpoints_effective=points,
    )
    for seq, (start, end) in enumerate(_intervals(points)):
        file_name = f"seg_{seq:03d}.mp4"
        out = tier_dir / file_name
        specs = _interval_source_specs(timeline, start, end)
        cut_segments(specs, out, tier.width, tier.height, timeline.fps)

        clip_idx, frame_no, _ = timeline.locate(start)
        thumb_rel = f"thumbs/{tier.name}_seg_{seq:03d}.png"
        first_frame_png(out, workspace / thumb_rel)
        try:
            info = probe(out)
            digest = first_frame_hash(out)
            seg = SegmentRecord(
                seq=seq,
                file=f"{tier.name}/{file_name}",
                source_start=start,
                source_end=end,
                planned_duration=end - start,
                actual_duration=info.duration,
                start_clip_index=clip_idx,
                start_frame_index=frame_no,
                frame_label=timeline.frame_label(start),
                global_frame=timeline.global_frame_index(start),
                first_frame_hash=digest,
                thumb=thumb_rel,
            )
        except FFprobeError as exc:  # 实测打不开也要落索引，交给 compare/verify 标红
            seg = SegmentRecord(
                seq=seq,
                file=f"{tier.name}/{file_name}",
                source_start=start,
                source_end=end,
                planned_duration=end - start,
                actual_duration=0.0,
                start_clip_index=clip_idx,
                start_frame_index=frame_no,
                frame_label=timeline.frame_label(start),
                global_frame=timeline.global_frame_index(start),
                first_frame_hash=None,
                thumb=None,
                openable=False,
                error=str(exc),
            )
        record.segments.append(seg)
    return record


def build_workspace(
    src_dir: str | Path,
    workspace: str | Path,
    tiers: list[TierConfig],
    markers: dict | None = None,
) -> Manifest:
    """完整构建：探测源片 → 两档分段 → 连续音轨 → manifest 落盘。"""
    workspace = Path(workspace)
    (workspace / "thumbs").mkdir(parents=True, exist_ok=True)
    timeline = build_timeline(src_dir)

    tier_records = [build_tier(tier, timeline, workspace, workspace / "thumbs") for tier in tiers]

    # 一条覆盖全片的连续音轨：所有档位共用，切换画面不切声音
    audio_rel: str | None = None
    if any(c.info.has_audio for c in timeline.clips):
        audio_path = workspace / "audio" / "master.m4a"
        audio_path.parent.mkdir(parents=True, exist_ok=True)
        full_specs = _interval_source_specs(timeline, 0.0, timeline.duration)
        extract_audio(full_specs, audio_path)
        audio_rel = "audio/master.m4a"

    manifest = Manifest(
        schema_version=SCHEMA,
        created_at=time.time(),
        source_dir=str(Path(src_dir).resolve()),
        source_fps=timeline.fps,
        source_duration=timeline.duration,
        sources=[
            {
                "index": c.index,
                "path": str(c.path),
                "offset": c.offset,
                "duration": c.info.duration,
                "frame_count": c.frame_count,
                "has_audio": c.info.has_audio,
            }
            for c in timeline.clips
        ],
        tiers=tier_records,
        audio_track=audio_rel,
        markers=markers or {"beats": [], "fps": timeline.fps},
    )
    manifest.save(workspace)
    return manifest
