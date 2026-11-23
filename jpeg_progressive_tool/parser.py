"""JPEG marker-walking parser.

Understands byte stuffing: inside entropy-coded scan data, a 0xFF byte
followed by 0x00 is a literal 0xFF (stuffed) and 0xFFD0-0xFFD7 are
restart markers -- neither starts a new segment. Only a 0xFF followed
by any other non-zero byte terminates the scan data.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict

SOI = 0xD8
EOI = 0xD9
SOS = 0xDA
DNL = 0xDC
DRI = 0xDD
TEM = 0x01

# Markers that carry no length field and no payload.
STANDALONE = {SOI, EOI, TEM} | set(range(0xD0, 0xD8))  # RST0-7

# SOF markers (0xC0-0xCF except DHT C4, JPG C8, DAC CC).
SOF_MARKERS = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
               0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}

BASELINE_SOF = {0xC0, 0xC3}          # baseline / extended sequential-ish
PROGRESSIVE_SOF = {0xC2}             # progressive Huffman

MARKER_NAMES = {
    0xC0: "SOF0 (baseline)", 0xC1: "SOF1 (ext. sequential)",
    0xC2: "SOF2 (progressive)", 0xC3: "SOF3 (lossless seq.)",
    0xC4: "DHT", 0xC5: "SOF5", 0xC6: "SOF6", 0xC7: "SOF7",
    0xC8: "JPG", 0xC9: "SOF9", 0xCA: "SOF10", 0xCB: "SOF11",
    0xCC: "DAC", 0xCD: "SOF13", 0xCE: "SOF14", 0xCF: "SOF15",
    0xD8: "SOI", 0xD9: "EOI", 0xDA: "SOS", 0xDB: "DQT",
    0xDC: "DNL", 0xDD: "DRI", 0xDE: "DHP", 0xDF: "EXP",
    0xE0: "APP0", 0xE1: "APP1", 0xE2: "APP2", 0xE3: "APP3",
    0xE4: "APP4", 0xE5: "APP5", 0xE6: "APP6", 0xE7: "APP7",
    0xE8: "APP8", 0xE9: "APP9", 0xEA: "APP10", 0xEB: "APP11",
    0xEC: "APP12", 0xED: "APP13", 0xEE: "APP14", 0xEF: "APP15",
    0xF0: "JPG0", 0xFE: "COM", 0x01: "TEM",
}
for _i in range(8):
    MARKER_NAMES[0xD0 + _i] = f"RST{_i}"


def marker_name(m: int) -> str:
    return MARKER_NAMES.get(m, f"0xFF{m:02X}")


@dataclass
class Segment:
    """One marker segment in file order."""
    index: int            # position in file order (deterministic)
    marker: int
    name: str
    offset: int           # offset of the 0xFF byte
    end: int              # one past the last byte of this segment
    length: int           # end - offset
    complete: bool = True  # False when the file ends inside this segment
    # SOS extras
    scan_index: int = -1          # which scan this SOS opens (0-based)
    entropy_start: int = -1       # first byte of entropy-coded data
    entropy_end: int = -1         # one past last entropy byte (before next marker)
    scan_complete: bool = True    # False when the file ends mid-scan

    def to_dict(self):
        return asdict(self)


@dataclass
class JpegStructure:
    size: int
    segments: list = field(default_factory=list)   # list[Segment]
    scans: list = field(default_factory=list)      # SOS Segments, file order
    sof_marker: int = -1
    width: int = -1
    height: int = -1
    progressive: bool = False
    has_eoi: bool = False
    valid: bool = False
    error: str = ""

    def to_dict(self):
        return {
            "size": self.size,
            "valid": self.valid,
            "error": self.error,
            "progressive": self.progressive,
            "sof_marker": marker_name(self.sof_marker) if self.sof_marker >= 0 else None,
            "width": self.width,
            "height": self.height,
            "has_eoi": self.has_eoi,
            "scan_count": len(self.scans),
            "segments": [s.to_dict() for s in self.segments],
        }


def _scan_entropy_end(data: bytes, start: int) -> int:
    """Return the offset where entropy-coded data ends (the 0xFF of the
    next real marker). Skips stuffed 0xFF00 pairs and RSTn markers."""
    i = start
    n = len(data)
    while i < n:
        if data[i] != 0xFF:
            i += 1
            continue
        if i + 1 >= n:
            return n  # truncated right at a 0xFF
        nxt = data[i + 1]
        if nxt == 0x00:
            i += 2            # stuffed literal 0xFF
        elif 0xD0 <= nxt <= 0xD7:
            i += 2            # restart marker, part of the scan
        elif nxt == 0xFF:
            i += 1            # fill byte before a marker
        else:
            return i          # real marker begins here
    return n


def parse(data: bytes) -> JpegStructure:
    """Parse JPEG markers from ``data``. Tolerant of truncation: returns
    whatever could be located, with incomplete trailing segments flagged."""
    st = JpegStructure(size=len(data))
    n = len(data)
    if n < 2 or data[0] != 0xFF or data[1] != SOI:
        st.error = "not a JPEG (missing SOI)"
        return st

    pos = 0
    idx = 0
    scan_no = 0
    while pos < n:
        # Expect 0xFF then marker byte (skip fill 0xFFs).
        if data[pos] != 0xFF:
            # Should not happen right after a segment; resync forward.
            nxt = data.find(b"\xff", pos)
            if nxt < 0:
                break
            pos = nxt
            continue
        if pos + 1 >= n:
            break  # truncated at marker
        marker = data[pos + 1]
        if marker == 0xFF:
            pos += 1
            continue
        if marker == 0x00:
            pos += 2  # stray stuffed byte outside scan data; skip
            continue

        if marker in STANDALONE:
            seg = Segment(idx, marker, marker_name(marker), pos, pos + 2, 2)
            st.segments.append(seg)
            idx += 1
            if marker == EOI:
                st.has_eoi = True
            pos += 2
            continue

        if pos + 4 > n:
            # Truncated inside the length field.
            st.segments.append(Segment(idx, marker, marker_name(marker),
                                       pos, n, n - pos, complete=False))
            idx += 1
            break

        seg_len = (data[pos + 2] << 8) | data[pos + 3]
        declared_end = pos + 2 + seg_len
        seg_end = min(declared_end, n)
        seg_complete = declared_end <= n

        if marker == SOS:
            entropy_start = seg_end
            entropy_end = _scan_entropy_end(data, entropy_start)
            complete = entropy_end < n
            seg = Segment(idx, marker, marker_name(marker), pos,
                          entropy_end, entropy_end - pos,
                          scan_index=scan_no,
                          entropy_start=entropy_start,
                          entropy_end=entropy_end,
                          scan_complete=complete)
            st.segments.append(seg)
            st.scans.append(seg)
            scan_no += 1
            idx += 1
            pos = entropy_end
            if not complete:
                break  # file ends inside this scan
            continue

        seg = Segment(idx, marker, marker_name(marker), pos, seg_end,
                      seg_end - pos, complete=seg_complete)
        st.segments.append(seg)
        idx += 1

        if marker in SOF_MARKERS and seg_end - (pos + 4) >= 6:
            st.sof_marker = marker
            st.height = (data[pos + 5] << 8) | data[pos + 6]
            st.width = (data[pos + 7] << 8) | data[pos + 8]
            st.progressive = marker in PROGRESSIVE_SOF

        pos = seg_end
        if seg_end < pos or seg_len < 2:
            break

    st.valid = True
    return st


def scan_boundary_offsets(st: JpegStructure):
    """Byte offsets where the file has been read exactly up to the end of
    each complete scan (one per scan, ascending, deduplicated)."""
    return sorted({s.entropy_end for s in st.scans if s.scan_complete})
