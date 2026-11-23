"""Minimal uncompressed 16-bit TIFF reader/writer.

Pillow can read and write 8-bit images everywhere and 16-bit *grayscale* PNGs,
but it silently narrows 16-bit colour TIFF/PNG data to 8 bits on load.  Flat
field correction produces fractional values that deserve the extra bits, and
the requirement is explicitly "lossless export, then read back and verify", so
this module implements the narrow slice of TIFF we need ourselves:

* little- or big-endian header, classic TIFF (magic 42),
* one strip, uncompressed, chunky (interleaved) samples,
* 8 or 16 bits per sample, 1 or 3 or 4 samples per pixel.

Files written here are ordinary uncompressed TIFFs that other software can
open.  The reader understands a little more than the writer emits (multiple
strips) so files from elsewhere have a chance to load exactly as stored.
"""

from __future__ import annotations

import struct
from pathlib import Path

import numpy as np

_TAG_WIDTH = 256
_TAG_HEIGHT = 257
_TAG_BITS = 258
_TAG_COMPRESSION = 259
_TAG_PHOTOMETRIC = 262
_TAG_STRIP_OFFSETS = 273
_TAG_SAMPLES_PER_PIXEL = 277
_TAG_ROWS_PER_STRIP = 278
_TAG_STRIP_COUNTS = 279
_TAG_PLANAR = 284
_TAG_SAMPLE_FORMAT = 339

_TYPE_SHORT = 3
_TYPE_LONG = 4


def _pack_entry(tag: int, typ: int, count: int, value: bytes, endian: str) -> bytes:
    """Pack one IFD entry; ``value`` is already 4 bytes."""
    if len(value) != 4:
        raise ValueError("IFD value must be 4 bytes")
    return struct.pack(endian + "HHI", tag, typ, count) + value


def write_tiff(
    path: str | Path,
    array: np.ndarray,
    *,
    bits: int = 16,
) -> Path:
    """Write an array losslessly as an uncompressed single-strip TIFF."""
    arr = np.asarray(array)
    if arr.dtype.kind == "f":
        raise TypeError("convert floats before writing (use core.save_corrected)")
    if bits == 16:
        arr = arr.astype(np.uint16, copy=False)
        dtype = "<u2"
    elif bits == 8:
        arr = arr.astype(np.uint8, copy=False)
        dtype = "u1"
    else:
        raise ValueError("bits must be 8 or 16")

    if arr.ndim == 2:
        height, width = arr.shape
        spp = 1
        photometric = 1
    elif arr.ndim == 3 and arr.shape[2] in (3, 4):
        height, width, spp = arr.shape
        photometric = 2
    else:
        raise ValueError(f"unsupported array shape {arr.shape}")

    endian = "<"
    data = np.ascontiguousarray(arr).astype(dtype).tobytes()
    data_offset = 8
    data_len = len(data)

    # Extra tag payloads (arrays longer than 4 bytes) live after the image data.
    extras = bytearray()
    extra_base = data_offset + data_len
    entries: list[tuple[int, int, int, bytes]] = []

    def add(tag: int, typ: int, count: int, payload: bytes) -> None:
        entries.append((tag, typ, count, payload))

    def add_short_array(tag: int, values: list[int]) -> None:
        # TIFF requires any value fitting in four bytes to live in the offset
        # field itself; only longer arrays may point elsewhere.
        packed = struct.pack(endian + "H" * len(values), *values)
        if len(packed) <= 4:
            add(tag, _TYPE_SHORT, len(values), packed.ljust(4, b"\x00"))
            return
        offset = extra_base + len(extras)
        extras.extend(packed)
        if len(extras) % 2:
            extras.append(0)
        add(tag, _TYPE_SHORT, len(values), struct.pack(endian + "I", offset))

    add(_TAG_WIDTH, _TYPE_SHORT, 1, struct.pack(endian + "HH", width, 0))
    add(_TAG_HEIGHT, _TYPE_SHORT, 1, struct.pack(endian + "HH", height, 0))
    add_short_array(_TAG_BITS, [bits] * spp)
    add(_TAG_COMPRESSION, _TYPE_SHORT, 1, struct.pack(endian + "HH", 1, 0))
    add(_TAG_PHOTOMETRIC, _TYPE_SHORT, 1, struct.pack(endian + "HH", photometric, 0))
    add(_TAG_STRIP_OFFSETS, _TYPE_LONG, 1, struct.pack(endian + "I", data_offset))
    add(_TAG_SAMPLES_PER_PIXEL, _TYPE_SHORT, 1, struct.pack(endian + "HH", spp, 0))
    add(_TAG_ROWS_PER_STRIP, _TYPE_LONG, 1, struct.pack(endian + "I", height))
    add(_TAG_STRIP_COUNTS, _TYPE_LONG, 1, struct.pack(endian + "I", data_len))
    add(_TAG_PLANAR, _TYPE_SHORT, 1, struct.pack(endian + "HH", 1, 0))
    add_short_array(_TAG_SAMPLE_FORMAT, [1] * spp)  # unsigned integer

    entries.sort(key=lambda item: item[0])
    if len(extras) % 2:
        extras.append(0)
    ifd_offset = extra_base + len(extras)

    ifd = bytearray()
    ifd.extend(struct.pack(endian + "H", len(entries)))
    for tag, typ, count, payload in entries:
        ifd.extend(_pack_entry(tag, typ, count, payload, endian))
    ifd.extend(struct.pack(endian + "I", 0))  # no next IFD

    out = bytearray()
    out.extend(struct.pack(endian + "2sHI", b"II", 42, ifd_offset))
    out.extend(data)
    out.extend(extras)
    out.extend(ifd)

    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(bytes(out))
    return p


def _read_header(blob: bytes) -> tuple[str, int]:
    marker = blob[:2]
    if marker == b"II":
        endian = "<"
    elif marker == b"MM":
        endian = ">"
    else:
        raise ValueError("not a TIFF file")
    magic, ifd_offset = struct.unpack(endian + "HI", blob[2:8])
    if magic != 42:
        raise ValueError(f"unsupported TIFF magic {magic}")
    return endian, ifd_offset


def _read_ifd(blob: bytes, endian: str, offset: int) -> dict[int, tuple[int, int, object]]:
    count = struct.unpack(endian + "H", blob[offset: offset + 2])[0]
    tags: dict[int, tuple[int, int, object]] = {}
    type_sizes = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8}
    for i in range(count):
        base = offset + 2 + i * 12
        tag, typ, n = struct.unpack(endian + "HHI", blob[base: base + 8])
        raw = blob[base + 8: base + 12]
        size = type_sizes.get(typ, 1) * n
        if size > 4:
            value_offset = struct.unpack(endian + "I", raw)[0]
            payload = blob[value_offset: value_offset + size]
        else:
            payload = raw[:size]
        if typ == _TYPE_SHORT:
            values = list(struct.unpack(endian + "H" * n, payload))
        elif typ == _TYPE_LONG:
            values = list(struct.unpack(endian + "I" * n, payload))
        else:
            values = list(payload)
        tags[tag] = (typ, n, values if n > 1 else values[0])
    return tags


def read_tiff(path: str | Path) -> tuple[np.ndarray, int]:
    """Read an uncompressed TIFF and return ``(array_uint, bits)``."""
    blob = Path(path).read_bytes()
    endian, ifd_offset = _read_header(blob)
    tags = _read_ifd(blob, endian, ifd_offset)

    width = int(tags[_TAG_WIDTH][2])
    height = int(tags[_TAG_HEIGHT][2])
    bits_tag = tags[_TAG_BITS][2]
    bits = int(bits_tag[0] if isinstance(bits_tag, list) else bits_tag)
    compression = int(tags.get(_TAG_COMPRESSION, (0, 1, 1))[2])
    if compression != 1:
        raise ValueError("only uncompressed TIFF is supported by this reader")
    spp = int(tags.get(_TAG_SAMPLES_PER_PIXEL, (_TYPE_SHORT, 1, 1))[2])
    planar = int(tags.get(_TAG_PLANAR, (_TYPE_SHORT, 1, 1))[2])
    if planar != 1:
        raise ValueError("only chunky planar configuration is supported")

    offsets = tags[_TAG_STRIP_OFFSETS][2]
    counts = tags[_TAG_STRIP_COUNTS][2]
    if not isinstance(offsets, list):
        offsets = [offsets]
    if not isinstance(counts, list):
        counts = [counts]
    rows_per_strip = int(tags.get(_TAG_ROWS_PER_STRIP, (_TYPE_LONG, 1, height))[2])
    if not isinstance(rows_per_strip, int):
        rows_per_strip = height

    chunks = []
    row_bytes = width * spp * (bits // 8)
    for offset, count in zip(offsets, counts):
        chunks.append(blob[offset: offset + count])
    raw = b"".join(chunks)
    expected = height * row_bytes
    if len(raw) < expected:
        raise ValueError("TIFF strip data shorter than expected")
    raw = raw[:expected]

    dtype = np.dtype(endian + ("u2" if bits == 16 else "u1"))
    arr = np.frombuffer(raw, dtype=dtype).reshape(height, width, spp) if spp > 1 else \
        np.frombuffer(raw, dtype=dtype).reshape(height, width)
    return np.asarray(arr), bits
