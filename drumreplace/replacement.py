"""Sample replacement rendering, mix modes and ground-truth verification."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Tuple

import numpy as np

from .synthesis import SAMPLE_RATE, Event, build_sample_library


# --------------------------------------------------------------------------- #
# rendering
# --------------------------------------------------------------------------- #
@dataclass
class RenderResult:
    wet: np.ndarray          # fully replaced track (wet only)
    mix: np.ndarray          # dry/wet blend actually exported
    difference: np.ndarray   # mix - original (same length as the input)
    dropped_tail_samples: int
    clipped_head_samples: int
    peak_db_before: float
    peak_db_after: float


def _db(x: np.ndarray) -> float:
    p = float(np.max(np.abs(x)))
    return 20 * np.log10(p) if p > 0 else -np.inf


def _bed_rms(x: np.ndarray) -> float:
    """Median 50 ms window RMS across the track -- a robust bed estimate."""
    win = int(0.05 * SAMPLE_RATE)
    n_windows = max(1, len(x) // win)
    rms = np.array([
        np.sqrt(np.mean(x[i * win:(i + 1) * win] ** 2))
        for i in range(n_windows)
    ])
    return float(np.median(rms))


def _estimate_bed(x: np.ndarray, events: List[Event],
                  protect_sec: float = 0.25) -> np.ndarray:
    """Approximate the non-hit bed (bass + ambience) of the original.

    Samples inside `protect_sec` after each hit are masked out, and the
    remaining samples are connected by linear interpolation per segment.
    This is deliberately simple: the bed only needs to carry the low-end
    and room noise under the replacement, not reconstruct anything musical.
    """
    mask = np.ones(len(x), dtype=bool)
    for ev in events:
        s = int(ev.time * SAMPLE_RATE)
        mask[s:min(len(x), s + int(protect_sec * SAMPLE_RATE))] = False
    if mask.all() or not mask.any():
        return x.copy() if mask.all() else np.zeros_like(x)

    idx = np.arange(len(x))
    known = idx[mask]
    bed = np.interp(idx, known, x[known])
    # smooth the interpolation so it behaves like a sustained bed
    kernel = np.ones(int(0.02 * SAMPLE_RATE)) / int(0.02 * SAMPLE_RATE)
    return np.convolve(bed, kernel, mode="same")


def render_replacement(original: np.ndarray, events: List[Event],
                       dry_wet: float = 0.0,
                       library: Dict[Tuple[str, str], np.ndarray] | None = None
                       ) -> RenderResult:
    """Render replaced audio.

    dry_wet: 0 = 100 % replacement, 1 = 100 % original (dry). Linear crossfade.

    Rules implemented here:
      * dense hits are simply summed, so a later sample never erases the tail
        of an earlier one -- voices are added into a shared buffer;
      * sample onset always lands exactly on the marker, so a marker at the
        file head needs no pre-roll and is never head-clipped;
      * if a sample's tail extends past the file end the buffer is extended,
        and the number of samples that *would* have been dropped without the
        extension is reported (see dropped_tail_samples);
      * per-hit amplitude is matched to the original hit's local peak so the
        replacement preserves relative dynamics, with a small velocity trim.
    """
    lib = library if library is not None else build_sample_library()
    n_in = len(original)

    # sustained bed (bass + ambience) is kept under the replacement, otherwise
    # dropping the original drums would also erase the bass line and the
    # export would be tens of dB quieter than the source.
    bed_rms = _bed_rms(original)
    bed = _estimate_bed(original, events)

    end_pad = 0
    clipped_head = 0
    for ev in events:
        start = int(round(ev.time * SAMPLE_RATE))
        if start < 0:
            clipped_head += -start
            start = 0
        voice = lib[(ev.drum, ev.velocity)]
        end_pad = max(end_pad, start + len(voice))
    n_out = max(n_in, end_pad)

    wet = np.zeros(n_out, dtype=np.float64)
    orig_pad = np.zeros(n_out, dtype=np.float64)
    orig_pad[:n_in] = original
    wet[:n_in] = bed  # bass/ambience bed carries through the replacement

    dropped_tail = 0
    for ev in events:
        start = int(round(ev.time * SAMPLE_RATE))
        if start < 0:
            dropped_tail += -start
            start = 0
        voice = lib[(ev.drum, ev.velocity)].copy()
        gain = _match_gain(original, start, ev, voice, bed_rms)
        voice *= gain
        end = start + len(voice)
        if end > n_in:
            # tail past original file end: kept via the extension, but count
            # how many samples the fixed-length export would have lost
            dropped_tail += end - n_in
        wet[start:end] += voice

    # protect against summing clipping: soft-limit report instead of hard clip
    peak_before = _db(orig_pad)
    wet_peak = np.max(np.abs(wet))
    if wet_peak > 0.99:
        wet *= 0.99 / wet_peak

    w = 1.0 - dry_wet
    mix = dry_wet * orig_pad + w * wet
    mix_peak = np.max(np.abs(mix))
    if mix_peak > 0.99:
        mix *= 0.99 / mix_peak
    difference = mix - orig_pad

    return RenderResult(
        wet=wet,
        mix=mix,
        difference=difference,
        dropped_tail_samples=dropped_tail,
        clipped_head_samples=clipped_head,
        peak_db_before=peak_before,
        peak_db_after=_db(mix),
    )


def _match_gain(original: np.ndarray, start: int, ev: Event,
                voice: np.ndarray, bed_rms: float = 0.0) -> float:
    """Scale a unit-peak replacement to the loudness of the original hit.

    Matched on 50 ms RMS with the sustained bass/noise bed subtracted in
    power, so the gain follows the drum itself rather than the backing.
    Hard hits preserve level; soft hits keep their relative quietness.
    """
    win = int(0.05 * SAMPLE_RATE)
    seg_o = original[start:min(len(original), start + win)]
    seg_v = voice[:min(len(voice), win)]
    total_rms = float(np.sqrt(np.mean(seg_o ** 2))) if len(seg_o) else 0.0
    hit_rms = np.sqrt(max(total_rms ** 2 - bed_rms ** 2, 1e-6))
    rms_v = float(np.sqrt(np.mean(seg_v ** 2))) if len(seg_v) else 1.0
    trim = 1.0 if ev.velocity == "hard" else 0.6
    target_rms = max(hit_rms, 0.03) * trim
    return float(min(target_rms / (rms_v + 1e-12), 4.0))


# --------------------------------------------------------------------------- #
# verification against known ground truth
# --------------------------------------------------------------------------- #
@dataclass
class VerificationReport:
    tolerance_sec: float
    true_hits: int
    detected_hits: int
    matched: int
    missed: List[Event]            # ground-truth hits with no detection
    duplicates: List[Event]        # detections sharing a ground-truth hit
    false_alarms: List[Event]      # detections with no ground-truth hit
    distractors_rejected: int
    distractors_total: int
    velocity_errors: List[Tuple[Event, Event]]
    mean_local_rms_db_change: float
    peak_db_before: float
    peak_db_after: float

    @property
    def recall(self) -> float:
        return self.matched / self.true_hits if self.true_hits else 1.0

    @property
    def precision(self) -> float:
        if not self.detected_hits:
            return 1.0
        return (self.detected_hits - len(self.false_alarms)) / self.detected_hits

    def summary(self) -> str:
        lines = [
            f"tolerance          : {self.tolerance_sec * 1000:.0f} ms",
            f"true / detected    : {self.true_hits} / {self.detected_hits}",
            f"matched            : {self.matched}",
            f"recall / precision : {self.recall:.2%} / {self.precision:.2%}",
            f"missed ({len(self.missed)}): "
            + (", ".join(f"{e.time:.3f}s {e.drum}/{e.velocity}" for e in self.missed) or "-"),
            f"duplicates ({len(self.duplicates)}): "
            + (", ".join(f"{e.time:.3f}s {e.drum}" for e in self.duplicates) or "-"),
            f"false alarms ({len(self.false_alarms)}): "
            + (", ".join(f"{e.time:.3f}s {e.drum}" for e in self.false_alarms) or "-"),
            f"distractors rejected: {self.distractors_rejected}/{self.distractors_total}",
            f"velocity errors ({len(self.velocity_errors)}): "
            + (", ".join(f"{g.time:.3f}s {g.velocity}->{d.velocity}"
                         for g, d in self.velocity_errors) or "-"),
            f"local RMS change   : {self.mean_local_rms_db_change:+.2f} dB (orig->export)",
            f"peak level         : {self.peak_db_before:.2f} -> {self.peak_db_after:.2f} dBFS",
        ]
        return "\n".join(lines)


def verify(ground_truth: List[Event], detections: List[Event],
           original: np.ndarray, rendered: np.ndarray,
           tolerance_sec: float = 0.04) -> VerificationReport:
    truth = [e for e in ground_truth if e.kind == "hit"]
    distractors = [e for e in ground_truth if e.kind == "distractor"]

    # one-to-one nearest matching within tolerance
    pairs = []
    for gi, g in enumerate(truth):
        for di, d in enumerate(detections):
            dt = abs(d.time - g.time)
            if dt <= tolerance_sec and d.drum == g.drum:
                pairs.append((dt, gi, di))
    pairs.sort()

    matched_t, matched_d = set(), set()
    velocity_errors = []
    truth_by_det: Dict[int, Event] = {}
    for _, gi, di in pairs:
        if gi in matched_t or di in matched_d:
            continue
        matched_t.add(gi)
        matched_d.add(di)
        truth_by_det[di] = truth[gi]
        if detections[di].velocity != truth[gi].velocity:
            velocity_errors.append((truth[gi], detections[di]))

    missed = [g for i, g in enumerate(truth) if i not in matched_t]
    false_alarms = [d for i, d in enumerate(detections) if i not in matched_d]

    # duplicates: any detection beyond the first that lands within tolerance
    # of a ground-truth hit (one-to-one matching may have paired it elsewhere,
    # so count directly against the truth list)
    duplicates = []
    for g in truth:
        near = [d for d in detections
                if abs(d.time - g.time) <= tolerance_sec and d.drum == g.drum]
        if len(near) > 1:
            duplicates.extend(near[1:])
    dup_ids = {id(d) for d in duplicates}
    false_alarms = [d for d in false_alarms if id(d) not in dup_ids]

    # distractor rejection: no detection within tolerance of a distractor
    rejected = sum(
        1 for blip in distractors
        if not any(abs(d.time - blip.time) <= tolerance_sec for d in detections)
    )

    rms_change = _local_rms_change(truth, original, rendered)

    return VerificationReport(
        tolerance_sec=tolerance_sec,
        true_hits=len(truth),
        detected_hits=len(detections),
        matched=len(matched_t),
        missed=missed,
        duplicates=duplicates,
        false_alarms=false_alarms,
        distractors_rejected=rejected,
        distractors_total=len(distractors),
        velocity_errors=velocity_errors,
        mean_local_rms_db_change=rms_change,
        peak_db_before=_db(original),
        peak_db_after=_db(rendered),
    )


def _local_rms_change(truth: List[Event], a: np.ndarray, b: np.ndarray) -> float:
    """Mean dB change of RMS measured in 100 ms windows around each hit."""
    win = int(0.1 * SAMPLE_RATE)
    diffs = []
    for ev in truth:
        s = int(ev.time * SAMPLE_RATE)
        sa = a[s:min(len(a), s + win)]
        sb = b[s:min(len(b), s + win)]
        if len(sa) == 0:
            continue
        ra = float(np.sqrt(np.mean(sa ** 2))) + 1e-12
        rb = float(np.sqrt(np.mean(sb ** 2))) + 1e-12
        diffs.append(20 * np.log10(rb / ra))
    return float(np.mean(diffs)) if diffs else 0.0
