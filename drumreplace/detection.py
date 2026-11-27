"""Onset detection, drum classification and velocity estimation.

Pure-numpy pipeline (no scipy dependency):

  1. STFT -> spectral-flux onset envelope, peak-picked against an adaptive
     threshold to get candidate hit positions.
  2. Each candidate is classified kick vs snare from low/high-band energy.
  3. Short blips are rejected by a duration gate (sustained energy after the
     onset): real drums ring for 50 ms+, distractors die in < ~20 ms.
  4. Hard/soft velocity is estimated from local peak energy, calibrated
     against the track's own energy distribution.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

import numpy as np

from .synthesis import SAMPLE_RATE, Event

FRAME = 1024
HOP = 256                       # ~5.8 ms per frame at 44.1 kHz
N_FFT = 1024
KICK_BAND_HZ = 150.0
SNARE_BAND_HZ = 350.0


@dataclass
class DetectionParams:
    flux_threshold: float = 1.8      # adaptive threshold multiplier (over MAD)
    min_gap_sec: float = 0.018       # only near-coincident frames are merged;
                                     # distinct rolls stay separate because the
                                     # sharpness/energy gates already reject
                                     # decay echoes and bass swells
    blip_energy_ratio: float = 0.06  # candidates below this fraction of the
                                     # strongest hit are non-trigger blips
    sharpness: float = 1.8           # peak / flux two frames later: a drum
                                     # spike decays within ~12 ms, a bass
                                     # swell stays elevated and fails this
    hard_ratio: float = 0.45         # energy fraction of track max -> "hard";
                                     # sits in the wide gap between the soft
                                     # group (<= 0.24) and hard group (>= 0.64)


# --------------------------------------------------------------------------- #
# STFT (numpy only)
# --------------------------------------------------------------------------- #
def _stft(x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    window = np.hanning(N_FFT)
    frames = 1 + (len(x) - FRAME) // HOP
    spec = np.empty((frames, N_FFT // 2 + 1), dtype=np.float64)
    times = np.empty(frames)
    for i in range(frames):
        start = i * HOP
        seg = x[start:start + FRAME] * window
        spec[i] = np.abs(np.fft.rfft(seg, N_FFT))
        times[i] = (start + FRAME // 2) / SAMPLE_RATE
    return spec, times


def _band_energy(spec_frame: np.ndarray, f_lo: float, f_hi: float) -> float:
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / SAMPLE_RATE)
    mask = (freqs >= f_lo) & (freqs < f_hi)
    return float(np.sum(spec_frame[mask] ** 2))


# --------------------------------------------------------------------------- #
# onset envelope + peak picking
# --------------------------------------------------------------------------- #
def spectral_flux(spec: np.ndarray) -> np.ndarray:
    """Half-wave-rectified positive spectral difference, summed per frame.

    Normalised per frame by total spectral energy so that the decay ring of a
    loud drum doesn't read as a string of new onsets.
    """
    diff = np.diff(spec, axis=0, prepend=spec[:1])
    flux = np.sum(np.maximum(diff, 0.0), axis=1)
    energy = np.sum(spec, axis=1) + 1e-12
    return flux / energy


def _pick_peaks(env: np.ndarray, times: np.ndarray,
                p: DetectionParams, spec: np.ndarray,
                x: np.ndarray) -> tuple[List[int], List[int]]:
    """Adaptive-threshold local maxima with sharpness gate and NMS.

    Pipeline, in order:
      * global adaptive threshold (MAD based) and local-maximum test;
      * sharpness: within two frames (~12 ms) flux must fall below
        peak / `sharpness` -- drum spikes decay fast, bass swells don't;
      * chronological NMS at min_gap within the *same* class, keeping the
        strongest frame. A kick and a snare at the same instant both survive.

    The blip/energy gate is applied later in detect_hits once the full energy
    range is known. Returns (accepted frames, NMS-suppressed frames).
    """
    med = np.median(env)
    mad = np.median(np.abs(env - med)) + 1e-12
    threshold = med + p.flux_threshold * mad * 1.4826
    min_gap_frames = max(1, int(p.min_gap_sec / (HOP / SAMPLE_RATE)))

    candidates = []
    for i in range(1, len(env) - 2):
        if not (env[i] >= threshold and env[i] >= env[i - 1]
                and env[i] >= env[i + 1]):
            continue
        if env[i] < p.sharpness * env[i + 2]:
            continue  # broad swell (bass), not a transient
        candidates.append((i, _classify(spec, i)))

    # chronological same-class NMS: keep the strongest peak in each cluster
    candidates.sort(key=lambda c: c[0])
    accepted: List[tuple[int, str]] = []
    suppressed: List[int] = []
    for i, cls in candidates:
        if times[i] < 0.05:
            suppressed.append(i)  # file-head edge: no hits in first 50 ms
            continue
        if accepted and cls == accepted[-1][1] \
                and i - accepted[-1][0] < min_gap_frames:
            if env[i] > env[accepted[-1][0]]:
                suppressed.append(accepted[-1][0])
                accepted[-1] = (i, cls)
            else:
                suppressed.append(i)
            continue
        accepted.append((i, cls))
    return [i for i, _ in accepted], suppressed


# --------------------------------------------------------------------------- #
# onset refinement and band-specific energy
# --------------------------------------------------------------------------- #
def _classify(spec: np.ndarray, frame_idx: int) -> str:
    """Kick vs snare from the spectral balance at the onset frame.

    Snare noise is broadband and carries substantial energy above 2 kHz;
    a kick's energy is concentrated below 150 Hz. Compare high-band against
    low-band energy rather than lumping mid+high together.
    """
    f = spec[frame_idx]
    low = _band_energy(f, 20.0, KICK_BAND_HZ)
    high = _band_energy(f, 2000.0, 8000.0)
    return "snare" if high > 0.55 * low else "kick"


def _refine_onset(x: np.ndarray, frame_time: float) -> float:
    """Snap a frame-grid detection to the actual waveform onset (sub-frame).

    Search +/- one frame for the first sample whose short-window energy jumps
    above 20% of the local peak energy; fall back to the frame time.
    """
    center = int(frame_time * SAMPLE_RATE)
    radius = HOP
    lo, hi = max(0, center - radius), min(len(x), center + radius)
    win = max(8, int(0.003 * SAMPLE_RATE))
    energies = np.array([
        np.mean(x[s:s + win] ** 2) for s in range(lo, max(lo, hi - win))
    ])
    if len(energies) < 4:
        return frame_time
    peak = energies.max()
    over = np.flatnonzero(energies > 0.2 * peak)
    if len(over) == 0:
        return frame_time
    return (lo + over[0]) / SAMPLE_RATE


def _high_band_flux(spec: np.ndarray) -> np.ndarray:
    """Spectral flux restricted to the 2-8 kHz snare/crack band."""
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / SAMPLE_RATE)
    mask = (freqs >= 2000) & (freqs < 8000)
    band = spec[:, mask]
    diff = np.diff(band, axis=0, prepend=band[:1])
    return np.sum(np.maximum(diff, 0.0), axis=1)


def _resolve_overlaps(peak_frames: List[int], spec: np.ndarray,
                      high_flux: np.ndarray, p: DetectionParams) -> List[int]:
    """Flag kick frames that also carry a high-band (snare) transient.

    When kick and snare strike together, low-band energy dominates the frame
    classifier and the snare is hidden; a simultaneous high-band flux spike at
    that frame reveals it. A negative sentinel (``-fi-1``) means "add a snare
    twin at this same frame", which detect_hits expands into two events.
    """
    med = np.median(high_flux)
    mad = np.median(np.abs(high_flux - med)) + 1e-12
    hi_thr = med + p.flux_threshold * mad * 1.4826
    twins = []
    for fi in peak_frames:
        if _classify(spec, fi) != "kick":
            continue
        if high_flux[max(0, fi - 1):fi + 2].max() >= hi_thr:
            twins.append(-fi - 1)
    return twins


def detect_hits(x: np.ndarray,
                params: Optional[DetectionParams] = None) -> List[Event]:
    """Return detected hit events (distractors excluded). Velocity filled in."""
    p = params or DetectionParams()
    spec, times = _stft(x)
    flux = spectral_flux(spec)
    peak_frames, suppressed = _pick_peaks(flux, times, p, spec, x)

    # roll recovery: a frame suppressed by same-class NMS is re-accepted as a
    # separate hit when its flux is a substantial fraction of the winning
    # frame's -- a weak neighbour in a roll is real, a decay echo is not.
    recovered = []
    for fi in suppressed:
        if times[fi] < 0.05:
            continue
        nearby = [j for j in peak_frames if abs(j - fi) <= 6]
        if nearby and flux[fi] >= 0.55 * max(flux[j] for j in nearby):
            recovered.append(fi)
    peak_frames = sorted(set(peak_frames) | set(recovered))

    # overlap resolution: kick frames carrying a high-band transient get a
    # companion snare event at the same onset
    high_flux = _high_band_flux(spec)
    twins = _resolve_overlaps(peak_frames, spec, high_flux, p)
    extra_frames = [abs(f) - 1 if f < 0 else f for f in twins]
    twin_same_frame = {abs(f) - 1 for f in twins if f < 0}

    peak_frames = sorted(set(peak_frames) | set(extra_frames))

    raw: List[tuple[Event, float, float]] = []
    seen: set = set()
    for fi in peak_frames:
        onset_time = _refine_onset(x, float(times[fi]))
        onset_sample = int(onset_time * SAMPLE_RATE)
        drum = _classify(spec, fi)
        key = (round(onset_time, 3), drum)
        if key in seen:
            continue
        seen.add(key)
        ev = Event(time=onset_time, drum=drum, velocity="")
        raw.append((ev, _class_energy(x, onset_sample, drum), float(flux[fi])))
        # forced snare twin at a kick-dominated overlap frame: judge it on
        # high-band energy alone so the kick's low end can't inflate it
        if fi in twin_same_frame:
            ev2 = Event(time=onset_time, drum="snare", velocity="")
            raw.append((ev2, _class_energy(x, onset_sample, "snare"),
                        float(high_flux[fi])))

    if not raw:
        return []

    # velocity thresholds are calibrated per drum class so an overlap never
    # borrows the other drum's level
    events: List[Event] = []
    for drum in ("kick", "snare"):
        group = sorted(((ev, e, fx) for ev, e, fx in raw if ev.drum == drum),
                       key=lambda t: t[0].time)
        if not group:
            continue
        emax = max(e for _, e, _ in group)
        for k, (ev, e, fx) in enumerate(group):
            if e < p.blip_energy_ratio * emax:
                continue
            hard = e >= p.hard_ratio * emax
            # a close follower (<80 ms) of a hard same-class hit sits inside
            # the predecessor's ring, so band energy is contaminated. The
            # onset flux is ring-free: a follower whose flux is under 60% of
            # the predecessor's is the softer stroke of an overlap.
            if hard and k > 0:
                prev_ev, prev_e, prev_fx = group[k - 1]
                prev_hard = prev_e >= p.hard_ratio * emax
                if ev.time - prev_ev.time < 0.08 and prev_hard \
                        and fx < 0.6 * prev_fx:
                    hard = False
            ev.velocity = "hard" if hard else "soft"
            events.append(ev)
    events.sort(key=lambda e: e.time)
    return events


def _class_energy(x: np.ndarray, onset_sample: int, drum: str) -> float:
    """Mean squared energy in the drum's characteristic band (50 ms window)."""
    win = int(0.05 * SAMPLE_RATE)
    seg = x[onset_sample:min(len(x), onset_sample + win)]
    if len(seg) == 0:
        return 0.0
    spec_f = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    freqs = np.fft.rfftfreq(len(seg), 1.0 / SAMPLE_RATE)
    if drum == "kick":
        mask = freqs < KICK_BAND_HZ
    else:
        mask = freqs >= SNARE_BAND_HZ
    return float(np.mean(spec_f[mask] ** 2))
