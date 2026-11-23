"""两档（或多档）分段的横向比对。

三类问题分别标出：
- boundary_mismatch：同一源时刻两档切点对不上（按源帧坐标比较，容差为一帧）；
- missing_segment：某档在一段源时间范围内没有任何分段覆盖；
- unreadable：索引写了分段，但文件缺失或 ffprobe 打不开。
另外给出每个共享边界上两档实际首帧的画面编号（src 片/帧号），
编号不同意味着“从错误的画面接下去”。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .ffmpeg_utils import FFprobeError, probe


@dataclass
class BoundaryRow:
    source_time: float
    per_tier_frame_label: dict[str, str | None]  # None 表示该档此处没有边界
    aligned: bool


@dataclass
class CompareIssue:
    kind: str  # boundary_mismatch | missing_segment | unreadable
    tier: str | None
    detail: str
    source_start: float | None = None
    source_end: float | None = None
    seq: int | None = None


@dataclass
class CompareReport:
    tier_names: list[str]
    boundaries: list[BoundaryRow] = field(default_factory=list)
    issues: list[CompareIssue] = field(default_factory=list)
    coverage: dict[str, list[tuple[float, float]]] = field(default_factory=dict)

    @property
    def has_issues(self) -> bool:
        return bool(self.issues)

    def to_dict(self) -> dict:
        return {
            "tier_names": self.tier_names,
            "has_issues": self.has_issues,
            "boundaries": [b.__dict__ for b in self.boundaries],
            "issues": [i.__dict__ for i in self.issues],
            "coverage": {k: [list(x) for x in v] for k, v in self.coverage.items()},
        }


def _readable(root: Path, rel: str) -> bool:
    path = root / rel
    if not path.is_file():
        return False
    try:
        probe(path)
        return True
    except FFprobeError:
        return False


def compare_tiers(workspace: str | Path, manifest: dict) -> CompareReport:
    root = Path(workspace)
    tiers = manifest.get("tiers", [])
    names = [t["name"] for t in tiers]
    fps = float(manifest.get("source_fps", 30))
    tol = 1.5 / fps
    total = float(manifest.get("source_duration", 0.0))
    report = CompareReport(tier_names=names)

    # 1) 打不开 / 缺失（索引写了但文件不可读）
    readable_segments: dict[str, list[dict]] = {}
    for tier in tiers:
        good: list[dict] = []
        for seg in tier.get("segments", []):
            if not seg.get("openable", True):
                report.issues.append(CompareIssue(
                    kind="unreadable", tier=tier["name"], seq=seg["seq"],
                    detail=f"索引记录打开失败：{seg.get('error', '未知错误')}",
                    source_start=seg["source_start"], source_end=seg["source_end"],
                ))
                continue
            if not _readable(root, seg["file"]):
                report.issues.append(CompareIssue(
                    kind="unreadable", tier=tier["name"], seq=seg["seq"],
                    detail=f"文件缺失或无法解码：{seg['file']}",
                    source_start=seg["source_start"], source_end=seg["source_end"],
                ))
                continue
            good.append(seg)
        readable_segments[tier["name"]] = good
        report.coverage[tier["name"]] = [(s["source_start"], s["source_end"]) for s in good]

    # 2) 覆盖空洞：可读分段合起来没有覆盖到的源时间范围
    for name, segs in readable_segments.items():
        cursor = 0.0
        for seg in sorted(segs, key=lambda s: s["source_start"]):
            if seg["source_start"] - cursor > tol:
                report.issues.append(CompareIssue(
                    kind="missing_segment", tier=name,
                    detail=f"{cursor:.3f}s–{seg['source_start']:.3f}s 没有分段覆盖",
                    source_start=cursor, source_end=seg["source_start"],
                ))
            cursor = max(cursor, seg["source_end"])
        if total - cursor > tol:
            report.issues.append(CompareIssue(
                kind="missing_segment", tier=name,
                detail=f"{cursor:.3f}s–{total:.3f}s（片尾）没有分段覆盖",
                source_start=cursor, source_end=total,
            ))

    # 3) 边界对齐：收集每档内部边界（不含 0 与总时长端点），按时间聚类
    boundary_map: dict[float, dict[str, str]] = {}
    for tier in tiers:
        for seg in tier.get("segments", []):
            t = float(seg["source_start"])
            if t <= tol:
                continue
            boundary_map.setdefault(t, {})[tier["name"]] = seg.get("frame_label", "?")

    clustered: list[dict] = []
    for t in sorted(boundary_map):
        if clustered and abs(t - clustered[-1]["time"]) <= tol:
            clustered[-1]["labels"].update(boundary_map[t])
        else:
            clustered.append({"time": t, "labels": dict(boundary_map[t])})

    for cluster in clustered:
        t = cluster["time"]
        row = BoundaryRow(
            source_time=t,
            per_tier_frame_label={name: cluster["labels"].get(name) for name in names},
            aligned=all(name in cluster["labels"] for name in names),
        )
        report.boundaries.append(row)
        if not row.aligned:
            missing = [n for n in names if n not in cluster["labels"]]
            report.issues.append(CompareIssue(
                kind="boundary_mismatch",
                tier=None,
                detail=(
                    f"源时间 {t:.3f}s 处只有 {sorted(cluster['labels'])} 存在边界，"
                    f"{missing} 缺少对应切点——这些时刻无法保证换档接对画面"
                ),
                source_start=t,
            ))
        else:
            # 边界两边都有：画面编号（src片/帧号）必须指向同一源帧
            labels = set(cluster["labels"].values())
            if len(labels) > 1:
                report.issues.append(CompareIssue(
                    kind="boundary_mismatch",
                    tier=None,
                    detail=f"源时间 {t:.3f}s 两档实际首帧不一致: {cluster['labels']}",
                    source_start=t,
                ))
    return report
