"""Encoder delay / padding discovery.

Two independent sources are used where possible:

1. ffprobe packet side data ("Skip Samples"): ``skip_samples`` on the first
   packet is the encoder delay (head padding), ``discard_padding`` on the last
   packet is the tail padding.  These are the values ffmpeg's decoder actually
   trims to, so they are the operative numbers.
2. For MP3 files carrying a real LAME/Xing info tag, the 24-bit
   delay/padding field written by the encoder is parsed directly from the
   file bytes (independent of ffmpeg's decoder state).

Trust levels
------------
``reliable``
    Padding reported by ffprobe side data (MP3, Opus, ...).  ffmpeg's decoder
    demonstrably trims exactly these samples.
``partial``
    Only one side is reported (e.g. AAC in MP4/M4A reports the 1024-sample
    encoder delay via edit list / side data, but no tail discard).
``none``
    No padding metadata readable.  Alignment can then only be estimated
    empirically (cross-correlation) and every conclusion is flagged uncertain.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass, field
from pathlib import Path

from .wavio import probe_packets, probe_stream

TRUST_RELIABLE = "reliable"
TRUST_PARTIAL = "partial"
TRUST_NONE = "none"


@dataclass
class PaddingInfo:
    codec: str = ""
    container: str = ""
    head_padding: int | None = None
    tail_padding: int | None = None
    trust: str = TRUST_NONE
    sources: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    # Independent encoder-side values (MP3 LAME tag); None when unavailable.
    lame_head: int | None = None
    lame_tail: int | None = None

    def as_dict(self) -> dict:
        return {
            "codec": self.codec,
            "container": self.container,
            "head_padding": self.head_padding,
            "tail_padding": self.tail_padding,
            "trust": self.trust,
            "sources": self.sources,
            "notes": self.notes,
            "lame_tag": (
                None
                if self.lame_head is None
                else {"head": self.lame_head, "tail": self.lame_tail}
            ),
        }


def _side_data_padding(path: Path) -> tuple[int | None, int | None]:
    """Extract (head skip, tail discard) from ffprobe packet side data."""
    packets = probe_packets(path)
    head = tail = None
    for idx, pkt in enumerate(packets):
        for sd in pkt.get("side_data_list", []):
            if sd.get("side_data_type") != "Skip Samples":
                continue
            skip = int(sd.get("skip_samples", 0))
            discard = int(sd.get("discard_padding", 0))
            if skip and head is None:
                head = skip
            if discard:
                # Last packet carrying discard wins (normally only one).
                tail = discard
    return head, tail


def parse_lame_tag(path: Path) -> tuple[int | None, int | None] | None:
    """Parse the delay/padding field of an MP3 LAME/Xing info tag.

    Returns (encoder_delay, encoder_padding) in source samples, or None when
    the file has no parseable tag (e.g. ffmpeg's own short "Lavc" tag, which
    does not store these values).
    """
    data = Path(path).read_bytes()
    tag = data.find(b"Xing")
    if tag < 0:
        tag = data.find(b"Info")
    if tag < 0:
        return None
    base = tag + 4
    if base + 4 > len(data):
        return None
    flags = struct.unpack_from(">I", data, base)[0]
    off = base + 4
    # Optional Xing fields: frames(4) bytes(4) TOC(100) quality(4)
    for bit, size in ((1, 4), (2, 4), (4, 100), (8, 4)):
        if flags & bit:
            off += size
    # LAME extension begins here; delay/padding is the 24-bit field at
    # extension offset 21 (high 12 bits = delay, low 12 = padding).
    if off + 24 > len(data):
        return None
    twenty_four = (data[off + 21] << 16) | (data[off + 22] << 8) | data[off + 23]
    return twenty_four >> 12, twenty_four & 0xFFF


def inspect_padding(path: Path) -> PaddingInfo:
    stream = probe_stream(path)
    info = PaddingInfo(
        codec=stream.get("codec_name", "unknown"),
        container=stream.get("codec_type", "audio"),
    )
    head, tail = _side_data_padding(path)
    info.head_padding, info.tail_padding = head, tail

    if info.codec == "mp3":
        lame = parse_lame_tag(path)
        if lame is not None:
            info.lame_head, info.lame_tail = lame
            info.sources.append("lame_tag(file)")
            if head is not None:
                info.notes.append(
                    "LAME tag reports encoder delay/padding "
                    f"{lame[0]}/{lame[1]}; ffprobe reports the ffmpeg "
                    f"pipeline values {head}/{tail}. Their sums normally "
                    "match (same number of frame samples, split differently)."
                )

    if head is not None and tail is not None:
        info.trust = TRUST_RELIABLE
        info.sources.append("ffprobe:skip_samples+discard_padding")
    elif head is not None or tail is not None:
        info.trust = TRUST_PARTIAL
        info.sources.append("ffprobe:skip_samples(partial)")
        missing = "tail" if head is not None else "head"
        info.notes.append(
            f"Only one side of the padding is signalled; the {missing} side "
            "is unknown. Trimmed/naive lengths beyond the known side are "
            "estimates and seam offsets there are empirical only."
        )
    else:
        info.trust = TRUST_NONE
        info.sources.append("none")
        info.notes.append(
            "No padding metadata found in the file. Any 'padding' shown is "
            "inferred from cross-correlation against the reference and must "
            "not be treated as ground truth."
        )
    return info
