from __future__ import annotations

import argparse
import wave
from pathlib import Path

import numpy as np

SAMPLE_RATE = 44100


def _pluck(freq: float, duration: float, amp: float = 0.34, brightness: float = 1.0) -> np.ndarray:
    n = int(SAMPLE_RATE * duration)
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE
    attack = np.minimum(1.0, t / 0.008)
    envelope = attack * np.exp(-t * 4.8)
    tone = (
        1.00 * np.sin(2 * np.pi * freq * t)
        + 0.42 * brightness * np.sin(2 * np.pi * freq * 2.01 * t)
        + 0.18 * brightness * np.sin(2 * np.pi * freq * 3.02 * t)
        + 0.07 * np.sin(2 * np.pi * freq * 4.7 * t)
    )
    # A short filtered-noise pick transient gives the matcher real onset evidence.
    rng = np.random.default_rng(int(freq * 1000) % (2**32))
    noise_t = t[t < 0.045]
    noise = rng.standard_normal(noise_t.size) * np.exp(-noise_t * 95)
    tone[: noise.size] += 0.22 * noise
    return (amp * envelope * tone).astype(np.float32)


def _add_note(track: np.ndarray, note: np.ndarray, start: float) -> None:
    i = int(start * SAMPLE_RATE)
    j = min(track.size, i + note.size)
    track[i:j] += note[: j - i]


def _build_main(melody: list[tuple[float, float]], length: float = 2.55) -> np.ndarray:
    track = np.zeros(int(length * SAMPLE_RATE), dtype=np.float32)
    for start, freq in melody:
        _add_note(track, _pluck(freq, 0.72), start)
    # Very quiet room tone/noise floor, unlike complete digital zero.
    rng = np.random.default_rng(14779)
    track += (rng.standard_normal(track.size) * 0.0012).astype(np.float32)
    return track


def _stereoize(x: np.ndarray, width: float = 0.18) -> np.ndarray:
    delay = int(0.006 * SAMPLE_RATE)
    right = np.concatenate([np.zeros(delay, dtype=np.float32), x[:-delay]]) if delay else x
    left_gain = 1.0 - width
    right_gain = 1.0 + width
    stereo = np.stack([x * left_gain, right * right_gain], axis=1)
    peak = np.max(np.abs(stereo))
    if peak > 0.95:
        stereo *= 0.95 / peak
    return stereo


def write_wav(path: Path, data: np.ndarray, sample_rate: int = SAMPLE_RATE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if data.ndim == 1:
        channels = 1
        out = data
    else:
        channels = data.shape[1]
        out = data
    peak = float(np.max(np.abs(out))) if out.size else 0.0
    if peak > 0.999:
        out = out / peak * 0.97
    pcm = np.clip(out, -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm16.tobytes())


def _resample(x: np.ndarray, source_sr: int, target_sr: int) -> np.ndarray:
    new_len = int(round(len(x) * target_sr / source_sr))
    old = np.linspace(0.0, len(x) - 1, len(x))
    new = np.linspace(0.0, len(x) - 1, new_len)
    return np.interp(new, old, x).astype(np.float32)


def _fade(x: np.ndarray, fade_seconds: float = 0.006) -> np.ndarray:
    n = int(fade_seconds * SAMPLE_RATE)
    if x.size > 2 * n:
        x = x.copy()
        x[:n] *= np.linspace(0, 1, n, dtype=np.float32)
        x[-n:] *= np.linspace(1, 0, n, dtype=np.float32)
    return x


def _tone(duration: float = 1.5, freq: float = 440.0, amp: float = 0.22) -> np.ndarray:
    n = int(duration * SAMPLE_RATE)
    t = np.arange(n) / SAMPLE_RATE
    attack = np.minimum(1.0, t / 0.025)
    release = np.minimum(1.0, (duration - t) / 0.08)
    env = attack * np.clip(release, 0, 1)
    return (amp * env * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def generate_sample_set(out_dir: str | Path) -> list[Path]:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    # C5-E5-G5-C6: deliberately more than one transient so matching has evidence.
    main_melody = [
        (0.16, 523.251),
        (0.56, 659.255),
        (0.98, 783.991),
        (1.43, 1046.502),
    ]
    main = _build_main(main_melody, 2.42)
    main_stereo = _stereoize(main)

    paths: list[Path] = []
    p = out / "01_original.wav"
    write_wav(p, main_stereo)
    paths.append(p)

    p = out / "02_volume_plus7dB.wav"
    loud = np.clip(main_stereo * (10 ** (7 / 20)), -0.985, 0.985)
    write_wav(p, loud)
    paths.append(p)

    p = out / "03_volume_minus12dB.wav"
    write_wav(p, main_stereo * 0.251)
    paths.append(p)

    p = out / "04_trimmed_head_tail.wav"
    trimmed = _fade(main[int(0.30 * SAMPLE_RATE): int(1.93 * SAMPLE_RATE)])
    write_wav(p, _stereoize(trimmed))
    paths.append(p)

    p = out / "05_middle_excerpt.wav"
    middle = _fade(main[int(0.50 * SAMPLE_RATE): int(1.55 * SAMPLE_RATE)], 0.008)
    write_wav(p, middle)
    paths.append(p)

    p = out / "06_resaved_mono_22050.wav"
    mono = main_stereo.mean(axis=1)
    write_wav(p, _resample(mono, SAMPLE_RATE, 22050), 22050)
    paths.append(p)

    # Same timbre, tempo and first note, but a different melody after it. This
    # is intentionally the easy false-positive for a coarse spectrum matcher.
    lookalike_melody = [
        (0.16, 523.251),
        (0.56, 440.000),
        (0.98, 698.456),
        (1.43, 587.330),
    ]
    lookalike = _build_main(lookalike_melody, 2.42)
    p = out / "07_lookalike_same_timbre.wav"
    write_wav(p, _stereoize(lookalike))
    paths.append(p)

    # Two files dominated by silence + the same steady tone, at different gain
    # and crop positions. They should not receive a high-confidence verdict.
    tone_a = np.zeros(int(2.7 * SAMPLE_RATE), dtype=np.float32)
    tone_segment = _tone(1.60, 440.0, 0.20)
    start = int(0.45 * SAMPLE_RATE)
    tone_a[start : start + tone_segment.size] = tone_segment
    p = out / "08_steady_tone.wav"
    write_wav(p, tone_a)
    paths.append(p)

    tone_b = np.zeros(int(2.25 * SAMPLE_RATE), dtype=np.float32)
    tone_segment = _tone(1.42, 440.0, 0.11)
    start = int(0.18 * SAMPLE_RATE)
    tone_b[start : start + tone_segment.size] = tone_segment
    p = out / "09_steady_tone_quiet_trim.wav"
    write_wav(p, tone_b)
    paths.append(p)

    return paths


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate local synthetic audio sample set")
    parser.add_argument("--out", default="samples", help="output directory (default: samples)")
    args = parser.parse_args()
    paths = generate_sample_set(args.out)
    print(f"Generated {len(paths)} files in {Path(args.out).resolve()}")
    for p in paths:
        print(f" - {p.name}")


if __name__ == "__main__":
    main()
