"""wav 读写。内部统一使用 float64、形状 (帧数, 声道数)。"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf


def read_wav(path: str | Path) -> tuple[np.ndarray, int]:
    """读取 wav, 返回 (data[shape=(N, C), dtype=float64], sample_rate)。

    单声道文件也返回二维 (N, 1), 方便上层统一处理。
    """
    data, sr = sf.read(str(path), always_2d=True, dtype="float64")
    return np.asarray(data, dtype=np.float64), int(sr)


def write_wav(path: str | Path, data: np.ndarray, sr: int,
              subtype: str = "PCM_16") -> None:
    """写 wav。subtype 取 soundfile 支持的 PCM_16/PCM_24/PCM_32/FLOAT 等。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), data, sr, subtype=subtype)


def pcm16_codes(data: np.ndarray) -> np.ndarray:
    """把 float 波形量化成 int16 编码, 用于逐样本比对两次写盘是否一致。"""
    scaled = np.round(np.clip(data, -1.0, 1.0) * 32768.0)
    return scaled.astype(np.int16)
