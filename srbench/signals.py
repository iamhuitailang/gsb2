"""可复现的测试信号：短促脉冲、双声道脉冲、高频正弦、对数扫频、噪声。

所有生成函数都带 seed/deterministic 参数，参数固定则波形逐采样一致。
"""

from __future__ import annotations

import numpy as np

from .audio import AudioData


def _time_axis(n_frames: int, sample_rate: int) -> np.ndarray:
    return np.arange(n_frames, dtype=np.float64) / sample_rate


def impulse(
    sample_rate: int = 48000,
    duration: float = 0.05,
    impulse_at: float = 0.01,
    channels: int = 1,
    amplitude: float = 0.9,
) -> AudioData:
    """短促脉冲：单个 +1 采样（双声道时左右脉冲放在同一时刻）。"""
    n = max(8, int(round(duration * sample_rate)))
    x = np.zeros((n, channels), dtype=np.float64)
    idx = min(n - 1, max(0, int(round(impulse_at * sample_rate))))
    x[idx, :] = amplitude
    return AudioData(x, sample_rate, name=f"impulse_{sample_rate}Hz_{channels}ch")


def stereo_staggered_impulse(
    sample_rate: int = 48000,
    duration: float = 0.05,
    left_at: float = 0.01,
    right_at: float | None = None,
    amplitude: float = 0.9,
) -> AudioData:
    """双声道脉冲：左右脉冲时刻可不同（默认同刻），用来检验声道是否错位。"""
    n = max(8, int(round(duration * sample_rate)))
    x = np.zeros((n, 2), dtype=np.float64)
    il = min(n - 1, max(0, int(round(left_at * sample_rate))))
    if right_at is None:
        ir = il
    else:
        ir = min(n - 1, max(0, int(round(right_at * sample_rate))))
    x[il, 0] = amplitude
    x[ir, 1] = amplitude * 0.8
    return AudioData(x, sample_rate, name=f"stereo_impulse_{sample_rate}Hz")


def sine_tone(
    frequency: float,
    sample_rate: int = 48000,
    duration: float = 1.0,
    channels: int = 1,
    amplitude: float = 0.6,
    phase: float = 0.0,
) -> AudioData:
    """稳态正弦。用高频正弦（超过目标 Nyquist）下采样可直接看到混叠成假低音。"""
    n = max(8, int(round(duration * sample_rate)))
    t = _time_axis(n, sample_rate)
    mono = amplitude * np.sin(2 * np.pi * frequency * t + phase)
    x = np.repeat(mono[:, None], channels, axis=1)
    return AudioData(x, sample_rate, name=f"sine_{frequency:g}Hz_{sample_rate}Hz_{channels}ch")


def stereo_dual_tone(
    left_freq: float = 1000.0,
    right_freq: float = 3000.0,
    sample_rate: int = 48000,
    duration: float = 1.0,
    amplitude: float = 0.5,
) -> AudioData:
    """双声道两个不同频率，转换后左右都要能对上自己的峰。"""
    n = max(8, int(round(duration * sample_rate)))
    t = _time_axis(n, sample_rate)
    x = np.zeros((n, 2), dtype=np.float64)
    x[:, 0] = amplitude * np.sin(2 * np.pi * left_freq * t)
    x[:, 1] = amplitude * np.sin(2 * np.pi * right_freq * t)
    return AudioData(x, sample_rate, name=f"dual_tone_L{left_freq:g}_R{right_freq:g}")


def log_chirp(
    f0: float = 20.0,
    f1: float = 20000.0,
    sample_rate: int = 48000,
    duration: float = 2.0,
    channels: int = 1,
    amplitude: float = 0.5,
) -> AudioData:
    """对数扫频：一次覆盖整个频段，频谱图上能直观看到混叠折叠点。"""
    n = max(16, int(round(duration * sample_rate)))
    t = _time_axis(n, sample_rate)
    # 瞬时频率指数变化，相位为其积分
    phase = 2 * np.pi * f0 * duration / np.log(f1 / f0) * (np.exp(np.log(f1 / f0) * t / duration) - 1)
    mono = amplitude * np.sin(phase)
    x = np.repeat(mono[:, None], channels, axis=1)
    return AudioData(x, sample_rate, name=f"chirp_{f0:g}-{f1:g}_{sample_rate}Hz")


def white_noise(
    sample_rate: int = 48000,
    duration: float = 1.0,
    channels: int = 1,
    amplitude: float = 0.3,
    seed: int = 14765,
) -> AudioData:
    """白噪声（固定种子，可复现），用于看宽带高频在下采样后的整体折叠。"""
    rng = np.random.default_rng(seed)
    n = max(8, int(round(duration * sample_rate)))
    x = rng.normal(0.0, amplitude, size=(n, channels))
    return AudioData(x, sample_rate, name=f"noise_{sample_rate}Hz_seed{seed}")


# GUI/CLI 里展示的预设
PRESETS = {
    "impulse": "短促脉冲（检验峰值对齐与滤波拖尾）",
    "stereo_impulse": "双声道脉冲（左右同刻，检验声道不错位）",
    "sine_high": "高频正弦 18kHz @48k（降到 22.05k 必混叠成假低音）",
    "sine_near_nyq": "临界正弦 23.5kHz @48k（目标 44.1k 时在通带边缘）",
    "dual_tone": "双声道双音 1k/3k（左右频率不同）",
    "chirp": "对数扫频 20Hz-20kHz（全频段折叠可视化）",
    "noise": "白噪声（宽带高频整体折叠）",
}


def build_preset(key: str) -> AudioData:
    if key == "impulse":
        return impulse()
    if key == "stereo_impulse":
        return stereo_staggered_impulse()
    if key == "sine_high":
        return sine_tone(18000.0, sample_rate=48000, duration=1.0)
    if key == "sine_near_nyq":
        return sine_tone(23500.0, sample_rate=48000, duration=1.0)
    if key == "dual_tone":
        return stereo_dual_tone()
    if key == "chirp":
        return log_chirp()
    if key == "noise":
        return white_noise()
    raise ValueError(f"未知预设: {key}")
