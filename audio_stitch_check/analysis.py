"""Sample-level seam analysis.

The goal is to separate three things that all *look* like amplitude changes
near a seam but are not equivalent:

* codec distortion of samples that are actually present (no time lost);
* digital silence that was already in the source (not encoder-inserted);
* extra samples inserted by padding/frame rounding (a real time gap, or a
  shortfall when padding was over-trimmed).

Alignment is measured with cross-correlation against the uncompressed
reference; silence runs are then classified by whether the reference at the
same time position was silent too.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .padding import TRUST_RELIABLE

# Below this amplitude a sample counts as digital silence for gap purposes.
# 16-bit dither / MP3 low-bitrate noise floors sit well under 1e-3, while a
# real tone/pulse does not. The value is also widened adaptively per seam.
SILENCE_FLOOR = 1e-4


def mono_mix(samples: np.ndarray) -> np.ndarray:
    x = np.asarray(samples, dtype=np.float64)
    if x.ndim == 1:
        return x
    return x.mean(axis=1)


def find_shift(
    ref: np.ndarray,
    test: np.ndarray,
    max_lag: int,
    ref_center: int,
    test_center: int,
) -> tuple[int, float]:
    """Best integer sample shift of ``test`` relative to ``ref`` near a seam.

    Equal-sized windows are taken around ``ref_center`` (reference) and
    ``test_center`` (build); the build window is slid over +/- ``max_lag`` and
    the normalized cross-correlation peak gives the shift.  Positive shift
    means build content arrives *later* than the reference (padding inserted
    upstream); negative means content is early / missing.

    Returns (shift_samples, normalized_correlation_peak 0..1).
    """
    ref_m = mono_mix(ref)
    test_m = mono_mix(test)
    half = min(
        ref_center, len(ref_m) - ref_center,
        test_center, len(test_m) - test_center,
        1024,
    )
    if half < 8:  # window too small to be meaningful
        return 0, 0.0
    ref_win = ref_m[ref_center - half : ref_center + half]
    ref_energy = np.dot(ref_win, ref_win)
    if ref_energy < 1e-10:  # reference window itself is silent: cannot align
        return 0, 0.0

    lo_lag = -min(max_lag, half - 1)
    hi_lag = min(max_lag, half - 1)
    scores: list[tuple[int, float]] = []
    for lag in range(lo_lag, hi_lag + 1):
        win = test_m[test_center - half + lag : test_center + half + lag]
        if len(win) != len(ref_win):
            continue
        denom = np.sqrt(ref_energy * np.dot(win, win))
        if denom < 1e-10:
            score = -1.0
        else:
            score = float(np.dot(ref_win, win) / denom)
        scores.append((lag, score))

    # Periodic material (tones) yields near-equal peaks at whole-period lags,
    # and an alias peak can even score slightly higher than the true lag.
    # Stage 1: take the smallest absolute lag whose correlation is convincing
    # in absolute terms (>=0.9). Stage 2: re-optimize inside a sub-period
    # window around it so a small genuine residual (e.g. a 2-sample priming
    # estimation error) is resolved instead of snapping to an alias.
    convincing = [lag for lag, s in scores if s >= 0.9]
    if convincing:
        anchor = min(convincing, key=abs)
        local = min(24, half // 4)
        nearby = [
            (lag, s)
            for lag, s in scores
            if anchor - local <= lag <= anchor + local
        ]
        best_lag, best_score = max(nearby, key=lambda item: item[1])
    else:
        best_lag, best_score = max(scores, key=lambda item: item[1])
    return best_lag, max(0.0, best_score)


def estimate_priming(
    source_segment: np.ndarray,
    decoded: np.ndarray,
    max_priming: int = 2048,
) -> tuple[int, float]:
    """Estimate head priming of an untrimmed decoder output.

    Used when a file carries no padding metadata. A periodic source produces
    equal correlation peaks at the true priming plus whole-period aliases,
    all at larger lags; encoder priming is physically small (AAC 1024,
    MP3-class delays <= ~2048), so the smallest lag with a convincing
    absolute correlation (>=0.8) is taken. Returns (priming_samples,
    confidence); (0, 0.0) when no convincing peak exists.
    """
    s_m = mono_mix(source_segment)
    d_m = mono_mix(decoded)
    win = min(len(s_m), len(d_m), 4096)
    ref_win = s_m[:win]
    energy = np.dot(ref_win, ref_win)
    if energy < 1e-10:
        return 0, 0.0
    scores: list[tuple[int, float]] = []
    for lag in range(0, min(max_priming, len(d_m) - win) + 1):
        cand = d_m[lag : lag + win]
        denom = np.sqrt(energy * np.dot(cand, cand))
        if denom < 1e-10:
            continue
        scores.append((lag, float(np.dot(ref_win, cand) / denom)))
    if not scores:
        return 0, 0.0
    peak = max(s for _, s in scores)
    if peak < 0.8:
        return 0, 0.0
    # Smallest lag statistically indistinguishable from the peak (alias-safe).
    candidates = [lag for lag, s in scores if s >= peak - 0.02]
    return min(candidates), peak


def find_silence_runs(
    x: np.ndarray, threshold: float, min_len: int = 2
) -> list[tuple[int, int]]:
    """Return [start, end) runs where every channel stays below threshold."""
    m = mono_mix(x)
    quiet = np.abs(m) <= threshold
    runs: list[tuple[int, int]] = []
    start = None
    for i, q in enumerate(quiet):
        if q and start is None:
            start = i
        elif not q and start is not None:
            if i - start >= min_len:
                runs.append((start, i))
            start = None
    if start is not None and len(quiet) - start >= min_len:
        runs.append((start, len(quiet)))
    return runs


def adaptive_threshold(ref_window: np.ndarray) -> float:
    """Silence threshold adapted to the local reference noise floor."""
    floor = float(np.percentile(np.abs(mono_mix(ref_window)), 10))
    return min(0.01, max(SILENCE_FLOOR, floor * 4.0))


@dataclass
class SeamReport:
    seam_index: int
    reference_sample: int
    build_sample: int
    measured_shift: int
    shift_confidence: float
    classification: str
    inserted_silence: int  # samples of encoder/join silence at the seam
    source_was_silent: bool
    detail: str
    silence_runs: list[list[int]] = field(default_factory=list)
    padding_trust: str = "reliable"
    trust_notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "seam_index": self.seam_index,
            "reference_sample": self.reference_sample,
            "build_sample": self.build_sample,
            "measured_shift": self.measured_shift,
            "shift_confidence": round(self.shift_confidence, 4),
            "classification": self.classification,
            "inserted_silence": self.inserted_silence,
            "source_was_silent": self.source_was_silent,
            "detail": self.detail,
            "silence_runs": self.silence_runs,
            "padding_trust": self.padding_trust,
            "trust_notes": self.trust_notes,
        }


def analyze_seam(
    seam_index: int,
    ref: np.ndarray,
    build: np.ndarray,
    ref_sample: int,
    build_sample: int,
    max_lag: int,
    padding_trust: str = TRUST_RELIABLE,
    trust_notes: list[str] | None = None,
) -> SeamReport:
    """Compare one seam of a built track against the reference.

    Reference windows are centred on the reference cut index, build windows
    on the build's own junction index; the cross-correlation slides the build
    window locally against the reference window (see ``find_shift``).
    """
    window = min(2048, len(ref) // 4, len(build) // 4)
    window = max(window, 64)
    r_lo = max(0, ref_sample - window // 2)
    r_hi = min(len(ref), ref_sample + window // 2)
    shift, conf = find_shift(ref, build, max_lag, ref_sample, build_sample)
    half = min(
        ref_sample, len(ref) - ref_sample,
        build_sample, len(build) - build_sample, 1024,
    )

    b_lo = max(0, build_sample - window // 3)
    b_hi = min(len(build), build_sample + window // 3)
    threshold = adaptive_threshold(ref[r_lo:r_hi])
    runs = find_silence_runs(build[b_lo:b_hi], threshold)
    runs = [[s + b_lo, e + b_lo] for s, e in runs]

    # A run is "at the seam" when it overlaps the join position.
    at_seam = [r for r in runs if r[0] <= build_sample < r[1]]
    inserted = max((e - s for s, e in at_seam), default=0)

    # Exact digital-silence run touching the join (reconstructed padding is
    # exact zero; this is independent of the adaptive threshold above).
    b_mono = mono_mix(build)
    z = build_sample
    while z > 0 and abs(b_mono[z - 1]) <= SILENCE_FLOOR:
        z -= 1
    exact_silence_before = build_sample - z
    z = build_sample
    while z < len(b_mono) and abs(b_mono[z]) <= SILENCE_FLOOR:
        z += 1
    exact_silence_after = z - build_sample
    exact_silence = exact_silence_before + exact_silence_after

    ref_runs = find_silence_runs(ref[r_lo:r_hi], threshold)
    source_silent = any(s + r_lo <= ref_sample < e + r_lo for s, e in ref_runs)

    # A silent reference dominates everything: there is nothing time-critical
    # to align, and the silence is source material rather than padding.
    if source_silent:
        classification = "source_silence"
        detail = (
            "the reference itself is silent at this cut; timing cannot be "
            "measured here and any silence is source material, not padding"
        )
    elif exact_silence >= 32:
        # A substantial digital-silence run at the join while the reference
        # carries signal: inserted padding. The local lag sign is not used for
        # direction because the junction already absorbs cumulative offsets.
        classification = "silence_gap"
        inserted = exact_silence
        detail = (
            f"{exact_silence} digital-silent samples span the join while the "
            "reference is active; encoder-inserted padding, not codec "
            "distortion of present samples"
        )
    elif conf < 0.5:
        classification = "unverifiable"
        detail = (
            "cross-correlation confidence too low (flat or highly similar "
            "material); timing cannot be verified here"
        )
    elif shift == 0:
        if inserted:
            classification = "local_silence_no_drift"
            detail = (
                f"{inserted} near-silent samples at the join but no timing "
                "shift; codec shape/distortion, not lost time"
            )
        else:
            classification = "aligned"
            detail = "sample-accurate alignment, no inserted time"
    else:
        classification = "drift"
        detail = (
            f"content shifted {shift:+d} sample(s) without a matching silence "
            "run: padding/frame-rounding drift, not codec distortion"
        )

    return SeamReport(
        seam_index=seam_index,
        reference_sample=ref_sample,
        build_sample=build_sample,
        measured_shift=shift,
        shift_confidence=conf,
        classification=classification,
        inserted_silence=inserted,
        source_was_silent=source_silent,
        detail=detail,
        silence_runs=runs,
        padding_trust=padding_trust,
        trust_notes=trust_notes or [],
    )
