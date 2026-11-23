"""Program-generated reference samples.

Three families, all deterministic:

* ``tone``      - sustained tones across cuts (alignment via waveform);
* ``pulses``    - short impulses deliberately placed next to cuts (gap timing);
* ``mixed``     - tones + pulses + deliberate genuine silence, in segments of
                  different lengths, including a stereo variant.

The genuine silence regions are recorded in the returned manifest so tests can
assert they are never misreported as encoder-inserted blank.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .wavio import write_wav


@dataclass
class GeneratedSample:
    wav_path: Path
    cuts: list[int]
    silence_ranges: list[tuple[int, int]]
    description: str


def _tone(sr: int, dur: float, freq: float = 440.0) -> np.ndarray:
    t = np.arange(int(sr * dur)) / sr
    return (0.5 * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def _pulse_train(
    sr: int, dur: float, pulse_every: int, width: int = 3
) -> np.ndarray:
    n = int(sr * dur)
    x = np.zeros(n, dtype=np.float32)
    for p in range(0, n, pulse_every):
        x[p : p + width] = 0.8
    return x


def _to_stereo(x: np.ndarray) -> np.ndarray:
    right = np.roll(x, 7) * 0.7
    return np.stack([x, right], axis=1)


def generate_all(outdir: Path, sr: int = 48000) -> list[GeneratedSample]:
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    samples: list[GeneratedSample] = []

    # 1. sustained 1.2 s tone, cuts at unequal distances, 3 parts.
    n1 = int(sr * 1.2)
    x1 = _tone(sr, n1 / sr)
    cuts1 = [int(sr * 0.31), int(sr * 0.83)]
    p1 = outdir / "sample_tone.wav"
    write_wav(p1, x1, sr)
    samples.append(
        GeneratedSample(p1, cuts1, [], "sustained 440 Hz tone, unequal parts")
    )

    # 2. 1.5 s pulse train with an impulse ~20 samples after each cut.
    n2 = int(sr * 1.5)
    x2 = _pulse_train(sr, n2 / sr, pulse_every=sr // 8, width=2)
    cuts2 = [int(sr * 0.4), int(sr * 0.4) + 600, int(sr * 1.05)]
    # force a pulse 20 samples after the first cut to expose gap timing
    x2[cuts2[0] + 20 : cuts2[0] + 23] = 0.9
    p2 = outdir / "sample_pulses.wav"
    write_wav(p2, x2, sr)
    samples.append(
        GeneratedSample(
            p2, cuts2, [], "pulse train, impulses adjacent to the seams"
        )
    )

    # 3. mixed: tone + pulses + a REAL silence block, varying part lengths.
    n3 = int(sr * 2.0)
    x3 = 0.3 * np.sin(2 * np.pi * 660 * np.arange(n3) / sr).astype(np.float32)
    for p in range(500, n3, 4000):
        x3[p : p + 2] = 0.7
    sil_start, sil_end = int(sr * 1.25), int(sr * 1.35)
    x3[sil_start:sil_end] = 0.0
    cuts3 = [int(sr * 0.27), int(sr * 0.55), sil_start + 1200, int(sr * 1.7)]
    p3 = outdir / "sample_mixed.wav"
    write_wav(p3, x3, sr)
    samples.append(
        GeneratedSample(
            p3,
            cuts3,
            [(sil_start, sil_end)],
            "tone + pulses + a 100 ms genuine silence block, 4 unequal parts",
        )
    )

    # 4. stereo version of the mixed sample.
    p4 = outdir / "sample_mixed_stereo.wav"
    write_wav(p4, _to_stereo(x3), sr)
    samples.append(
        GeneratedSample(
            p4, cuts3, [(sil_start, sil_end)], "stereo variant of the mixed sample"
        )
    )

    manifest = {
        "sample_rate": sr,
        "samples": [
            {
                "file": str(s.wav_path.name),
                "cuts": s.cuts,
                "silence_ranges": [list(r) for r in s.silence_ranges],
                "description": s.description,
            }
            for s in samples
        ],
    }
    (outdir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return samples
