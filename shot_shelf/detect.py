"""Shot boundary detection and merge reasoning.

Input is the per-frame evidence series produced by :mod:`shot_shelf.media`::

    rows = [(t_ms, scene_score, y_avg, sat_avg), ...]

Keeping detection separate from decoding means the sensitivity slider re-runs
instantly against cached evidence and every decision is unit-testable without
video files.

Rules
-----
**Propose**
  * hard cut — a local maximum of ffmpeg's histogram scene score that reaches
    the sensitivity threshold;
  * gradual transition — a *bounded* run of low but non-zero change whose
    accumulated change and total appearance shift are significant.  An
    ongoing hue drift / handheld sway has no end and is not proposed.

**Decide** (three merge passes, repeated until stable)
  1. flash / momentary occlusion — a very short span whose two neighbours look
     alike is folded back into them, even though both cuts are strong;
  2. short span — if both surrounding cuts are strong the span is kept
     ("明显切换但间隔很短时仍可保留"), otherwise it merges into the neighbour
     across the weaker cut;
  3. visually similar neighbours — a non-strong cut whose two sides have
     close median luma and saturation is "相邻镜头画面变化不明显", so the
     pair is merged.

Every boundary records the numbers used (score, luma/sat deltas, transition
width, cumulative mass) plus a Chinese explanation, shown in the evidence
panel and in the exported catalogue.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field, asdict
from typing import Iterable, Sequence

Row = tuple[int, float, float, float]


@dataclass
class DetectSettings:
    threshold: float = 0.26
    strong_threshold: float = 0.52
    min_shot_ms: int = 800
    keep_short_strong: bool = True
    merge_similar: bool = True
    similar_luma_tol: float = 16.0
    similar_sat_tol: float = 20.0
    flash_max_ms: int = 360

    def normalized(self) -> "DetectSettings":
        def clamp(value, low, high, fallback):
            try:
                number = float(value)
            except (TypeError, ValueError):
                return fallback
            return max(low, min(high, number))

        def as_int(value, fallback, low, high):
            try:
                number = int(float(value))
            except (TypeError, ValueError):
                return fallback
            return max(low, min(high, number))

        threshold = clamp(self.threshold, 0.05, 0.95, 0.26)
        strong = clamp(self.strong_threshold, 0.0, 0.99, 0.52)
        strong = max(strong, threshold)
        return DetectSettings(
            threshold=threshold,
            strong_threshold=strong,
            min_shot_ms=as_int(self.min_shot_ms, 800, 100, 60_000),
            keep_short_strong=bool(self.keep_short_strong),
            merge_similar=bool(self.merge_similar),
            similar_luma_tol=clamp(self.similar_luma_tol, 0.0, 120.0, 16.0),
            similar_sat_tol=clamp(self.similar_sat_tol, 0.0, 160.0, 20.0),
            flash_max_ms=as_int(self.flash_max_ms, 360, 0, 2000),
        )


# ---------------------------------------------------------------------------
# Small numeric helpers
# ---------------------------------------------------------------------------


def _median(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    return float(statistics.median(values))


def _index_at(rows: Sequence[Row], t_ms: int) -> int:
    """Binary search: last row whose time <= t_ms (0 if all later)."""

    if not rows:
        return 0
    if t_ms <= rows[0][0]:
        return 0
    low, high = 0, len(rows) - 1
    while low < high:
        mid = (low + high + 1) // 2
        if rows[mid][0] <= t_ms:
            low = mid
        else:
            high = mid - 1
    return low


def _appearance(rows: Sequence[Row], start_ms: int, end_ms: int) -> tuple[float, float]:
    """Median luma / saturation representing the content of a time range.

    Frames exactly on the edges are excluded when interior samples exist: for
    a 120ms flash the edge frames are the surrounding scene, so including
    them would make the flash look like "the same scene" and defeat the flash
    merge rule.  For longer ranges the middle 70% is used, which is robust to
    a couple of transition frames at either end.
    """

    if not rows:
        return 0.0, 0.0
    start_ms = max(rows[0][0], int(start_ms))
    end_ms = min(rows[-1][0], int(end_ms))
    if end_ms < start_ms:
        end_ms = start_ms
    lo = _index_at(rows, start_ms)
    hi = _index_at(rows, end_ms)

    inner_lo = lo
    while inner_lo <= hi and rows[inner_lo][0] <= start_ms:
        inner_lo += 1
    inner_hi = hi
    while inner_hi >= lo and rows[inner_hi][0] >= end_ms:
        inner_hi -= 1
    if inner_lo <= inner_hi:
        lo, hi = inner_lo, inner_hi

    span = max(0, hi - lo)
    if span >= 6:
        lo += int(span * 0.15)
        hi -= int(span * 0.15)
    ys = [rows[i][2] for i in range(lo, hi + 1)]
    sats = [rows[i][3] for i in range(lo, hi + 1)]
    return round(_median(ys), 2), round(_median(sats), 2)


# ---------------------------------------------------------------------------
# Candidates
# ---------------------------------------------------------------------------


@dataclass
class _Candidate:
    index: int
    t_ms: int
    score: float
    kind: str  # hard | gradual
    width_frames: int
    prominence: float
    mass: float = 0.0
    start_ms: int = 0
    end_ms: int = 0


def _hard_candidates(rows: Sequence[Row], threshold: float, fps: float) -> list[_Candidate]:
    scores = [row[1] for row in rows]
    if not scores:
        return []
    frame_ms = 1000.0 / max(fps, 1.0)
    # Small radius: two strong cuts around a 0.6s flash must both survive.
    radius = max(1, int(round(0.09 * fps)))
    found: list[_Candidate] = []
    for i, score in enumerate(scores):
        if score < threshold:
            continue
        lo = max(0, i - radius)
        hi = min(len(scores), i + radius + 1)
        window = scores[lo:hi]
        if score < max(window):
            continue
        if i > 0 and scores[i - 1] == score and score == max(window):
            continue  # keep the first frame of a plateau
        floor = max(threshold * 0.45, score * 0.35)
        left = i
        while left - 1 >= 0 and scores[left - 1] >= floor:
            left -= 1
        right = i
        while right + 1 < len(scores) and scores[right + 1] >= floor:
            right += 1
        width_frames = right - left + 1
        width_ms = width_frames * frame_ms
        baseline_window = scores[max(0, i - radius * 5): min(len(scores), i + radius * 5 + 1)]
        baseline = _median([s for s in baseline_window if s < score] or [0.0])
        prominence = max(0.0, score - baseline)
        found.append(
            _Candidate(
                index=i,
                t_ms=rows[i][0],
                score=score,
                kind="hard" if width_ms < 260 else "gradual",
                width_frames=width_frames,
                prominence=prominence,
                mass=score,
                start_ms=int(round(rows[i][0] - width_ms / 2)),
                end_ms=int(round(rows[i][0] + width_ms / 2)),
            )
        )

    deduped: list[_Candidate] = []
    tolerance = max(70, int(round(frame_ms * 2)))
    for cand in found:
        if (
            deduped
            and cand.t_ms - deduped[-1].t_ms <= tolerance
            and cand.kind == deduped[-1].kind
        ):
            if cand.score > deduped[-1].score:
                deduped[-1] = cand
            continue
        deduped.append(cand)
    return deduped


def _gradual_candidates(
    rows: Sequence[Row],
    threshold: float,
    fps: float,
    existing: Sequence[_Candidate],
) -> list[_Candidate]:
    """Bounded low-score transitions: fades, dissolves, wipes."""

    if not rows:
        return []
    frame_ms = 1000.0 / max(fps, 1.0)
    scores = [row[1] for row in rows]
    floor = 0.004
    active = [score >= floor for score in scores]
    gap_frames = max(1, int(round(280 / frame_ms)))
    regions: list[tuple[int, int]] = []
    start = None
    last_active = -10_000
    for i, flag in enumerate(active):
        if not flag:
            continue
        if start is None:
            start = i
        elif i - last_active > gap_frames:
            regions.append((start, last_active))
            start = i
        last_active = i
    if start is not None:
        regions.append((start, last_active))

    existing_times = [cand.t_ms for cand in existing]
    results: list[_Candidate] = []
    for reg_start, reg_end in regions:
        start_ms = rows[reg_start][0]
        end_ms = rows[reg_end][0]
        width_ms = end_ms - start_ms + int(frame_ms)
        if width_ms < 500 or width_ms > 3200:
            continue
        if any(start_ms - 200 <= t <= end_ms + 200 for t in existing_times):
            continue
        region_scores = scores[reg_start: reg_end + 1]
        peak = max(region_scores)
        if peak >= threshold:
            continue  # a hard candidate already covers this region
        mass = sum(region_scores)
        if mass < 0.75:
            continue
        before_y, before_sat = _appearance(rows, start_ms - 450, start_ms)
        after_y, after_sat = _appearance(rows, end_ms, end_ms + 450)
        d_luma = abs(after_y - before_y)
        d_sat = abs(after_sat - before_sat)
        # A real transition changes the picture; a drift that returns to the
        # same look is not a cut.
        if d_luma < 7 and d_sat < 9:
            continue
        total = mass or 1.0
        # region_scores is already sliced, so enumerate indices are local.
        centre_offset = int(
            round(sum(i * s for i, s in enumerate(region_scores)) / total)
        )
        centre_idx = max(reg_start, min(reg_end, reg_start + centre_offset))
        results.append(
            _Candidate(
                index=centre_idx,
                t_ms=rows[centre_idx][0],
                score=peak,
                kind="gradual",
                width_frames=reg_end - reg_start + 1,
                prominence=max(0.0, peak),
                mass=mass,
                start_ms=start_ms,
                end_ms=end_ms + int(frame_ms),
            )
        )
    return results


# ---------------------------------------------------------------------------
# Boundary record
# ---------------------------------------------------------------------------


@dataclass
class Boundary:
    at_ms: int
    score: float
    kind: str  # hard | gradual | manual
    width_ms: int
    sharpness: float
    prominence: float = 0.0
    mass: float = 0.0
    luma_before: float = 0.0
    luma_after: float = 0.0
    sat_before: float = 0.0
    sat_after: float = 0.0
    source: str = "auto"  # auto | manual
    decision: str = "candidate"  # kept | short-kept | merged
    reason: str = ""
    strong: bool = False
    frame_index: int = 0
    transition_start_ms: int = 0
    transition_end_ms: int = 0

    @property
    def luma_delta(self) -> float:
        return round(self.luma_after - self.luma_before, 2)

    @property
    def sat_delta(self) -> float:
        return round(self.sat_after - self.sat_before, 2)

    def confidence(self, settings: DetectSettings) -> float:
        if self.source == "manual":
            return 1.0
        if self.decision == "merged":
            return 0.2
        if self.kind == "gradual":
            mass_component = min(1.0, self.mass / max(1.5, settings.threshold * 5))
            shift = min(1.0, (abs(self.luma_delta) + abs(self.sat_delta)) / 60.0)
            return round(min(1.0, 0.55 + 0.28 * mass_component + 0.17 * shift), 3)
        ratio = min(1.0, self.score / max(settings.threshold, 1e-6) - 1.0) if settings.threshold > 0 else 0.0
        sharp_bonus = min(1.0, self.sharpness / 2.5)
        value = 0.55 + 0.3 * ratio + 0.15 * sharp_bonus
        if self.strong:
            value = max(value, 0.82)
        if self.decision == "short-kept":
            value = max(0.62, value - 0.08)
        return round(max(0.0, min(1.0, value)), 3)

    def to_dict(self, settings: DetectSettings, frame_ms: int = 40) -> dict:
        confidence = self.confidence(settings)
        return {
            "id": f"b-{self.source}-{self.frame_index}-{self.at_ms}",
            "at_ms": self.at_ms,
            "score": round(self.score, 4),
            "kind": self.kind,
            "width_ms": self.width_ms,
            "sharpness": round(self.sharpness, 2),
            "mass": round(self.mass, 2),
            "luma_before": round(self.luma_before, 1),
            "luma_after": round(self.luma_after, 1),
            "luma_delta": self.luma_delta,
            "sat_before": round(self.sat_before, 1),
            "sat_after": round(self.sat_after, 1),
            "sat_delta": self.sat_delta,
            "prominence": round(self.prominence, 4),
            "source": self.source,
            "decision": self.decision,
            "reason": self.reason,
            "strong": self.strong,
            "confidence": confidence,
            "confidence_label": "手动" if self.source == "manual" else confidence_label(confidence),
            "frame": int(round(self.at_ms / frame_ms)) if frame_ms else 0,
            "transition_start_ms": self.transition_start_ms,
            "transition_end_ms": self.transition_end_ms,
        }


def confidence_label(value: float) -> str:
    if value >= 0.85:
        return "高"
    if value >= 0.65:
        return "中"
    if value >= 0.45:
        return "低"
    return "很低"


@dataclass
class DetectionResult:
    shots: list[dict]
    boundaries: list[dict]
    settings: dict
    summary: dict
    series: list[list[float]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Internal span model used by the merge passes
# ---------------------------------------------------------------------------
#
# After the initial cut proposal the timeline is two parallel lists:
#
#   spans = [_Span, ...]        tiles [0, span_end]
#   cuts  = [Boundary, ...]     len(cuts) == len(spans) - 1
#
# cuts[i] sits between spans[i] and spans[i+1].  Merging a pair deletes one
# cut and joins two spans, keeping both lists in sync without pointer
# bookkeeping.


@dataclass
class _Span:
    start_ms: int
    end_ms: int

    @property
    def duration(self) -> int:
        return self.end_ms - self.start_ms


def _appearance_getter(rows: Sequence[Row]):
    cache: dict[tuple[int, int], tuple[float, float]] = {}

    def get(span: _Span) -> tuple[float, float]:
        key = (span.start_ms, span.end_ms)
        if key not in cache:
            cache[key] = _appearance(rows, span.start_ms, span.end_ms)
        return cache[key]

    return get


def _refresh_boundary_appearance(get_appearance, spans: list[_Span], cuts: list[Boundary]) -> None:
    for i, boundary in enumerate(cuts):
        if i + 1 >= len(spans):
            break
        boundary.luma_before, boundary.sat_before = get_appearance(spans[i])
        boundary.luma_after, boundary.sat_after = get_appearance(spans[i + 1])


# ---------------------------------------------------------------------------
# Main entry
# ---------------------------------------------------------------------------


def detect(
    rows: Sequence[Row],
    settings: DetectSettings | None = None,
    *,
    fps: float = 30.0,
    duration_ms: int | None = None,
    extra_boundaries: Iterable[int] = (),
    removed_boundaries: Iterable[int] = (),
) -> DetectionResult:
    settings = (settings or DetectSettings()).normalized()
    rows = sorted(rows, key=lambda r: r[0])
    frame_ms = int(round(1000.0 / max(fps, 1.0))) or 40

    if not rows:
        span_end = max(0, duration_ms or 0)
        shots = [_make_shot("s-0", 0, span_end)] if span_end > 0 else []
        return DetectionResult(
            shots=shots,
            boundaries=[],
            settings=asdict(settings),
            summary=_summary([], shots),
        )

    span_end = int(duration_ms) if duration_ms and duration_ms > 0 else rows[-1][0] + frame_ms
    scores = [row[1] for row in rows]

    hard = _hard_candidates(rows, settings.threshold, fps)
    gradual = _gradual_candidates(rows, settings.threshold, fps, hard)
    candidates = sorted(hard + gradual, key=lambda c: c.t_ms)

    boundaries: list[Boundary] = []
    for cand in candidates:
        i = cand.index
        neighbours = scores[max(0, i - 3): i] + scores[i + 1: min(len(scores), i + 4)]
        baseline = max(1e-4, _median(neighbours))
        sharpness = cand.score / baseline
        width_ms = int(round(cand.width_frames * frame_ms))
        kind = cand.kind
        if kind == "hard" and (width_ms > 340 or sharpness < 1.25):
            kind = "gradual"
        boundaries.append(
            Boundary(
                at_ms=rows[i][0],
                score=cand.score,
                kind=kind,
                width_ms=width_ms,
                sharpness=sharpness,
                prominence=cand.prominence,
                mass=cand.mass,
                strong=(kind == "hard" and cand.score >= settings.strong_threshold),
                frame_index=i,
                transition_start_ms=max(0, cand.start_ms),
                transition_end_ms=min(span_end, cand.end_ms or rows[i][0]),
            )
        )

    # Duplicate peaks of the same cut.
    boundaries.sort(key=lambda b: b.at_ms)
    deduped: list[Boundary] = []
    for boundary in boundaries:
        if (
            deduped
            and boundary.at_ms - deduped[-1].at_ms <= max(75, frame_ms * 2)
            and boundary.kind == deduped[-1].kind
        ):
            if boundary.score > deduped[-1].score:
                deduped[-1] = boundary
            continue
        deduped.append(boundary)
    boundaries = deduped

    # Manual deletions of detected cuts win over detection.
    removed_times = sorted({int(round(t)) for t in removed_boundaries})
    if removed_times:
        boundaries = [
            boundary
            for boundary in boundaries
            if not any(abs(boundary.at_ms - t) <= max(320, frame_ms * 2) for t in removed_times)
        ]

    # Manual additions are always cuts.
    for t in sorted({int(round(x)) for x in extra_boundaries if 0 < int(round(x)) < span_end}):
        idx = _index_at(rows, t)
        boundaries.append(
            Boundary(
                at_ms=t,
                score=rows[idx][1] if rows else 0.0,
                kind="manual",
                width_ms=frame_ms,
                sharpness=1.0,
                source="manual",
                decision="kept",
                reason="手动添加的切点，始终保留。",
                strong=True,
                frame_index=idx,
                transition_start_ms=max(0, t - frame_ms),
                transition_end_ms=min(span_end, t + frame_ms),
            )
        )
    boundaries.sort(key=lambda b: b.at_ms)
    cleaned: list[Boundary] = []
    for boundary in boundaries:
        if cleaned and abs(boundary.at_ms - cleaned[-1].at_ms) <= frame_ms:
            if boundary.source == "manual" and cleaned[-1].source != "manual":
                cleaned[-1] = boundary
            continue
        cleaned.append(boundary)
    boundaries = cleaned

    for boundary in boundaries:
        if boundary.decision == "candidate":
            boundary.decision = "kept"

    # --- Span/cut lists ------------------------------------------------
    # Ignore cuts at/after the end of the media; they cannot form a span.
    boundaries = [b for b in boundaries if 0 < b.at_ms < span_end]
    spans: list[_Span] = []
    cut_list: list[Boundary] = []
    cursor = 0
    for boundary in boundaries:
        if boundary.at_ms <= cursor + max(1, frame_ms // 2):
            continue  # degenerate cut, drop it
        spans.append(_Span(start_ms=cursor, end_ms=boundary.at_ms))
        cut_list.append(boundary)
        cursor = boundary.at_ms
    if span_end > cursor:
        spans.append(_Span(start_ms=cursor, end_ms=span_end))
    if not spans:
        spans = [_Span(start_ms=0, end_ms=max(span_end, 1))]
    cut_list = cut_list[: max(0, len(spans) - 1)]

    get_appearance = _appearance_getter(rows)
    _refresh_boundary_appearance(get_appearance, spans, cut_list)

    # --- Merge passes --------------------------------------------------
    flash_merged = 0
    similar_merged = 0
    short_kept_ids: set[int] = set()
    guard = 0
    limit = len(spans) * 6 + 24
    changed = True
    while changed and guard < limit and len(spans) > 1:
        changed = False
        guard += 1

        # 1. Flash / momentary occlusion.
        for i in range(1, len(spans) - 1):
            middle = spans[i]
            if middle.duration > settings.flash_max_ms or middle.duration <= 0:
                continue
            in_cut, out_cut = cut_list[i - 1], cut_list[i]
            if in_cut.source == "manual" or out_cut.source == "manual":
                continue
            prev_y, prev_sat = get_appearance(spans[i - 1])
            mid_y, mid_sat = get_appearance(middle)
            next_y, next_sat = get_appearance(spans[i + 1])
            neighbours_similar = abs(prev_y - next_y) <= 10 and abs(prev_sat - next_sat) <= 14
            middle_differs = abs(mid_y - prev_y) >= 18 or abs(mid_sat - prev_sat) >= 12
            if not (neighbours_similar and middle_differs):
                continue
            reason = (
                f"闪光/瞬时遮挡：中间只有 {middle.duration}ms，亮度 {mid_y:.0f}、饱和度 {mid_sat:.0f}，"
                f"而前后两段为 {prev_y:.0f}/{next_y:.0f} 与 {prev_sat:.0f}/{next_sat:.0f}，"
                f"内容几乎一致，判定为瞬时遮挡，三段合并。"
            )
            for boundary, before, after in (
                (in_cut, (prev_y, prev_sat), (mid_y, mid_sat)),
                (out_cut, (mid_y, mid_sat), (next_y, next_sat)),
            ):
                boundary.decision = "merged"
                boundary.reason = reason
                boundary.luma_before, boundary.sat_before = before
                boundary.luma_after, boundary.sat_after = after
                short_kept_ids.discard(id(boundary))
            spans[i - 1: i + 2] = [_Span(start_ms=spans[i - 1].start_ms, end_ms=spans[i + 1].end_ms)]
            del cut_list[i - 1: i + 1]
            flash_merged += 1
            changed = True
            break
        if changed:
            continue

        # 2. Short spans.
        for i, span in enumerate(spans):
            if span.duration >= settings.min_shot_ms:
                continue
            left_cut = cut_list[i - 1] if i > 0 else None
            right_cut = cut_list[i] if i < len(cut_list) else None
            if left_cut is None and right_cut is None:
                continue

            if (
                settings.keep_short_strong
                and left_cut is not None
                and right_cut is not None
                and left_cut.strong
                and right_cut.strong
            ):
                reason = (
                    f"相邻片段仅 {span.duration}ms（短于最小镜头 {settings.min_shot_ms}ms），"
                    f"但两侧切点都明显（{left_cut.score:.2f} / {right_cut.score:.2f}），"
                    f"按规则保留这个短镜头。"
                )
                if id(left_cut) not in short_kept_ids:
                    left_cut.reason = reason
                if "两侧切点" not in (right_cut.reason or ""):
                    right_cut.reason = reason
                left_cut.decision = "kept"
                right_cut.decision = "kept"
                short_kept_ids.add(id(left_cut))
                short_kept_ids.add(id(right_cut))
                continue

            # A short span is kept when both sides are strong cuts (see the
            # branch above).  Otherwise:
            #   * a weak non-manual side is merged across first;
            #   * if only strong sides remain, they are merged across only when
            #     the user turned off "keep short strong shots" — otherwise a
            #     strong cutaway at the timeline edge is protected.
            weak_options = []
            strong_options = []
            if left_cut is not None:
                bucket = strong_options if left_cut.strong else weak_options
                bucket.append((left_cut.source == "manual", left_cut.score, True, left_cut))
            if right_cut is not None:
                bucket = strong_options if right_cut.strong else weak_options
                bucket.append((right_cut.source == "manual", right_cut.score, False, right_cut))
            weak_options.sort(key=lambda item: item[1])
            strong_options.sort(key=lambda item: item[1])

            candidates = weak_options
            if not candidates and not settings.keep_short_strong:
                candidates = strong_options
            chosen = None
            for is_manual, _score, is_left, cut in candidates:
                if not is_manual:
                    chosen = (is_left, cut)
                    break
            if chosen is None:
                continue
            join_left, join_cut = chosen

            direction = "左" if join_left else "右"
            if join_cut.strong:
                reason = (
                    f"片段仅 {span.duration}ms，短于最小镜头 {settings.min_shot_ms}ms；"
                    f"当前已关闭“保留短镜头”，按最小镜头长度并入{direction}侧片段"
                    f"（{direction}侧切点强度 {join_cut.score:.2f}）。"
                )
            else:
                reason = (
                    f"片段仅 {span.duration}ms，短于最小镜头 {settings.min_shot_ms}ms；"
                    f"与{direction}侧切点强度 {join_cut.score:.2f}"
                    f"未达到强切点 {settings.strong_threshold:.2f}，不足以单独成镜，"
                    f"并入{direction}侧片段。"
                )
            join_cut.decision = "merged"
            join_cut.reason = reason
            short_kept_ids.discard(id(join_cut))
            if join_left:
                spans[i - 1: i + 1] = [_Span(start_ms=spans[i - 1].start_ms, end_ms=span.end_ms)]
                del cut_list[i - 1]
            else:
                spans[i: i + 2] = [_Span(start_ms=span.start_ms, end_ms=spans[i + 1].end_ms)]
                del cut_list[i]
            changed = True
            break
        if changed:
            _refresh_boundary_appearance(get_appearance, spans, cut_list)
            continue

        # 3. Visually similar neighbours with a non-strong boundary.
        if settings.merge_similar:
            for i, boundary in enumerate(cut_list):
                if boundary.strong or boundary.source == "manual" or boundary.kind == "gradual":
                    continue
                before_y, before_sat = get_appearance(spans[i])
                after_y, after_sat = get_appearance(spans[i + 1])
                d_y = abs(after_y - before_y)
                d_sat = abs(after_sat - before_sat)
                if d_y > settings.similar_luma_tol or d_sat > settings.similar_sat_tol:
                    continue
                reason = (
                    f"相邻两段画面接近：亮度差 {d_y:.0f}（容差 {settings.similar_luma_tol:.0f}）、"
                    f"饱和度差 {d_sat:.0f}（容差 {settings.similar_sat_tol:.0f}），"
                    f"切点强度 {boundary.score:.2f} 未达强切点 {settings.strong_threshold:.2f}，"
                    f"判为同一镜头的轻微变化，合并。"
                )
                boundary.decision = "merged"
                boundary.reason = reason
                short_kept_ids.discard(id(boundary))
                spans[i: i + 2] = [_Span(start_ms=spans[i].start_ms, end_ms=spans[i + 1].end_ms)]
                del cut_list[i]
                similar_merged += 1
                changed = True
                break
            if changed:
                _refresh_boundary_appearance(get_appearance, spans, cut_list)
                continue

    _refresh_boundary_appearance(get_appearance, spans, cut_list)

    # --- Finalise decisions --------------------------------------------
    live_ids = {id(b) for b in cut_list}
    for boundary in boundaries:
        if id(boundary) in live_ids:
            if id(boundary) in short_kept_ids:
                boundary.decision = "short-kept"
                if "两侧切点" not in (boundary.reason or ""):
                    boundary.reason = _short_kept_reason(boundary, spans, cut_list, settings)
            else:
                boundary.decision = "kept"
                boundary.reason = _kept_reason(boundary, settings)
        elif boundary.decision != "merged":
            boundary.decision = "merged"
            if not boundary.reason:
                boundary.reason = (
                    "人工删除的切点。" if boundary.source == "manual" else "与相邻片段合并后，这个切点不再存在。"
                )

    shots = [_make_shot(f"s-{i}", span.start_ms, span.end_ms) for i, span in enumerate(spans)]

    return DetectionResult(
        shots=shots,
        boundaries=[b.to_dict(settings, frame_ms) for b in boundaries],
        settings=asdict(settings),
        summary=_summary(boundaries, shots, flash_merged, similar_merged),
        series=_compact_series(rows),
    )


def _kept_reason(boundary: Boundary, settings: DetectSettings) -> str:
    if boundary.source == "manual":
        return "手动添加的切点，始终保留。"
    if boundary.kind == "gradual":
        return (
            f"逐帧峰值 {boundary.score:.2f} 低于灵敏度 {settings.threshold:.2f}，"
            f"但 {boundary.width_ms}ms 内累计变化 {boundary.mass:.1f}、"
            f"亮度变化 {boundary.luma_delta:+.0f}、饱和度变化 {boundary.sat_delta:+.0f}，"
            f"判定为渐变转场，保留。"
        )
    if boundary.strong:
        return (
            f"画面差异 {boundary.score:.2f} ≥ 强切点 {settings.strong_threshold:.2f}，"
            f"单帧硬切（过渡 {boundary.width_ms}ms，峰值是邻近帧的 {boundary.sharpness:.1f} 倍），保留。"
        )
    return (
        f"画面差异 {boundary.score:.2f} 超过灵敏度 {settings.threshold:.2f}，"
        f"相邻画面亮度差 {boundary.luma_delta:+.0f}、饱和度差 {boundary.sat_delta:+.0f}，"
        f"足以成镜，保留。"
    )


def _short_kept_reason(
    boundary: Boundary,
    spans: Sequence[_Span],
    cuts: Sequence[Boundary],
    settings: DetectSettings,
) -> str:
    ids = [id(cut) for cut in cuts]
    try:
        index = ids.index(id(boundary))
    except ValueError:
        return _kept_reason(boundary, settings)
    if index + 1 >= len(spans):
        return _kept_reason(boundary, settings)
    left, right = spans[index], spans[index + 1]
    short = min(left.duration, right.duration)
    if left.duration <= right.duration:
        partner = cuts[index + 1] if index + 1 < len(cuts) else None
    else:
        partner = cuts[index - 1] if index > 0 else None
    scores = f"{boundary.score:.2f}" + (f" / {partner.score:.2f}" if partner else "")
    return (
        f"相邻片段仅 {short}ms（短于最小镜头 {settings.min_shot_ms}ms），"
        f"但两侧切点都明显（{scores}），按规则保留这个短镜头。"
    )


def _summary(
    boundaries: Sequence[Boundary],
    shots: Sequence[dict],
    flash_merged: int = 0,
    similar_merged: int = 0,
) -> dict:
    return {
        "shot_count": len(shots),
        "boundary_count": len(boundaries),
        "cuts": sum(1 for b in boundaries if b.decision in {"kept", "short-kept"}),
        "merged": sum(1 for b in boundaries if b.decision == "merged"),
        "kept_short": sum(1 for b in boundaries if b.decision == "short-kept"),
        "flash_merged": flash_merged,
        "similar_merged": similar_merged,
        "manual": sum(1 for b in boundaries if b.source == "manual"),
    }


def _compact_series(rows: Sequence[Row]) -> list[list[float]]:
    compact = [[row[0], round(row[1], 3)] for row in rows]
    if len(compact) > 2000:
        step = len(compact) / 2000.0
        compact = [compact[int(i * step)] for i in range(2000)]
        if compact and compact[-1][0] != rows[-1][0]:
            compact.append([rows[-1][0], round(rows[-1][1], 3)])
    return compact


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _make_shot(shot_id: str, start_ms: int, end_ms: int) -> dict:
    return {
        "id": shot_id,
        "start_ms": int(start_ms),
        "end_ms": int(end_ms),
        "tags": [],
        "note": "",
        "manual_start": False,
        "manual_end": False,
        "created_manual": False,
    }


def shot_duration(shot: dict) -> int:
    return max(0, int(shot["end_ms"]) - int(shot["start_ms"]))


def resolve_overlaps(shots: Sequence[dict]) -> list[dict]:
    """Normalise a user-edited shot list into a contiguous timeline."""

    cleaned = []
    for shot in sorted(shots, key=lambda s: int(s["start_ms"])):
        start = max(0, int(shot["start_ms"]))
        end = max(start + 1, int(shot["end_ms"]))
        cleaned.append({**shot, "start_ms": start, "end_ms": end})
    for i in range(1, len(cleaned)):
        cleaned[i]["start_ms"] = max(cleaned[i]["start_ms"], cleaned[i - 1]["end_ms"])
        if cleaned[i]["end_ms"] <= cleaned[i]["start_ms"]:
            cleaned[i]["end_ms"] = cleaned[i]["start_ms"] + 1
    return [s for s in cleaned if s["end_ms"] > s["start_ms"]]
