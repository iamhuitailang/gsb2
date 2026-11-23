"""Minimal WAV I/O plus ffmpeg encode/decode wrappers.

Only the Python standard library, numpy and ffmpeg/ffprobe are required.
"""
from __future__ import annotations

import json
import shutil
import struct
import subprocess
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np


class FfmpegError(RuntimeError):
    pass


def _require(binary: str) -> str:
    path = shutil.which(binary)
    if not path:
        raise FfmpegError(f"{binary} not found on PATH; please install ffmpeg")
    return path


def run(cmd: list[str]) -> str:
    """Run a command, capturing stderr for diagnostics."""
    proc = subprocess.run(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )
    if proc.returncode != 0:
        raise FfmpegError(
            f"command failed ({proc.returncode}): {' '.join(cmd)}\n{proc.stderr}"
        )
    return proc.stderr


@dataclass
class WavData:
    """A decoded WAV file.

    samples has shape (n_samples, n_channels), float32 in [-1.0, 1.0].
    """

    samples: np.ndarray
    sample_rate: int
    channels: int
    bit_depth: int

    @property
    def n_samples(self) -> int:
        return self.samples.shape[0]


def read_wav(path: str | Path) -> WavData:
    """Read a PCM WAV (integer or float PCM) using the stdlib ``wave`` module."""
    path = Path(path)
    with wave.open(str(path), "rb") as w:
        channels = w.getnchannels()
        sample_rate = w.getframerate()
        width = w.getsampwidth()
        n = w.getnframes()
        raw = w.readframes(n)
        tag = w.getcomptype()
    if tag != "NONE":
        raise FfmpegError(f"{path}: compressed WAV ({tag}) is not supported")
    if width == 1:  # unsigned 8-bit PCM
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
        bit_depth = 8
    elif width == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        bit_depth = 16
    elif width == 3:
        # 24-bit little-endian signed, packed
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        i32 = (
            b[:, 0].astype(np.int32)
            | (b[:, 1].astype(np.int32) << 8)
            | (b[:, 2].astype(np.int32) << 16)
        )
        i32 = np.where(i32 & 0x800000, i32 - 0x1000000, i32)
        data = i32.astype(np.float32) / float(1 << 23)
        bit_depth = 24
    elif width == 4:
        # wave module cannot tell s32 PCM from f32 from the header alone;
        # inspect the format tag.
        fmt_tag = _wav_format_tag(path)
        if fmt_tag == 3:  # IEEE float
            data = np.frombuffer(raw, dtype="<f4").astype(np.float32)
        else:  # assume signed 32-bit PCM
            data = np.frombuffer(raw, dtype="<i4").astype(np.float32) / float(
                1 << 31
            )
        bit_depth = 32
    else:
        raise FfmpegError(f"{path}: unsupported sample width {width} bytes")
    data = data.reshape(-1, channels)
    return WavData(data, sample_rate, channels, bit_depth)


def _wav_format_tag(path: Path) -> int:
    with open(path, "rb") as f:
        header = f.read(40)
    # RIFF....WAVE fmt <chunksize:4> <tag:2>
    return struct.unpack_from("<H", header, 20)[0]


def write_wav(
    path: str | Path, samples: np.ndarray, sample_rate: int, bit_depth: int = 16
) -> None:
    """Write a PCM WAV. samples shape (n,) or (n, channels), float in [-1,1]."""
    x = np.asarray(samples, dtype=np.float32)
    if x.ndim == 1:
        x = x[:, None]
    channels = x.shape[1]
    x = np.clip(x, -1.0, 1.0)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if bit_depth == 16:
        pcm = (x * 32767.0).round().astype("<i2").tobytes()
        width = 2
    elif bit_depth == 24:
        i32 = (x * ((1 << 23) - 1)).round().astype(np.int32)
        b = np.empty((i32.size, 3), dtype=np.uint8)
        flat = i32.reshape(-1)
        b[:, 0] = flat & 0xFF
        b[:, 1] = (flat >> 8) & 0xFF
        b[:, 2] = (flat >> 16) & 0xFF
        pcm = b.tobytes()
        width = 3
    elif bit_depth == 32:
        pcm = (x * float((1 << 31) - 1)).round().astype("<i4").tobytes()
        width = 4
    else:
        raise ValueError("bit_depth must be 16, 24 or 32")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(sample_rate)
        w.writeframes(pcm)


# ---------------------------------------------------------------------------
# ffmpeg / ffprobe wrappers
# ---------------------------------------------------------------------------

def encode_file(
    src_wav: Path,
    dst: Path,
    codec: str,
    bitrate: str | None = None,
    extra: list[str] | None = None,
) -> None:
    ffmpeg = _require("ffmpeg")
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = [ffmpeg, "-y", "-v", "error", "-i", str(src_wav), "-c:a", codec]
    if bitrate:
        cmd += ["-b:a", bitrate]
    if extra:
        cmd += extra
    cmd.append(str(dst))
    run(cmd)


def decode_to_wav(src: Path, dst_wav: Path, sample_rate: int) -> None:
    """Decode to a float32 WAV with an explicit sample rate.

    ffmpeg applies the stream's skip/discard side data automatically, so the
    result is the *trimmed* decode (padding removed where the container/codec
    carries the information).
    """
    ffmpeg = _require("ffmpeg")
    dst_wav.parent.mkdir(parents=True, exist_ok=True)
    run(
        [
            ffmpeg,
            "-y",
            "-v",
            "error",
            "-i",
            str(src),
            "-ar",
            str(sample_rate),
            "-c:a",
            "pcm_s16le",
            str(dst_wav),
        ]
    )


def probe_packets(path: Path) -> list[dict]:
    """Return ffprobe packet records (JSON) for the first audio stream."""
    ffprobe = _require("ffprobe")
    proc = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_packets",
            "-of",
            "json",
            str(path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if proc.returncode != 0:
        raise FfmpegError(f"ffprobe failed: {proc.stderr}")
    return json.loads(proc.stdout).get("packets", [])


def probe_stream(path: Path) -> dict:
    ffprobe = _require("ffprobe")
    proc = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_streams",
            "-of",
            "json",
            str(path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if proc.returncode != 0:
        raise FfmpegError(f"ffprobe failed: {proc.stderr}")
    streams = json.loads(proc.stdout).get("streams", [])
    return streams[0] if streams else {}
