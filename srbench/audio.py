"""统一的音频数据模型。"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class AudioData:
    """内存中的音频，一律用 float64，取值范围 [-1, 1]。

    samples 形状固定为 (采样点数, 声道数)，单声道也是 (n, 1)。
    """

    samples: np.ndarray
    sample_rate: int
    name: str = "untitled"
    bit_depth: int | None = None        # 源文件位深；转换后为 None
    sample_format: str = "PCM"          # "PCM" 或 "FLOAT"

    def __post_init__(self) -> None:
        a = np.asarray(self.samples, dtype=np.float64)
        if a.ndim == 1:
            a = a[:, None]
        if a.ndim != 2:
            raise ValueError(f"samples 维度必须是 1 或 2，收到 {a.ndim}")
        self.samples = a
        self.sample_rate = int(self.sample_rate)
        if self.sample_rate <= 0:
            raise ValueError("采样率必须为正整数")

    @property
    def n_frames(self) -> int:
        return int(self.samples.shape[0])

    @property
    def channels(self) -> int:
        return int(self.samples.shape[1])

    @property
    def duration(self) -> float:
        return self.n_frames / self.sample_rate

    def channel(self, index: int) -> np.ndarray:
        return self.samples[:, index]

    def slice_time(self, t0: float, t1: float) -> "AudioData":
        """按时间切片（端点按采样点取整）。"""
        i0 = max(0, int(round(t0 * self.sample_rate)))
        i1 = min(self.n_frames, int(round(t1 * self.sample_rate)))
        return AudioData(
            self.samples[i0:i1].copy(),
            self.sample_rate,
            name=f"{self.name}[{t0:.3f}s-{t1:.3f}s]",
        )
