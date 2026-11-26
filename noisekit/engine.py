"""处理引擎: 加载缓存、降噪计算缓存、批量应用与导出。

批量处理逐个文件 try/except, 单文件失败只记录错误, 不影响其余文件。
"""

from __future__ import annotations

import os
from collections import OrderedDict
from typing import Any

import numpy as np

from . import ALGO_VERSION
from .audioio import AudioFile, export_wav, file_sha256, load_audio
from .dsp import analyze_noise_segment, denoise, rms


class Engine:
    def __init__(self, cache_size: int = 6):
        self._audio: OrderedDict[str, AudioFile] = OrderedDict()
        self._proc_cache: OrderedDict[str, tuple[str, np.ndarray]] = OrderedDict()
        self._cache_size = cache_size

    # ------------------------------------------------------------------ #
    def load(self, path: str) -> AudioFile:
        ap = os.path.abspath(path)
        if ap in self._audio:
            self._audio.move_to_end(ap)
            return self._audio[ap]
        af = load_audio(ap)
        self._audio[ap] = af
        if len(self._audio) > self._cache_size:
            old, _ = self._audio.popitem(last=False)
            self._proc_cache.pop(old, None)
        return af

    def get(self, path: str) -> AudioFile:
        return self._audio[os.path.abspath(path)]

    def loaded_files(self) -> list[AudioFile]:
        return list(self._audio.values())

    # ------------------------------------------------------------------ #
    def analyze(self, path: str, start: float, end: float) -> dict[str, Any]:
        af = self.load(path)
        result = analyze_noise_segment(af.data, af.sr, start, end)
        result["file"] = af.to_dict()
        result["region"] = {"start": start, "end": end}
        return result

    @staticmethod
    def param_key(params: dict[str, Any]) -> str:
        keys = (
            "strength",
            "smoothing",
            "protect_transient",
            "protect_voice",
            "n_fft",
            "region_start",
            "region_end",
        )
        return "|".join(str(params.get(k)) for k in keys)

    def process(
        self,
        path: str,
        noise: dict[str, Any],
        params: dict[str, Any],
    ) -> np.ndarray:
        """按参数降噪, 同参数命中缓存。noise 为 analyze() 的返回。"""
        ap = os.path.abspath(path)
        af = self.load(ap)
        key = self.param_key(params)
        cached = self._proc_cache.get(ap)
        if cached is not None and cached[0] == key:
            return cached[1]

        y = denoise(
            af.data,
            af.sr,
            noise["profile"],
            n_fft=int(params["n_fft"]),
            strength=float(params["strength"]),
            smoothing=float(params["smoothing"]),
            protect_transient=bool(params["protect_transient"]),
            protect_voice=bool(params["protect_voice"]),
        )
        self._proc_cache[ap] = (key, y)
        if len(self._proc_cache) > self._cache_size:
            self._proc_cache.popitem(last=False)
        return y

    def metrics(self, path: str, y: np.ndarray) -> dict[str, float]:
        af = self.get(path)
        diff = af.data - y
        return {
            "rms_before_db": round(20 * np.log10(rms(af.data) + 1e-12), 2),
            "rms_after_db": round(20 * np.log10(rms(y) + 1e-12), 2),
            "removed_rms_db": round(20 * np.log10(rms(diff) + 1e-12), 2),
        }

    # ------------------------------------------------------------------ #
    def export_one(
        self,
        path: str,
        out_dir: str,
        noise: dict[str, Any],
        params: dict[str, Any],
    ) -> dict[str, Any]:
        af = self.load(path)
        y = self.process(path, noise, params)
        record_params = {
            "algo": "spectral-subtraction-gated",
            "algo_version": ALGO_VERSION,
            "n_fft": int(params["n_fft"]),
            "hop": int(params["n_fft"]) // 2,
            "strength": round(float(params["strength"]), 4),
            "smoothing": round(float(params["smoothing"]), 4),
            "protect_transient": bool(params["protect_transient"]),
            "protect_voice": bool(params["protect_voice"]),
            "noise_sample": noise.get("region"),
            "noise_stats": {
                k: noise[k]
                for k in ("flatness", "crest", "zcr", "occupancy", "speech_suspected")
                if k in noise
            },
        }
        paths = export_wav(y, af.sr, af.path, out_dir, record_params)
        return {
            "file": af.name,
            "status": "ok",
            "outputs": paths,
            "metrics": self.metrics(path, y),
            "params": record_params,
        }

    def batch_export(
        self,
        jobs: list[dict[str, Any]],
        out_dir: str,
    ) -> list[dict[str, Any]]:
        """jobs: [{path, noise, params}]; 单文件失败被捕获, 不影响其他文件。"""
        results = []
        for job in jobs:
            try:
                results.append(
                    self.export_one(job["path"], out_dir, job["noise"], job["params"])
                )
            except Exception as exc:  # 隔离单文件失败
                results.append(
                    {
                        "file": os.path.basename(job["path"]),
                        "status": "error",
                        "error": f"{type(exc).__name__}: {exc}",
                    }
                )
        return results

    def verify_source(self, path: str, expected_sha: str) -> bool:
        return os.path.isfile(path) and file_sha256(path) == expected_sha
