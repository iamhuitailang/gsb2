"""音频读写、指纹与导出。

- 读取依赖 soundfile (libsndfile), 支持 WAV/FLAC/OGG 等;
- 导出固定为 16-bit PCM WAV, 命名冲突自动加序号, 绝不覆盖任何已有文件
  (也不允许写回源文件路径);
- 每次导出同时写一份 JSON 参数记录。
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from typing import Any

import numpy as np
import soundfile as sf

SUPPORTED_READ_EXTS = {".wav", ".flac", ".ogg", ".oga", ".aiff", ".aif"}
EXPORT_SUFFIX = "_denoised"
RECORD_SUFFIX = "_params.json"


@dataclass
class AudioFile:
    path: str
    data: np.ndarray
    sr: int
    subtype: str

    @property
    def name(self) -> str:
        return os.path.basename(self.path)

    @property
    def duration(self) -> float:
        return self.data.shape[0] / self.sr

    @property
    def channels(self) -> int:
        return 1 if self.data.ndim == 1 else self.data.shape[1]

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "name": self.name,
            "sr": self.sr,
            "channels": self.channels,
            "duration": round(self.duration, 4),
            "samples": int(self.data.shape[0]),
            "sha256": file_sha256(self.path),
        }


def file_sha256(path: str, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            block = f.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def load_audio(path: str) -> AudioFile:
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    ext = os.path.splitext(path)[1].lower()
    if ext not in SUPPORTED_READ_EXTS:
        raise ValueError(f"不支持的格式 {ext}, 支持: {sorted(SUPPORTED_READ_EXTS)}")
    data, sr = sf.read(path, dtype="float64", always_2d=False)
    if data.ndim == 2 and data.shape[1] == 1:
        data = data[:, 0]
    subtype = sf.info(path).subtype
    return AudioFile(path=os.path.abspath(path), data=data, sr=sr, subtype=subtype)


def unique_output_path(src_path: str, out_dir: str) -> str:
    """生成不与任何现有文件冲突的导出 WAV 路径。"""
    base = os.path.splitext(os.path.basename(src_path))[0]
    os.makedirs(out_dir, exist_ok=True)
    candidate = os.path.join(out_dir, f"{base}{EXPORT_SUFFIX}.wav")
    n = 2
    while os.path.exists(candidate):
        candidate = os.path.join(out_dir, f"{base}{EXPORT_SUFFIX}_{n}.wav")
        n += 1
    return candidate


def export_wav(
    y: np.ndarray,
    sr: int,
    src_path: str,
    out_dir: str,
    params: dict[str, Any],
) -> dict[str, str]:
    """导出降噪结果 WAV + 参数记录 JSON, 返回两个路径。

    安全检查: 输出路径绝不能等于源文件路径。
    """
    wav_path = unique_output_path(src_path, out_dir)
    record_path = os.path.splitext(wav_path)[0] + RECORD_SUFFIX
    if os.path.abspath(wav_path) == os.path.abspath(src_path):
        raise RuntimeError("拒绝覆盖原始录音")

    sf.write(wav_path, y, sr, subtype="PCM_16")
    record = {
        "source": {
            "path": os.path.abspath(src_path),
            "sha256": file_sha256(src_path),
        },
        "output": {
            "path": os.path.abspath(wav_path),
            "sha256": file_sha256(wav_path),
        },
        "parameters": params,
    }
    with open(record_path, "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)
    return {"wav": wav_path, "record": record_path}
