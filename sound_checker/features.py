from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .audio import ANALYSIS_SR

HOP = 256
N_FFT = 1024
N_MELS = 32
CONTEXT = 4


@dataclass
class AudioFeatures:
    vector: np.ndarray  # L2-normalized context-spectrogram frames
    raw_logmel: np.ndarray
    times: np.ndarray
    weights: np.ndarray
    onsets: np.ndarray
    onset_strength: np.ndarray
    duration: float
    sample_rate: int = ANALYSIS_SR
    hop: int = HOP


def mel_filterbank(
    sample_rate: int = ANALYSIS_SR,
    n_fft: int = N_FFT,
    n_mels: int = N_MELS,
    fmin: float = 50.0,
    fmax: float | None = 9000.0,
) -> np.ndarray:
    fmax = fmax or sample_rate / 2

    def hz_to_mel(hz: float) -> float:
        return 2595.0 * np.log10(1.0 + hz / 700.0)

    def mel_to_hz(mel: float) -> float:
        return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)

    fft_freqs = np.fft.rfftfreq(n_fft, 1.0 / sample_rate)
    mel_points = np.linspace(hz_to_mel(fmin), hz_to_mel(min(fmax, sample_rate / 2)), n_mels + 2)
    hz_points = mel_to_hz(mel_points)
    fb = np.zeros((n_mels, len(fft_freqs)), dtype=np.float32)
    for m in range(1, n_mels + 1):
        left, center, right = hz_points[m - 1], hz_points[m], hz_points[m + 1]
        rising = (fft_freqs - left) / max(center - left, 1e-6)
        falling = (right - fft_freqs) / max(right - center, 1e-6)
        fb[m - 1] = np.maximum(0.0, np.minimum(rising, falling))
    # Divide by mel bandwidth so wide high-frequency filters do not dominate.
    widths = hz_points[2:] - hz_points[:-2]
    fb /= np.maximum(widths[:, None], 1.0)
    return fb.astype(np.float32)


_MEL_FB = mel_filterbank()


def frame_signal(x: np.ndarray, n_fft: int = N_FFT, hop: int = HOP) -> np.ndarray:
    if len(x) < n_fft:
        x = np.pad(x, (0, n_fft - len(x)))
    n_frames = 1 + (len(x) - n_fft) // hop
    strides = (x.strides[0] * hop, x.strides[0])
    return np.lib.stride_tricks.as_strided(
        x, shape=(n_frames, n_fft), strides=strides, writeable=False
    )


def compute_features(x: np.ndarray, duration: float | None = None) -> AudioFeatures:
    x = np.asarray(x, dtype=np.float32)
    if x.size == 0:
        empty = np.zeros((0, N_MELS * (2 * CONTEXT + 1)), dtype=np.float32)
        return AudioFeatures(empty, np.zeros((0, N_MELS)), np.array([]), np.array([]), np.array([]), np.array([]), 0.0)

    pad = N_FFT // 2
    xp = np.pad(x, (pad, pad), mode="reflect" if len(x) > pad else "edge")
    frames = frame_signal(xp)
    window = np.hanning(N_FFT).astype(np.float32)
    spectrum = np.fft.rfft(frames * window, n=N_FFT, axis=1)
    magnitude = np.abs(spectrum).astype(np.float32)
    mel_energy = magnitude**2 @ _MEL_FB.T
    logmel = (10.0 * np.log10(mel_energy + 1e-8)).astype(np.float32)

    # Gain is approximately an additive constant in log-spectra. Removing the
    # per-frame mel mean makes loudness differences much less important.
    centered = logmel - np.mean(logmel, axis=1, keepdims=True)
    delta = np.gradient(centered, axis=0).astype(np.float32)
    base = np.concatenate([centered, 1.5 * delta], axis=1)

    padded = np.pad(base, ((CONTEXT, CONTEXT), (0, 0)), mode="edge")
    context_frames = np.lib.stride_tricks.sliding_window_view(
        padded, (2 * CONTEXT + 1, base.shape[1])
    )[:, 0, :, :]
    vector = context_frames.reshape(context_frames.shape[0], -1).astype(np.float32)
    norms = np.linalg.norm(vector, axis=1, keepdims=True)
    vector = vector / np.maximum(norms, 1e-6)

    times = np.arange(logmel.shape[0], dtype=np.float32) * HOP / ANALYSIS_SR

    time_frames = frame_signal(x)
    rms = np.sqrt(np.mean(time_frames.astype(np.float64) ** 2, axis=1))
    if rms.shape[0] != logmel.shape[0]:
        min_len = min(rms.shape[0], logmel.shape[0])
        rms = rms[:min_len]
        if logmel.shape[0] > min_len:
            rms = np.pad(rms, (0, logmel.shape[0] - min_len), mode="edge")

    # dB gate: below -48 dBFS is effectively silence; above -24 dBFS gets full
    # energy weight. Percentile normalization makes this fairly stable.
    db = 20.0 * np.log10(rms + 1e-7)
    energy_weight = np.clip((db + 48.0) / 24.0, 0.0, 1.0)

    flux = np.zeros(logmel.shape[0], dtype=np.float32)
    if logmel.shape[0] > 1:
        flux[1:] = np.sum(np.maximum(0.0, np.diff(logmel, axis=0)), axis=1)
    positive_flux = flux[flux > 1e-4]
    flux_median = float(np.median(positive_flux)) if positive_flux.size else 0.0
    flux_p98 = float(np.percentile(flux, 98)) if flux.size else 0.0
    # Subtract the low-level frame-to-frame jitter of a steady tone. Using the
    # 98th percentile as scale keeps isolated transients strong.
    novelty = np.clip(
        (flux - 1.35 * flux_median) / max(0.16 * flux_p98, 1e-3),
        0.0,
        1.0,
    )

    # Steady tones retain only a small floor weight. Their long sustained
    # portion therefore supplies little information mass to the verdict.
    weights = (energy_weight * (0.10 + 0.90 * novelty)).astype(np.float32)

    onsets, onset_strength = find_onsets(flux, energy_weight)
    dur = float(duration if duration is not None and duration > 0 else len(x) / ANALYSIS_SR)
    return AudioFeatures(
        vector=vector,
        raw_logmel=logmel,
        times=times,
        weights=weights,
        onsets=onsets,
        onset_strength=onset_strength,
        duration=dur,
    )


def find_onsets(flux: np.ndarray, energy_weight: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if flux.size < 3:
        return np.array([], dtype=int), flux
    positive = flux[flux > 1e-4]
    median_flux = float(np.median(positive)) if positive.size else 0.0
    p98 = float(np.percentile(flux, 98))
    threshold = max(3.2 * median_flux, 0.10 * p98, 1.0)
    candidates: list[int] = []
    last = -10
    for i in range(2, flux.size - 2):
        local_max = flux[i] == np.max(flux[i - 2 : i + 3])
        if (
            local_max
            and flux[i] >= threshold
            and energy_weight[i] > 0.22
            and i - last >= 5
        ):
            candidates.append(i)
            last = i
    return np.asarray(candidates, dtype=int), flux
