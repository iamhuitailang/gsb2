"""换档可行性决策（纯函数，不接触 DOM/ffmpeg，便于单测）。

核心规则：
- 只有在“两档共享的分段边界”上才允许换档——档内没有共同切点时，
  目标档无法保证从同一源画面接下去；
- 当前点不是共享边界时，返回“继续旧档直到最近的共享边界才能换”；
- 目标档在候选边界之后缺段 / 文件不可读，则该候选不可换；
- 目标档边界首帧与当前档指向的源帧不是同一帧（frame_label 不同）即中止；
- 任何情况下都不允许目标档 seek 到比当前源位置更早的画面——
  那等于重播已经播过的画面，拒绝并记录原因。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

SwitchVerdict = Literal["switch_now", "wait", "abort"]


@dataclass
class Segment:
    """播放器视角的分段（从 manifest 投影而来，只保留决策需要的字段）。"""

    seq: int
    source_start: float
    source_end: float
    frame_label: str
    openable: bool
    file: str


@dataclass
class SwitchDecision:
    verdict: SwitchVerdict
    reason: str
    candidate_time: float | None = None          # 最近可换的源时间
    wait_seconds: float | None = None            # 距候选点还要继续旧档多久
    target_seq: int | None = None
    target_file: str | None = None
    target_frame_label: str | None = None
    replay_rejected: bool = False                # 是否因为“会重播旧画面”被拒

    def to_dict(self) -> dict:
        return self.__dict__


def _segments_of(manifest: dict, tier_name: str) -> list[Segment]:
    for tier in manifest["tiers"]:
        if tier["name"] == tier_name:
            return [
                Segment(
                    seq=s["seq"],
                    source_start=float(s["source_start"]),
                    source_end=float(s["source_end"]),
                    frame_label=s.get("frame_label", ""),
                    openable=bool(s.get("openable", True)),
                    file=s["file"],
                )
                for s in tier["segments"]
            ]
    raise KeyError(f"档位不存在: {tier_name}")


def _segment_at(segs: list[Segment], source_time: float, tol: float) -> Segment | None:
    for s in segs:
        if s.source_start - tol <= source_time < s.source_end - tol:
            return s
    # 时间正好落在段末端（= 下一段起点）时归到下一段；整片尾端夹取最后一段
    if segs and source_time >= segs[-1].source_end - tol:
        return segs[-1]
    return None


def _aligned_boundaries(a: list[Segment], b: list[Segment], tol: float) -> list[tuple[float, Segment, Segment]]:
    """两档在时间上对齐的所有边界（不要求首帧标签一致），返回 (时间, 当前段, 目标段)。"""
    out: list[tuple[float, Segment, Segment]] = []
    for s in a:
        for other in b:
            if abs(other.source_start - s.source_start) <= tol:
                out.append((s.source_start, s, other))
                break
    return sorted(out, key=lambda x: x[0])


def _shared_boundaries(a: list[Segment], b: list[Segment], tol: float) -> list[float]:
    """两档都存在、且首帧画面编号一致的安全边界时间。"""
    return [t for t, s, o in _aligned_boundaries(a, b, tol) if o.frame_label == s.frame_label]


def decide_switch(
    manifest: dict,
    from_tier: str,
    to_tier: str,
    source_time: float,
    tolerance: float | None = None,
) -> SwitchDecision:
    """决定在 source_time（全局源秒）能否从 from_tier 换到 to_tier。"""
    tol = tolerance if tolerance is not None else 1.5 / float(manifest["source_fps"])
    cur_segs = _segments_of(manifest, from_tier)
    dst_segs = _segments_of(manifest, to_tier)

    cur = _segment_at(cur_segs, source_time, tol)
    if cur is None:
        return SwitchDecision("abort", f"当前档 {from_tier} 在 {source_time:.3f}s 没有分段覆盖")

    dst = _segment_at(dst_segs, source_time, tol)
    aligned = _aligned_boundaries(cur_segs, dst_segs, tol)
    shared = [t for t, s, o in aligned if o.frame_label == s.frame_label]
    future_shared = [t for t in shared if t >= source_time - tol]

    # 时间上恰好落在一个对齐边界上：必须当场判定能否换，不能模糊地“等等看”
    on_aligned = next(((t, s, o) for t, s, o in aligned
                       if abs(source_time - t) <= tol), None)
    if on_aligned is not None:
        t_edge, cur_edge, dst_edge = on_aligned
        if dst_edge.frame_label != cur_edge.frame_label:
            return SwitchDecision(
                "abort",
                f"边界 {t_edge:.3f}s 两档实际首帧不一致："
                f"{cur_edge.frame_label} vs {dst_edge.frame_label}，继续旧档也无法在此接对",
            )
        if not dst_edge.openable:
            return SwitchDecision("abort", f"目标分段 {dst_edge.file} 不可读，无法切换")
        # 重播防护：边界切换从目标段“段头”开播。段头严格早于当前源位置
        # （哪怕只差一帧）就是把播过的画面重播，这里不复用对齐容差
        if dst_edge.source_start < source_time:
            return SwitchDecision(
                "abort",
                f"目标段起点 {dst_edge.source_start:.3f}s 早于当前 {source_time:.3f}s，"
                "切换会重播已经播过的画面，已拒绝",
                replay_rejected=True,
            )
        return SwitchDecision(
            "switch_now",
            f"共享边界 {t_edge:.3f}s，两档首帧同为 {dst_edge.frame_label}",
            candidate_time=t_edge,
            target_seq=dst_edge.seq,
            target_file=dst_edge.file,
            target_frame_label=dst_edge.frame_label,
        )

    # 不在边界：找最近的未来共享边界
    if not future_shared:
        return SwitchDecision(
            "abort",
            f"当前位置之后没有 {from_tier}↔{to_tier} 的共享边界，继续旧档也无法安全切换",
        )
    candidate = future_shared[0]
    candidate_dst = _segment_at(dst_segs, candidate, tol)
    if candidate_dst is None or not candidate_dst.openable:
        return SwitchDecision(
            "abort",
            f"最近共享边界 {candidate:.3f}s 处目标档分段缺失或不可读，切换中止",
            candidate_time=candidate,
        )
    return SwitchDecision(
        "wait",
        f"{source_time:.3f}s 不是共享切点；继续旧档到 {candidate:.3f}s 才能换，"
        f"届时目标首帧 {candidate_dst.frame_label}",
        candidate_time=candidate,
        wait_seconds=max(0.0, candidate - source_time),
        target_seq=candidate_dst.seq,
        target_file=candidate_dst.file,
        target_frame_label=candidate_dst.frame_label,
    )


def assert_no_replay(
    manifest: dict,
    tier: str,
    source_time: float,
    proposed_seek_source_time: float,
) -> str | None:
    """播放器执行切换前的最后一道闸：目标 seek 点不得早于当前源位置。

    返回拒绝原因；None 表示放行。
    """
    tol = 1.5 / float(manifest["source_fps"])
    # 严格回退即拒绝（不放宽一帧）；同刻或向前才放行
    if proposed_seek_source_time < source_time:
        return (
            f"拒绝重播：试图从 {source_time:.3f}s 退回到 "
            f"{proposed_seek_source_time:.3f}s"
        )
    segs = _segments_of(manifest, tier)
    seg = _segment_at(segs, proposed_seek_source_time, tol)
    if seg is None:
        return f"目标档在 {proposed_seek_source_time:.3f}s 无分段"
    if not seg.openable:
        return f"目标分段 {seg.file} 不可读"
    return None
