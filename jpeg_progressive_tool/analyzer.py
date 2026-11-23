"""Truncation simulation and decode-state classification.

Every operation works on copies of the original bytes; the source data
is never mutated, so probing truncations cannot affect the original.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, asdict

from PIL import Image, ImageFile

from . import parser

# Allow PIL to return whatever it managed to decode from truncated input
# instead of raising on the missing tail.
ImageFile.LOAD_TRUNCATED_IMAGES = True

# Decode states
OK = "ok"                # complete file, fully decoded
PARTIAL = "partial"      # decodes, but data is missing (truncated)
SIZE_ONLY = "size_only"  # dimensions known, nothing decodable yet
NO_SIZE = "no_size"      # truncated before SOF: dimensions unknown

STATE_LABELS = {
    OK: "完整可预览",
    PARTIAL: "部分结果（数据不完整）",
    SIZE_ONLY: "仅知尺寸，暂无法解码",
    NO_SIZE: "连尺寸都无法确认",
}


@dataclass
class DecodeResult:
    offset: int           # truncation point (bytes kept)
    coverage: float       # offset / full file size
    state: str
    state_label: str
    width: int = -1
    height: int = -1
    scans_included: int = 0       # complete scans fully inside [0, offset)
    scan_indices: tuple = ()      # their scan_index values
    mid_scan: bool = False        # cut falls inside a scan's entropy data
    error: str = ""
    image: object = None          # PIL image when decodable (not serialized)

    def to_dict(self):
        d = asdict(self)
        d.pop("image", None)
        d["scan_indices"] = list(self.scan_indices)
        return d


def truncate(data: bytes, offset: int) -> bytes:
    """Return an independent copy of the first ``offset`` bytes."""
    offset = max(0, min(offset, len(data)))
    return bytes(data[:offset])


def probe(data: bytes, offset: int) -> DecodeResult:
    """Simulate having received only the first ``offset`` bytes of
    ``data`` and report what can be decoded. The input is not modified.

    Scan membership is decided against the *full* file's structure: a
    scan counts as included when its entropy data ends at or before
    ``offset``. (Parsing only the truncated chunk cannot tell a cut
    exactly at a scan end from a cut one byte earlier, since the
    terminating marker is missing in both cases.)
    """
    full_size = len(data)
    offset = max(0, min(offset, full_size))
    chunk = truncate(data, offset)
    full_struct = parser.parse(data)

    included = tuple(s.scan_index for s in full_struct.scans
                     if s.scan_complete and s.entropy_end <= offset)
    # Mid-scan when the cut lands strictly inside a complete scan's
    # entropy data, or when the file itself ends inside its last scan.
    mid_scan = any(
        (s.entropy_start <= offset < s.entropy_end)
        or (not s.scan_complete and s.entropy_start < offset)
        for s in full_struct.scans)

    sof = next((s for s in full_struct.segments
                if s.marker in parser.SOF_MARKERS), None)
    size_known = (sof is not None and sof.complete and sof.end <= offset
                  and full_struct.width > 0)

    image = None
    err = ""
    if size_known:
        try:
            im = Image.open(io.BytesIO(chunk))
            im.load()
            image = im.convert("RGB")
        except Exception as e:  # noqa: BLE001 - report any decoder failure
            err = f"{type(e).__name__}: {e}"
            image = None
    else:
        err = "SOF not reached: image dimensions unknown"

    width = full_struct.width if size_known else -1
    height = full_struct.height if size_known else -1

    if not size_known:
        state = NO_SIZE
    elif image is None:
        state = SIZE_ONLY
    elif offset < full_size or not full_struct.has_eoi:
        state = PARTIAL
    else:
        state = OK

    return DecodeResult(
        offset=offset,
        coverage=offset / full_size if full_size else 0.0,
        state=state,
        state_label=STATE_LABELS[state],
        width=width,
        height=height,
        scans_included=len(included),
        scan_indices=included,
        mid_scan=mid_scan,
        error=err if image is None else "",
        image=image,
    )


def probe_scan_boundaries(data: bytes) -> list:
    """Probe the file truncated at the end of every complete scan, plus
    the full file. Deterministic order: ascending byte offset."""
    struct = parser.parse(data)
    points = parser.scan_boundary_offsets(struct)
    if not points or points[-1] < len(data):
        points.append(len(data))
    return [probe(data, p) for p in points]
