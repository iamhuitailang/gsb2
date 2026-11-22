"""WAV 读写：支持 PCM 8/16/24/32 bit、IEEE float 32/64 bit、WAVE_FORMAT_EXTENSIBLE。

标准库 wave 模块不支持 24-bit 和 float，这里直接解析 RIFF，逻辑保持简单确定。
"""

from __future__ import annotations

import struct
import wave
from pathlib import Path

import numpy as np

from .audio import AudioData

WAVE_FORMAT_PCM = 0x0001
WAVE_FORMAT_IEEE_FLOAT = 0x0003
WAVE_FORMAT_EXTENSIBLE = 0xFFFE
# extensible 子格式 GUID 的前 2 字节决定真实格式，后 14 字节固定
_KSDATAFORMAT_SUBTYPE_PCM = b"\x01\x00\x00\x00\x00\x00\x10\x00\x80\x00\x00\xaa\x00\x38\x9b\x71"
_KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = b"\x03\x00\x00\x00\x00\x00\x10\x00\x80\x00\x00\xaa\x00\x38\x9b\x71"


class WavError(Exception):
    pass


def _read_chunks(path: Path) -> tuple[bytes, dict[str, bytes]]:
    data = Path(path).read_bytes()
    if len(data) < 12 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise WavError(f"{path} 不是 RIFF/WAVE 文件")
    chunks: dict[str, bytes] = {}
    pos = 12
    while pos + 8 <= len(data):
        cid = data[pos:pos + 4]
        (size,) = struct.unpack_from("<I", data, pos + 4)
        body = data[pos + 8:pos + 8 + size]
        chunks[cid] = body
        pos += 8 + size + (size & 1)  # chunk 按偶数字节对齐
    if b"fmt " not in chunks:
        raise WavError(f"{path} 缺少 fmt 块")
    if b"data" not in chunks:
        raise WavError(f"{path} 缺少 data 块")
    return data, chunks


def _decode_pcm(raw: bytes, bits: int, n_frames: int, channels: int) -> np.ndarray:
    if bits == 8:  # 8-bit PCM 是无符号的
        x = np.frombuffer(raw, dtype=np.uint8).astype(np.float64)
        x = (x - 128.0) / 128.0
    elif bits == 16:
        x = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    elif bits == 24:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        # 小端 24-bit 有符号
        x = b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16)
        x = np.where(x & 0x800000, x - 0x1000000, x).astype(np.float64) / 8388608.0
    elif bits == 32:
        x = np.frombuffer(raw, dtype="<i4").astype(np.float64) / 2147483648.0
    else:
        raise WavError(f"不支持的 PCM 位深: {bits}")
    total = n_frames * channels
    if x.size < total:
        raise WavError("data 块字节数少于头部声明")
    return x[:total].reshape(n_frames, channels)


def _decode_float(raw: bytes, bits: int, n_frames: int, channels: int) -> np.ndarray:
    if bits == 32:
        x = np.frombuffer(raw, dtype="<f4").astype(np.float64)
    elif bits == 64:
        x = np.frombuffer(raw, dtype="<f8").astype(np.float64)
    else:
        raise WavError(f"不支持的 float 位深: {bits}")
    total = n_frames * channels
    if x.size < total:
        raise WavError("data 块字节数少于头部声明")
    return x[:total].reshape(n_frames, channels)


def read_wav(path: str | Path) -> AudioData:
    """读入 WAV，返回 float64 的 AudioData。"""
    path = Path(path)
    _, chunks = _read_chunks(path)
    fmt = chunks[b"fmt "]
    if len(fmt) < 16:
        raise WavError("fmt 块过短")
    tag, channels, sample_rate, _byte_rate, _block_align, bits = struct.unpack_from("<HHIIHH", fmt, 0)
    channels = int(channels)
    sample_rate = int(sample_rate)
    bits = int(bits)

    sample_format = "PCM"
    if tag == WAVE_FORMAT_EXTENSIBLE:
        if len(fmt) < 40:
            raise WavError("extensible fmt 块过短")
        guid = fmt[24:40]
        if guid == _KSDATAFORMAT_SUBTYPE_IEEE_FLOAT:
            tag, sample_format = WAVE_FORMAT_IEEE_FLOAT, "FLOAT"
        elif guid == _KSDATAFORMAT_SUBTYPE_PCM:
            tag, sample_format = WAVE_FORMAT_PCM, "PCM"
        else:
            raise WavError("extensible WAV 使用了不支持的子格式")
    elif tag == WAVE_FORMAT_IEEE_FLOAT:
        sample_format = "FLOAT"
    elif tag != WAVE_FORMAT_PCM:
        raise WavError(f"不支持的格式标签: 0x{tag:04x}")

    raw = chunks[b"data"]
    bytes_per_sample = bits // 8
    n_frames = len(raw) // (bytes_per_sample * channels)
    if sample_format == "PCM":
        samples = _decode_pcm(raw, bits, n_frames, channels)
    else:
        samples = _decode_float(raw, bits, n_frames, channels)

    return AudioData(
        samples,
        sample_rate=sample_rate,
        name=path.stem,
        bit_depth=bits,
        sample_format=sample_format,
    )


def probe_wav(path: str | Path) -> dict:
    """只读头部信息，用于导出后核对，不加载全部采样。"""
    path = Path(path)
    _, chunks = _read_chunks(path)
    fmt = chunks[b"fmt "]
    tag, channels, sample_rate, byte_rate, block_align, bits = struct.unpack_from("<HHIIHH", fmt, 0)
    sample_format = "PCM"
    if tag == WAVE_FORMAT_EXTENSIBLE:
        guid = fmt[24:40]
        if guid == _KSDATAFORMAT_SUBTYPE_IEEE_FLOAT:
            sample_format = "FLOAT"
        elif guid == _KSDATAFORMAT_SUBTYPE_PCM:
            sample_format = "PCM"
        else:
            sample_format = "UNKNOWN"
    elif tag == WAVE_FORMAT_IEEE_FLOAT:
        sample_format = "FLOAT"
    data_bytes = len(chunks[b"data"])
    n_frames = data_bytes // (block_align if block_align else (bits // 8 * channels))
    return {
        "path": str(path),
        "format_tag": int(tag),
        "sample_format": sample_format,
        "channels": int(channels),
        "sample_rate": int(sample_rate),
        "bits_per_sample": int(bits),
        "byte_rate": int(byte_rate),
        "block_align": int(block_align),
        "data_bytes": int(data_bytes),
        "frames_by_header": int(n_frames),
        "duration_by_header": int(n_frames) / int(sample_rate),
        "file_size": path.stat().st_size,
    }


def _encode_pcm(samples: np.ndarray, bits: int) -> bytes:
    x = np.clip(samples, -1.0, 1.0)
    if bits == 8:
        q = np.round(x * 128.0 + 128.0).clip(0, 255).astype(np.uint8)
        return q.tobytes()
    if bits == 16:
        q = np.round(x * 32768.0).clip(-32768, 32767).astype("<i2")
        return q.tobytes()
    if bits == 24:
        flat = x.reshape(-1)
        q = np.round(flat * 8388608.0).clip(-8388608, 8388607).astype("<i4")
        b = np.empty((q.size, 3), dtype=np.uint8)
        u = q.view(np.uint32) & 0xFFFFFF
        b[:, 0] = u & 0xFF
        b[:, 1] = (u >> 8) & 0xFF
        b[:, 2] = (u >> 16) & 0xFF
        return b.tobytes()
    if bits == 32:
        q = np.round(x * 2147483648.0).clip(-2147483648, 2147483647).astype("<i4")
        return q.tobytes()
    raise WavError(f"不支持的 PCM 位深: {bits}")


def _encode_float(samples: np.ndarray, bits: int) -> bytes:
    if bits == 32:
        return samples.astype("<f4").tobytes()
    if bits == 64:
        return samples.astype("<f8").tobytes()
    raise WavError(f"不支持的 float 位深: {bits}")


def write_wav(
    path: str | Path,
    audio: AudioData,
    bits: int = 16,
    sample_format: str = "PCM",
    extensible: bool = False,
) -> Path:
    """写出 WAV。

    bits: PCM 支持 8/16/24/32；FLOAT 支持 32/64。
    extensible: 是否用 WAVE_FORMAT_EXTENSIBLE 外壳（多声道场景的规范写法）。
    """
    path = Path(path)
    channels = audio.channels
    block_align = channels * (bits // 8)
    byte_rate = audio.sample_rate * block_align
    tag = WAVE_FORMAT_IEEE_FLOAT if sample_format == "FLOAT" else WAVE_FORMAT_PCM

    if sample_format == "PCM":
        raw = _encode_pcm(audio.samples, bits)
    else:
        raw = _encode_float(audio.samples, bits)
    if len(raw) & 1:  # data chunk 偶数字节对齐
        raw += b"\x00"

    if extensible:
        cb_size = 22
        fmt = struct.pack(
            "<HHIIHHH",
            WAVE_FORMAT_EXTENSIBLE, channels, audio.sample_rate, byte_rate,
            block_align, bits, cb_size,
        )
        # valid_bits_per_sample(2) + channel_mask(4) + subformat GUID(16)
        guid = _KSDATAFORMAT_SUBTYPE_IEEE_FLOAT if sample_format == "FLOAT" else _KSDATAFORMAT_SUBTYPE_PCM
        # 通道掩码：前 N 声道按 FL, FR, FC, LFE, BL, BR ... 顺序给位
        mask = 0
        for i in range(channels):
            mask |= 1 << i
        fmt += struct.pack("<HI", bits, mask) + guid
    else:
        fmt = struct.pack(
            "<HHIIHH",
            tag, channels, audio.sample_rate, byte_rate, block_align, bits,
        )

    riff_size = 4 + (8 + len(fmt)) + (8 + len(raw))
    buf = b"RIFF" + struct.pack("<I", riff_size) + b"WAVE"
    buf += b"fmt " + struct.pack("<I", len(fmt)) + fmt
    # data 块长度只声明有效 payload；若为补齐偶数加了 0x00，该字节不计入长度
    payload_len = len(raw) - (len(raw) & 1)
    buf += b"data" + struct.pack("<I", payload_len) + raw
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(buf)
    return path


def write_wav_simple(
    path: str | Path,
    audio: AudioData,
    bits: int = 16,
    sample_format: str = "PCM",
) -> Path:
    """用标准库 wave 写 16/32-bit PCM（播放临时文件用，兼容性最好）。"""
    path = Path(path)
    if sample_format != "PCM" or bits not in (8, 16, 24, 32):
        return write_wav(path, audio, bits=bits, sample_format=sample_format)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(audio.channels)
        wf.setsampwidth(bits // 8)
        wf.setframerate(audio.sample_rate)
        wf.writeframes(_encode_pcm(audio.samples, bits))
    return path
