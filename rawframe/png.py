"""纯标准库 PNG 编码（8-bit truecolor，带 filter 0 扫描线 + zlib）。"""
from __future__ import annotations

import struct
import zlib

import numpy as np


def encode_png(rgb: np.ndarray) -> bytes:
    if rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.dtype != np.uint8:
        raise ValueError("encode_png 需要 HxWx3 uint8 数组")
    h, w, _ = rgb.shape
    raw = bytearray()
    for row in rgb:
        raw.append(0)  # filter type None
        raw.extend(row.tobytes())
    compressed = zlib.compress(bytes(raw), 9)

    def chunk(tag: bytes, data: b"") -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)  # 8-bit, color type 2
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", compressed)
            + chunk(b"IEND", b""))


def write_png(path: str, rgb: np.ndarray) -> None:
    with open(path, "wb") as f:
        f.write(encode_png(rgb))
