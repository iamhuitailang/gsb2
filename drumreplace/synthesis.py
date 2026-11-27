"""Procedural audio synthesis: practice-drum source + clean replacement samples.

Everything is generated locally with numpy; no external audio assets are needed.

The generated practice track deliberately contains:
  * two hit classes  -- kick (low thump) and snare (crackle + tone);
  * both velocities  -- "hard" and "soft", including consecutive rolls and
    closely spaced / overlapping hits;
  * a continuous bass line underneath ("混有底音");
  * short blips that must NOT be detected as hits (non-trigger distractors).

Replacement samples are cleaner/snappier versions of the same two classes,
each with hard/soft variants so the replayer can match original dynamics.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import List

import numpy as np

SAMPLE_RATE = 44100


# --------------------------------------------------------------------------- #
# data model
# --------------------------------------------------------------------------- #
@dataclass
class Event:
    """One ground-truth or detected hit."""

    time: float          # seconds, onset position
    drum: str            # "kick" | "snare"
    velocity: str        # "hard" | "soft"
    kind: str = "hit"    # "hit" | "distractor"
    amp: float = 1.0     # ground-truth rendering amplitude (for reference)

    def as_row(self) -> dict:
        return asdict(self)


# --------------------------------------------------------------------------- #
# small building blocks
# --------------------------------------------------------------------------- #
def _env(n: int, attack: float, decay_tau: float) -> np.ndarray:
    """Attack/exp-decay envelope, n samples long."""
    a = max(1, int(attack * SAMPLE_RATE))
    e = np.ones(n, dtype=np.float64)
    e[:a] = np.linspace(0.0, 1.0, a)
    idx = np.arange(n - a)
    e[a:] = np.exp(-idx / max(1.0, decay_tau * SAMPLE_RATE))
    return e


def _pitched(times: np.ndarray, f0: float, f1: float) -> np.ndarray:
    """Sine whose pitch glides f0 -> f1 over `times` seconds."""
    if f0 == f1:
        return np.sin(2 * np.pi * f0 * times)
    k = (f1 - f0) / times[-1]
    phase = 2 * np.pi * (f0 * times + 0.5 * k * times**2)
    return np.sin(phase)


def _noise(n: int) -> np.ndarray:
    return np.random.default_rng(0).standard_normal(n)


# --------------------------------------------------------------------------- #
# source-drum voices (slightly dull/boomy practice-pad flavour)
# --------------------------------------------------------------------------- #
def synth_kick(velocity: str = "hard") -> np.ndarray:
    dur = 0.34
    n = int(dur * SAMPLE_RATE)
    t = np.arange(n) / SAMPLE_RATE
    body = _pitched(t, 110.0, 42.0)
    click = 0.35 * np.sin(2 * np.pi * 900 * t) * np.exp(-t / 0.004)
    env = _env(n, attack=0.001, decay_tau=0.11)
    sig = (body + click) * env
    return sig * (0.95 if velocity == "hard" else 0.42)


def synth_snare(velocity: str = "hard") -> np.ndarray:
    dur = 0.28
    n = int(dur * SAMPLE_RATE)
    t = np.arange(n) / SAMPLE_RATE
    tone = _pitched(t, 190.0, 150.0)
    noise = _noise(n)
    env_tone = _env(n, attack=0.001, decay_tau=0.05)
    env_noise = _env(n, attack=0.001, decay_tau=0.09)
    sig = 0.55 * tone * env_tone + 0.9 * noise * env_noise
    return sig * (0.85 if velocity == "hard" else 0.36)


def synth_bass_note() -> np.ndarray:
    """Long low bass note: sustained energy below 120 Hz, no sharp attack."""
    dur = 0.9
    n = int(dur * SAMPLE_RATE)
    t = np.arange(n) / SAMPLE_RATE
    sig = np.sin(2 * np.pi * 65 * t) + 0.4 * np.sin(2 * np.pi * 98 * t)
    env = _env(n, attack=0.06, decay_tau=0.35)  # slow attack -> no onset
    return 0.16 * sig * env


# --------------------------------------------------------------------------- #
# distractors: short blips that should not trigger hit detection
# --------------------------------------------------------------------------- #
def synth_click() -> np.ndarray:
    """Tiny ~8 ms transient: far shorter than any real drum hit."""
    n = int(0.008 * SAMPLE_RATE)
    t = np.arange(n) / SAMPLE_RATE
    return 0.28 * np.sin(2 * np.pi * 2500 * t) * np.exp(-t / 0.002)


def synth_blip() -> np.ndarray:
    """Soft 14 ms filtered-noise blip, low energy."""
    n = int(0.014 * SAMPLE_RATE)
    t = np.arange(n) / SAMPLE_RATE
    return 0.18 * _noise(n) * np.exp(-t / 0.005)


# --------------------------------------------------------------------------- #
# clean replacement samples (snappier, wider-band, cleaner decay)
# --------------------------------------------------------------------------- #
def clean_kick(velocity: str = "hard") -> np.ndarray:
    dur = 0.40
    n = int(dur * SAMPLE_RATE)
    t = np.arange(n) / SAMPLE_RATE
    body = _pitched(t, 130.0, 45.0)
    sub = 0.6 * np.sin(2 * np.pi * 48 * t)
    click = 0.5 * np.sin(2 * np.pi * 1500 * t) * np.exp(-t / 0.003)
    env = _env(n, attack=0.0005, decay_tau=0.09)
    sig = (body + sub + click) * env
    return sig * (0.9 if velocity == "hard" else 0.4)


def clean_snare(velocity: str = "hard") -> np.ndarray:
    dur = 0.32
    n = int(dur * SAMPLE_RATE)
    t = np.arange(n) / SAMPLE_RATE
    tone = _pitched(t, 210.0, 170.0)
    noise = _noise(n + 2000)[2000:]  # independent noise stream vs. source
    env_tone = _env(n, attack=0.0005, decay_tau=0.045)
    env_noise = _env(n, attack=0.0005, decay_tau=0.07)
    sig = 0.6 * tone * env_tone + 1.0 * noise * env_noise
    return sig * (0.85 if velocity == "hard" else 0.38)


def build_sample_library() -> dict:
    """Return {(drum, velocity): float64 waveform}, peak-normalised."""
    raw = {
        ("kick", "hard"): clean_kick("hard"),
        ("kick", "soft"): clean_kick("soft"),
        ("snare", "hard"): clean_snare("hard"),
        ("snare", "soft"): clean_snare("soft"),
    }
    return {k: v / np.max(np.abs(v)) for k, v in raw.items()}


# --------------------------------------------------------------------------- #
# scene assembly
# --------------------------------------------------------------------------- #
def build_practice_scene() -> tuple[np.ndarray, List[Event]]:
    """Render the full practice track and its ground-truth event list.

    Layout (all times in seconds):
      0.5 - 5.5  bass line underneath everything;
      kicks and snares interleaved, including velocity rolls, same-class
      overlaps (0.06 s gap), a kick/snare overlap (same instant), and two
      distractors that detection must reject.
    """
    events: List[Event] = [
        # --- kicks: isolated hard/soft, then a soft->hard roll ------------
        Event(0.80, "kick", "hard"),
        Event(1.30, "kick", "soft"),
        Event(1.80, "kick", "hard"),
        Event(2.30, "kick", "soft"),
        Event(2.42, "kick", "soft"),     # close roll, 120 ms spacing
        Event(2.54, "kick", "hard"),     # three-in-a-row velocity change
        # --- overlapping kicks (60 ms gap: tails overlap) -----------------
        Event(3.00, "kick", "hard"),
        Event(3.06, "kick", "soft"),
        # --- snares -------------------------------------------------------
        Event(3.60, "snare", "hard"),
        Event(4.10, "snare", "soft"),
        Event(4.60, "snare", "hard"),
        Event(5.10, "snare", "soft"),
        Event(5.22, "snare", "hard"),    # snare roll
        Event(5.34, "snare", "soft"),
        # --- cross-class overlap: kick + snare at the same instant --------
        Event(5.90, "kick", "hard"),
        Event(5.90, "snare", "soft"),
        # --- later isolated hits ------------------------------------------
        Event(6.50, "snare", "hard"),
        Event(7.00, "kick", "soft"),
        Event(7.50, "snare", "soft"),
        # --- distractors: must NOT be reported ----------------------------
        Event(2.75, "click", "hard", kind="distractor"),
        Event(6.20, "blip", "hard", kind="distractor"),
    ]

    duration = 8.2
    mix = np.zeros(int(duration * SAMPLE_RATE), dtype=np.float64)

    # bass bed: quarter-like long notes across the first ~6 s
    bass = synth_bass_note()
    for bt in np.arange(0.0, 6.0, 0.9):
        _place(mix, bass, bt)

    voices = {
        ("kick", "hard"): synth_kick("hard"),
        ("kick", "soft"): synth_kick("soft"),
        ("snare", "hard"): synth_snare("hard"),
        ("snare", "soft"): synth_snare("soft"),
        "click": synth_click(),
        "blip": synth_blip(),
    }

    for ev in events:
        if ev.kind == "distractor":
            voice = voices[ev.drum]  # drum holds "click"/"blip" here
        else:
            voice = voices[(ev.drum, ev.velocity)]
            ev.amp = float(np.max(np.abs(voice)))
        _place(mix, voice, ev.time)

    # gentle room-like ambience so it isn't sterile
    rng = np.random.default_rng(42)
    mix += 0.004 * rng.standard_normal(len(mix))

    # keep headroom; record nothing above 0.95
    peak = np.max(np.abs(mix))
    if peak > 0.95:
        mix *= 0.95 / peak
    return mix.astype(np.float64), events


def _place(buf: np.ndarray, voice: np.ndarray, at_sec: float) -> None:
    """Add `voice` into `buf` at `at_sec`; tail beyond buffer end is dropped."""
    start = int(round(at_sec * SAMPLE_RATE))
    end = min(len(buf), start + len(voice))
    if start < 0 or start >= len(buf):
        return
    buf[start:end] += voice[: end - start]
