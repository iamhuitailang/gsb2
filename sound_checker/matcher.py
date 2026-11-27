from __future__ import annotations

from typing import Any

import numpy as np

from .features import HOP, AudioFeatures, compute_features
from .audio import load_audio

DEFAULT_PARAMS: dict[str, Any] = {
    "version": 1,
    "sample_rate": 22050,
    "n_fft": 1024,
    "hop": HOP,
    "n_mels": 32,
    "context_frames": 4,
    "continue_score": 0.58,
    "seed_score": 0.72,
    "strong_score": 0.78,
    "min_match_seconds": 0.32,
    "max_gap_frames": 6,
    "high_similarity": 0.80,
    "uncertain_similarity": 0.64,
    "high_confidence": 0.72,
    "uncertain_confidence": 0.46,
    "max_matches_per_pair": 4,
}


def features_for_path(path: str) -> AudioFeatures:
    audio = load_audio(path)
    return compute_features(audio.samples, audio.duration)


def _runs_from_mask(mask: np.ndarray) -> list[tuple[int, int]]:
    if mask.size == 0 or not np.any(mask):
        return []
    edges = np.diff(mask.astype(np.int8))
    starts = list(np.where(edges == 1)[0] + 1)
    ends = list(np.where(edges == -1)[0] + 1)
    if mask[0]:
        starts.insert(0, 0)
    if mask[-1]:
        ends.append(mask.size)
    return list(zip(starts, ends))


def _merge_small_gaps(mask: np.ndarray, max_gap: int) -> np.ndarray:
    runs = _runs_from_mask(mask)
    if len(runs) <= 1:
        return mask
    out = mask.copy()
    for (_, prev_end), (next_start, _) in zip(runs, runs[1:]):
        gap = next_start - prev_end
        if 0 < gap <= max_gap:
            out[prev_end:next_start] = True
    return out


def _onset_evidence(
    a: AudioFeatures, b: AudioFeatures, offset: int, start: int, end: int, tolerance: int = 3
) -> dict[str, float | int]:
    a_in = a.onsets[(a.onsets >= start) & (a.onsets < end)]
    b_start = start + offset
    b_end = end + offset
    b_in = b.onsets[(b.onsets >= max(0, b_start)) & (b.onsets <= b_end)]

    matched_a = 0
    residuals: list[float] = []
    for i in a_in:
        expected = i + offset
        if b.onsets.size:
            j = int(b.onsets[np.argmin(np.abs(b.onsets - expected))])
            dist = abs(j - expected)
            if dist <= tolerance:
                matched_a += 1
                residuals.append(dist * HOP / a.sample_rate)

    matched_b = 0
    for j in b_in:
        expected = j - offset
        if a.onsets.size:
            i = int(a.onsets[np.argmin(np.abs(a.onsets - expected))])
            if abs(i - expected) <= tolerance:
                matched_b += 1

    n_a, n_b = len(a_in), len(b_in)
    if n_a + n_b == 0:
        f1 = 0.0
    else:
        # matched_a is recall numerator against A; matched_b precision against B.
        recall = matched_a / n_a if n_a else 0.0
        precision = matched_b / n_b if n_b else 0.0
        f1 = 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)
    return {
        "a_onsets": n_a,
        "b_onsets": n_b,
        "matched_a": matched_a,
        "matched_b": matched_b,
        "event_f1": round(float(f1), 4),
        "onset_timing_ms": round(float(np.mean(residuals) * 1000), 1) if residuals else None,
    }


def _static_score(features: AudioFeatures, indices: np.ndarray, lag: int = 6) -> float:
    if indices.size <= lag:
        return 0.0
    first = features.vector[indices[:-lag]]
    second = features.vector[indices[lag:]]
    return float(np.median(np.sum(first * second, axis=1)))


def _candidate_from_run(
    similarity: np.ndarray,
    smoothed: np.ndarray,
    offset: int,
    start: int,
    end: int,
    a: AudioFeatures,
    b: AudioFeatures,
    params: dict[str, Any],
    weak: bool = False,
) -> dict[str, Any] | None:
    length = end - start
    min_frames = max(8, int(params["min_match_seconds"] * a.sample_rate / HOP))
    if length < min_frames:
        return None

    if offset >= 0:
        ia = np.arange(start, end)
        ib = ia + offset
    else:
        ib = np.arange(start, end)
        ia = ib - offset

    ia = ia[(ia >= 0) & (ia < similarity.shape[0]) & (ib >= 0) & (ib < similarity.shape[1])]
    ib = ia + offset
    if ia.size < min_frames:
        return None

    vals = similarity[ia, ib]
    smooth_vals = smoothed[start:end] if smoothed.shape[0] == similarity.diagonal(offset).shape[0] else vals
    info = np.minimum(a.weights[ia], b.weights[ib])
    floor_w = 0.035
    weighted = float(np.sum(vals * (info + floor_w)) / np.sum(info + floor_w))
    unweighted = float(np.mean(vals))
    peak = float(np.percentile(vals, 92))
    strong_ratio = float(np.mean(vals >= params["strong_score"]))
    info_seconds = float(np.sum(info) * HOP / a.sample_rate)
    duration = float(ia.size * HOP / a.sample_rate)
    onset = _onset_evidence(a, b, offset, int(ia[0]), int(ia[-1]) + 1)

    info_density = info_seconds / max(duration, 1e-6)
    event_f1 = float(onset["event_f1"])
    event_count = min(int(onset["matched_a"]), int(onset["matched_b"]))
    static_a = _static_score(a, ia)
    static_b = _static_score(b, ib)
    static_score = round((static_a + static_b) / 2.0, 4)

    # Calibrated alignment score. The category gate below supplies the actual
    # evidence requirement; this number alone is never enough to call a match.
    evidence_mass = min(1.0, info_seconds / 0.36)
    raw_score = 100.0 * np.clip(
        0.48 * weighted
        + 0.18 * strong_ratio
        + 0.18 * event_f1
        + 0.16 * evidence_mass,
        0.0,
        0.985,
    )

    reasons: list[str] = []
    if event_count >= 2:
        reasons.append(f"{event_count} 个起音/瞬态位置对齐")
    elif event_count == 1:
        reasons.append("1 个起音/瞬态位置对齐")
    if info_seconds >= 0.30:
        reasons.append(f"{info_seconds:.2f}s 高信息量依据")
    elif info_seconds > 0:
        reasons.append(f"仅 {info_seconds:.2f}s 高信息量依据")
    if static_score >= 0.992 and event_count < 3:
        reasons.append("区间高度静止，可能是持续单音/底噪")
    elif info_density < 0.13:
        reasons.append("有效变化帧较少")
    if length >= min_frames and strong_ratio >= 0.5:
        reasons.append("频谱帧连续高度吻合")

    candidate = {
        "a_start": round(float(a.times[ia[0]]), 3),
        "a_end": round(float(a.times[ia[-1]] + HOP / a.sample_rate), 3),
        "b_start": round(float(b.times[ib[0]]), 3),
        "b_end": round(float(b.times[ib[-1]] + HOP / b.sample_rate), 3),
        "offset_frames": int(offset),
        "duration": round(duration, 3),
        "similarity": round(max(0.0, weighted), 4),
        "unweighted_similarity": round(max(0.0, unweighted), 4),
        "peak_similarity": round(max(0.0, peak), 4),
        "strong_ratio": round(strong_ratio, 3),
        "info_seconds": round(info_seconds, 3),
        "info_density": round(info_density, 3),
        "static_score": static_score,
        "event_f1": event_f1,
        "aligned_events": event_count,
        "alignment_score": int(round(raw_score)),
        "score": int(round(raw_score)),
        "weak_best_effort": weak,
        "reasons": reasons,
        **{f"onset_{k}": v for k, v in onset.items()},
    }
    candidate["category"] = classify_candidate(candidate, params)
    raw = candidate["alignment_score"]
    if candidate["category"] == "high":
        candidate["score"] = max(80, min(98, raw))
    elif candidate["category"] == "uncertain":
        candidate["score"] = min(69, max(42, int(38 + raw * 0.34)))
    else:
        candidate["score"] = min(39, max(8, int(raw * 0.42)))
    return candidate


def classify_candidate(c: dict[str, Any], params: dict[str, Any]) -> str:
    sim = float(c["similarity"])
    info_seconds = float(c["info_seconds"])
    events = int(c["aligned_events"])
    event_f1 = float(c["event_f1"])
    strong_ratio = float(c["strong_ratio"])
    info_density = float(c["info_density"])

    strong_alignment = sim >= params["high_similarity"] and strong_ratio >= 0.42
    enough_evidence = (
        (info_seconds >= 0.18 and events >= 3 and event_f1 >= 0.70)
        or (info_seconds >= 0.28 and events >= 2 and event_f1 >= 0.75)
        or (
            events == 0
            and info_seconds >= 0.42
            and info_density >= 0.30
            and strong_ratio >= 0.78
            and float(c.get("static_score", 1.0)) < 0.985
        )
    )
    if strong_alignment and enough_evidence and c["alignment_score"] / 100.0 >= params["high_confidence"]:
        return "high"

    uncertain_alignment = sim >= params["uncertain_similarity"] or c["alignment_score"] / 100.0 >= params["uncertain_confidence"]
    if uncertain_alignment and info_seconds >= 0.05:
        return "uncertain"
    return "different"


def match_features(
    a: AudioFeatures, b: AudioFeatures, params: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    p = {**DEFAULT_PARAMS, **(params or {})}
    if a.vector.shape[0] < 3 or b.vector.shape[0] < 3:
        return []

    similarity = np.clip(a.vector @ b.vector.T, -1.0, 1.0)
    candidates: list[dict[str, Any]] = []
    best_effort: dict[str, Any] | None = None

    for offset in range(-(a.vector.shape[0] - 1), b.vector.shape[0]):
        diag = similarity.diagonal(offset=offset)
        if diag.size < 8:
            continue
        kernel = np.ones(5, dtype=np.float32) / 5.0
        smoothed = np.convolve(diag, kernel, mode="same")
        active = smoothed >= p["continue_score"]
        active = _merge_small_gaps(active, int(p["max_gap_frames"]))
        for start, end in _runs_from_mask(active):
            if np.max(smoothed[start:end]) < p["seed_score"]:
                continue
            cand = _candidate_from_run(similarity, smoothed, offset, start, end, a, b, p)
            if cand is not None:
                candidates.append(cand)

        # Keep a weak best interval so the UI can explain "different".
        if diag.size >= int(p["min_match_seconds"] * a.sample_rate / HOP):
            # Best fixed-ish 0.55 s window along this diagonal.
            window = max(12, int(0.55 * a.sample_rate / HOP))
            if diag.size >= window:
                cs = np.cumsum(np.insert(diag, 0, 0.0))
                means = (cs[window:] - cs[:-window]) / window
                wi = int(np.argmax(means))
                weak = _candidate_from_run(
                    similarity,
                    smoothed,
                    offset,
                    wi,
                    wi + window,
                    a,
                    b,
                    p,
                    weak=True,
                )
                if weak is not None and (best_effort is None or weak["score"] > best_effort["score"]):
                    best_effort = weak

    candidates = _nms(candidates)
    candidates.sort(key=lambda c: (c["category"] == "high", c["score"]), reverse=True)
    result = candidates[: int(p["max_matches_per_pair"])]

    if not result and best_effort is not None:
        best_effort["category"] = "different"
        best_effort["reasons"] = ["未形成足够长且有信息量的连续吻合", *best_effort.get("reasons", [])]
        result = [best_effort]
    elif result:
        # If all real runs classify different but a best effort exists, NMS may
        # already have it. Ensure the pair has at least one diagnostic interval.
        if not any(c["category"] != "different" for c in result) and best_effort is not None:
            result = _nms([*result, best_effort])[: int(p["max_matches_per_pair"])]

    for idx, cand in enumerate(result):
        cand["match_index"] = idx
    return result


def _overlap_ratio(a1: tuple[float, float], a2: tuple[float, float]) -> float:
    lo = max(a1[0], a2[0])
    hi = min(a1[1], a2[1])
    inter = max(0.0, hi - lo)
    denom = min(a1[1] - a1[0], a2[1] - a2[0])
    return inter / denom if denom > 1e-6 else 0.0


def _nms(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = sorted(candidates, key=lambda c: c["score"], reverse=True)
    kept: list[dict[str, Any]] = []
    for cand in ordered:
        duplicate = False
        for old in kept:
            a_ov = _overlap_ratio(
                (cand["a_start"], cand["a_end"]), (old["a_start"], old["a_end"])
            )
            b_ov = _overlap_ratio(
                (cand["b_start"], cand["b_end"]), (old["b_start"], old["b_end"])
            )
            close_offset = abs(int(cand["offset_frames"]) - int(old["offset_frames"])) <= 4
            if ((a_ov > 0.55 and b_ov > 0.55) or (a_ov > 0.82 and close_offset and b_ov > 0.25)
                    or (b_ov > 0.82 and close_offset and a_ov > 0.25)):
                duplicate = True
                break
        if not duplicate:
            kept.append(cand)
    return kept


def compare_paths(path_a: str, path_b: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    return match_features(features_for_path(path_a), features_for_path(path_b), params)
