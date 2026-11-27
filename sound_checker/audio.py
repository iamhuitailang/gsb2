from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

ANALYSIS_SR = 22050
PEAK_BUCKETS = 1400


class AudioReadError(Exception):
    """Raised when a file cannot be decoded or probed."""


@dataclass
class AudioData:
    samples: np.ndarray
    sample_rate: int
    original_sample_rate: int
    channels: int
    duration: float
    peaks: dict[str, list[float]]


def sha256_file(path: str | Path, chunk_size: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(chunk_size), b""):
            h.update(chunk)
    return h.hexdigest()


def ffprobe_available() -> bool:
    return shutil.which("ffprobe") is not None


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def probe_audio(path: str | Path) -> dict[str, Any]:
    """Return original container metadata without resampling it."""
    path = Path(path)
    if not path.exists():
        raise AudioReadError(f"文件不存在: {path}")
    if not path.is_file():
        raise AudioReadError(f"不是普通文件: {path}")

    if ffprobe_available():
        try:
            proc = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-print_format",
                    "json",
                    "-show_format",
                    "-show_streams",
                    str(path),
                ],
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
            if proc.returncode != 0:
                raise AudioReadError(proc.stderr.strip() or "ffprobe 无法读取该文件")
            info = json.loads(proc.stdout)
            stream = next((s for s in info.get("streams", []) if s.get("codec_type") == "audio"), None)
            if stream is None:
                raise AudioReadError("容器中没有音频流")
            duration = stream.get("duration") or info.get("format", {}).get("duration")
            return {
                "sample_rate": int(stream["sample_rate"]) if stream.get("sample_rate") else None,
                "channels": int(stream["channels"]) if stream.get("channels") else None,
                "duration": float(duration) if duration not in (None, "N/A") else None,
                "codec": stream.get("codec_name"),
                "format": info.get("format", {}).get("format_name"),
            }
        except AudioReadError:
            raise
        except (subprocess.SubprocessError, json.JSONDecodeError, KeyError, ValueError) as exc:
            raise AudioReadError(f"元数据解析失败: {exc}") from exc

    # Small dependency-free fallback for PCM WAV files.
    try:
        with wave.open(str(path), "rb") as wf:
            return {
                "sample_rate": wf.getframerate(),
                "channels": wf.getnchannels(),
                "duration": wf.getnframes() / float(wf.getframerate()),
                "codec": "pcm",
                "format": "wav",
            }
    except (wave.Error, EOFError, OSError) as exc:
        raise AudioReadError("需要 ffprobe/ffmpeg 才能读取该音频格式") from exc


def _decode_wav_pcm(path: Path, target_sr: int) -> tuple[np.ndarray, int, int]:
    with wave.open(str(path), "rb") as wf:
        channels = wf.getnchannels()
        original_sr = wf.getframerate()
        sample_width = wf.getsampwidth()
        raw = wf.readframes(wf.getnframes())

    if sample_width == 1:
        # Unsigned 8-bit PCM.
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif sample_width == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif sample_width == 3:
        raw_bytes = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        int24 = (
            raw_bytes[:, 0].astype(np.int32)
            | (raw_bytes[:, 1].astype(np.int32) << 8)
            | (raw_bytes[:, 2].astype(np.int32) << 16)
        )
        int24 = np.where(int24 & 0x800000, int24 - 0x1000000, int24)
        data = int24.astype(np.float32) / 8388608.0
    elif sample_width == 4:
        data = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise AudioReadError(f"不支持的 WAV 位深: {sample_width * 8} bit")

    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    if original_sr != target_sr:
        data = _resample_linear(data, original_sr, target_sr)
    return data.astype(np.float32, copy=False), target_sr, channels


def _resample_linear(x: np.ndarray, source_sr: int, target_sr: int) -> np.ndarray:
    if len(x) == 0 or source_sr == target_sr:
        return x.astype(np.float32, copy=False)
    new_len = max(1, int(round(len(x) * target_sr / source_sr)))
    old_pos = np.linspace(0.0, len(x) - 1, num=len(x), dtype=np.float64)
    new_pos = np.linspace(0.0, len(x) - 1, num=new_len, dtype=np.float64)
    return np.interp(new_pos, old_pos, x).astype(np.float32)


def decode_mono(path: str | Path, target_sr: int = ANALYSIS_SR) -> tuple[np.ndarray, int, int]:
    """Decode to mono float32. Returns samples, analysis_sr, original_channels."""
    path = Path(path)
    if ffmpeg_available():
        try:
            proc = subprocess.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-nostdin",
                    "-i",
                    str(path),
                    "-ac",
                    "1",
                    "-ar",
                    str(target_sr),
                    "-f",
                    "f32le",
                    "-",
                ],
                capture_output=True,
                timeout=60,
                check=False,
            )
            if proc.returncode != 0:
                detail = proc.stderr.decode("utf-8", "replace").strip()
                raise AudioReadError(detail or "ffmpeg 解码失败")
            x = np.frombuffer(proc.stdout, dtype="<f4").copy()
            if x.size == 0:
                raise AudioReadError("解码结果为空")
            meta_channels = probe_audio(path).get("channels") or 1
            return x, target_sr, int(meta_channels)
        except AudioReadError:
            # A broken/unsupported WAV should still try the local PCM fallback.
            if path.suffix.lower() != ".wav":
                raise
        except subprocess.SubprocessError as exc:
            raise AudioReadError(f"解码超时或无法启动 ffmpeg: {exc}") from exc

    if path.suffix.lower() in {".wav", ".wave"}:
        x, sr, channels = _decode_wav_pcm(path, target_sr)
        return x, sr, channels

    raise AudioReadError("未找到 ffmpeg，且该格式不是可直接解析的 WAV")


def waveform_peaks(x: np.ndarray, buckets: int = PEAK_BUCKETS) -> dict[str, list[float]]:
    if x.size == 0:
        return {"min": [], "max": [], "rms": []}
    bucket_size = max(1, int(np.ceil(x.size / buckets)))
    used = min(buckets, int(np.ceil(x.size / bucket_size)))
    trimmed = x[: used * bucket_size]
    if trimmed.size < used * bucket_size:
        trimmed = np.pad(trimmed, (0, used * bucket_size - trimmed.size))
    blocks = trimmed.reshape(used, bucket_size)
    mins = blocks.min(axis=1)
    maxs = blocks.max(axis=1)
    rms = np.sqrt(np.mean(blocks.astype(np.float64) ** 2, axis=1))
    return {
        "min": [round(float(v), 4) for v in mins],
        "max": [round(float(v), 4) for v in maxs],
        "rms": [round(float(v), 4) for v in rms],
        "bucket_seconds": round(bucket_size / ANALYSIS_SR, 5),
    }


def load_audio(path: str | Path, target_sr: int = ANALYSIS_SR) -> AudioData:
    metadata = probe_audio(path)
    x, analysis_sr, decoded_channels = decode_mono(path, target_sr)

    # Conservative peak normalization removes most gain/volume differences while
    # preserving noise-floor differences. Matching also normalizes per frame.
    high = float(np.percentile(np.abs(x), 99.5)) if x.size else 0.0
    if high > 1e-5:
        x = x / max(high, 0.25)
        peak = float(np.max(np.abs(x)))
        if peak > 0.98:
            x *= 0.98 / peak

    duration = metadata.get("duration")
    if not duration or duration <= 0:
        duration = len(x) / analysis_sr
    return AudioData(
        samples=x.astype(np.float32, copy=False),
        sample_rate=analysis_sr,
        original_sample_rate=metadata.get("sample_rate") or analysis_sr,
        channels=metadata.get("channels") or decoded_channels,
        duration=float(duration),
        peaks=waveform_peaks(x),
    )


def safe_static_path(root: Path, relative: str) -> Path | None:
    root = root.resolve()
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


def ensure_directory(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def open_user_path(path: str) -> Path:
    """Expand ~ and environment variables in user-supplied local paths."""
    return Path(os.path.expandvars(os.path.expanduser(path))).resolve()
