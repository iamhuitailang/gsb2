"""Project model: split, encode, build the three comparison tracks.

Tracks produced for every project
---------------------------------
``reference``
    The original uncompressed source (ground truth).
``naive``
    Decoded segments concatenated *with* their padding, i.e. what you get by
    decoding each compressed part and blindly appending it.
``trimmed``
    Decoded segments with all readable head/tail padding removed before
    concatenation.
``corrected``
    Same as trimmed, but using the user-adjusted keep ranges.

Two decoder behaviours are observed in practice and both handled:

* MP3 (and Opus): ffmpeg already trims on decode. The "raw" naive frame is
  reconstructed by re-inserting the signalled padding as digital-silence
  samples. This matches the encoder priming region, which is silence for
  ordinary source material; the reconstruction is labelled in the report.
* AAC in MP4: ffmpeg returns the untrimmed frame (head priming still
  attached), so trimming means slicing samples off instead.

When padding is unknown, both representations fall back to the decoded array
unchanged and the affected seams are marked unverifiable/estimated.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from .analysis import analyze_seam, estimate_priming
from .padding import TRUST_NONE, TRUST_PARTIAL, TRUST_RELIABLE, inspect_padding
from .wavio import decode_to_wav, encode_file, read_wav, write_wav

STATE_NAME = "project.json"

CODEC_PRESETS = {
    "mp3": {"ffmpeg_codec": "libmp3lame", "ext": ".mp3", "bitrate": "128k"},
    "aac": {"ffmpeg_codec": "aac", "ext": ".m4a", "bitrate": "128k"},
    "adts": {"ffmpeg_codec": "aac", "ext": ".aac", "bitrate": "128k"},
}


@dataclass
class Segment:
    index: int
    source_start: int          # inclusive, in source samples
    source_end: int            # exclusive
    source_length: int
    encoded_file: str
    decoded_file: str
    decoded_length: int
    head_padding: int | None
    tail_padding: int | None
    padding_trust: str
    padding_sources: list[str]
    padding_notes: list[str]
    lame_tag: dict | None
    decoder_pretrimmed: bool   # True = ffmpeg already removed padding
    estimated_head_padding: int | None  # empirical estimate, no metadata case
    estimation_confidence: float
    keep_start: int            # inclusive, source-relative within segment
    keep_end: int              # exclusive

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class Project:
    version: int
    source_wav: str
    workdir: str
    codec: str
    sample_rate: int
    channels: int
    source_samples: int
    cuts: list[int]
    segments: list[Segment]
    undo_stack: list[dict] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    # ------------------------------------------------------------------ io
    def to_json(self) -> dict:
        return {
            "version": self.version,
            "source_wav": self.source_wav,
            "workdir": self.workdir,
            "codec": self.codec,
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "source_samples": self.source_samples,
            "cuts": self.cuts,
            "segments": [s.as_dict() for s in self.segments],
            "undo_stack": self.undo_stack,
            "notes": self.notes,
        }

    @classmethod
    def from_json(cls, path: Path) -> "Project":
        d = json.loads(Path(path).read_text())
        segments = []
        for s in d["segments"]:
            # Backward compatibility: fields added in later versions.
            s.setdefault("estimated_head_padding", None)
            s.setdefault("estimation_confidence", 0.0)
            segments.append(Segment(**s))
        d["segments"] = segments
        d.pop("workdir", None)
        proj = cls(workdir=str(Path(path).parent), **d)
        return proj

    def save(self) -> None:
        Path(self.workdir, STATE_NAME).write_text(
            json.dumps(self.to_json(), indent=2, ensure_ascii=False)
        )


# ---------------------------------------------------------------------------
# Project creation
# ---------------------------------------------------------------------------

def _bounds_from_cuts(n: int, cuts: list[int]) -> list[tuple[int, int]]:
    points = [0, *sorted(set(cuts)), n]
    if points[1] == 0 or points[-2] == n:
        raise ValueError("cuts must lie strictly inside the source")
    if any(b <= a for a, b in zip(points, points[1:])):
        raise ValueError("duplicate or out-of-range cut points")
    return list(zip(points[:-1], points[1:]))


def create_project(
    source_wav: Path,
    workdir: Path,
    cuts: list[int],
    codec: str = "mp3",
) -> Project:
    if codec not in CODEC_PRESETS:
        raise ValueError(f"codec must be one of {sorted(CODEC_PRESETS)}")
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    src = read_wav(source_wav)
    n = src.n_samples
    bounds = _bounds_from_cuts(n, cuts)

    preset = CODEC_PRESETS[codec]
    segments: list[Segment] = []
    for idx, (a, b) in enumerate(bounds):
        part_wav = workdir / f"seg{idx:02d}_source.wav"
        enc = workdir / f"seg{idx:02d}{preset['ext']}"
        dec = workdir / f"seg{idx:02d}_decoded.wav"
        write_wav(part_wav, src.samples[a:b], src.sample_rate)
        encode_file(part_wav, enc, preset["ffmpeg_codec"], preset["bitrate"])
        decode_to_wav(enc, dec, src.sample_rate)
        dec_data = read_wav(dec)

        pad = inspect_padding(enc)
        # ffmpeg trims MP3/Opus on decode; MP4/AAC comes back untrimmed.
        pretrimmed = pad.codec in {"mp3", "opus", "vorbis"}
        est_head, est_conf = None, 0.0
        if pad.trust == TRUST_NONE and not pretrimmed:
            est_head, est_conf = estimate_priming(
                src.samples[a:b], dec_data.samples
            )
            if est_head:
                pad.notes.append(
                    f"no padding metadata; head priming empirically "
                    f"estimated at {est_head} samples (correlation "
                    f"{est_conf:.3f}). Treat as an estimate, not ground truth."
                )
        seg = Segment(
            index=idx,
            source_start=a,
            source_end=b,
            source_length=b - a,
            encoded_file=str(enc.relative_to(workdir)),
            decoded_file=str(dec.relative_to(workdir)),
            decoded_length=dec_data.n_samples,
            head_padding=pad.head_padding,
            tail_padding=pad.tail_padding,
            padding_trust=pad.trust,
            padding_sources=pad.sources,
            padding_notes=pad.notes,
            lame_tag=pad.lame_head is not None
            and {"head": pad.lame_head, "tail": pad.lame_tail}
            or None,
            decoder_pretrimmed=pretrimmed,
            estimated_head_padding=est_head,
            estimation_confidence=round(est_conf, 4),
            keep_start=0,
            keep_end=b - a,
        )
        segments.append(seg)

    # Keep a copy of the reference next to the project.
    ref_copy = workdir / "reference.wav"
    if not ref_copy.exists():
        write_wav(ref_copy, src.samples, src.sample_rate, bit_depth=16)

    proj = Project(
        version=1,
        source_wav=str(Path(source_wav).resolve()),
        workdir=str(workdir),
        codec=codec,
        sample_rate=src.sample_rate,
        channels=src.channels,
        source_samples=n,
        cuts=sorted(set(cuts)),
        segments=segments,
    )
    proj.save()
    return proj


# ---------------------------------------------------------------------------
# Track building
# ---------------------------------------------------------------------------

@dataclass
class BuiltTrack:
    name: str
    samples: np.ndarray
    # junction sample positions in this track, one per internal cut
    junctions: list[int]
    length: int


def _segment_frames(
    proj: Project, seg: Segment
) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """Return (raw_with_padding, content_without_padding, warnings)."""
    dec = read_wav(Path(proj.workdir, seg.decoded_file)).samples
    warnings: list[str] = []
    h = seg.head_padding or 0
    t = seg.tail_padding or 0

    if seg.padding_trust == TRUST_NONE:
        warnings.append(
            f"segment {seg.index}: no padding metadata; raw/trimmed are both "
            "the untouched decoder output"
        )
        return dec, dec, warnings

    if seg.decoder_pretrimmed:
        # Decoder already removed padding: reconstruct the raw frame with
        # digital-silence priming/flush samples.
        zeros_h = np.zeros((h, dec.shape[1]), dtype=dec.dtype)
        zeros_t = np.zeros((t, dec.shape[1]), dtype=dec.dtype)
        raw = np.concatenate([zeros_h, dec, zeros_t])
        content = dec
        if seg.padding_trust == TRUST_PARTIAL:
            warnings.append(
                f"segment {seg.index}: partial padding info; unknown side "
                "reconstructed as zero-length, junction drift measured below"
            )
    else:
        # Decoder returns the whole frame; trimming slices the pads off.
        raw = dec
        end = len(dec) - t
        if end <= h:
            warnings.append(
                f"segment {seg.index}: padding ({h}/{t}) exceeds decoded "
                f"length {len(dec)}; falling back to untrimmed content"
            )
            content = dec
        else:
            content = dec[h:end]
    return raw, content, warnings


def build_tracks(proj: Project) -> tuple[BuiltTrack, BuiltTrack, BuiltTrack, list[str]]:
    ref = read_wav(Path(proj.workdir, "reference.wav")).samples
    raws, contents, kept = [], [], []
    warnings: list[str] = []
    for seg in proj.segments:
        raw, content, w = _segment_frames(proj, seg)
        warnings.extend(w)
        raws.append(raw)
        contents.append(content)
        if (
            seg.padding_trust == TRUST_NONE
            and not seg.decoder_pretrimmed
            and seg.estimated_head_padding
        ):
            # No metadata: the untrimmed decode still carries priming. Skip
            # the empirical estimate before applying the user keep range.
            base = raw[seg.estimated_head_padding :]
            kept.append(base[seg.keep_start:seg.keep_end])
        else:
            kept.append(content[seg.keep_start:seg.keep_end])

    def concat(parts: list[np.ndarray]) -> np.ndarray:
        return np.concatenate(parts, axis=0) if parts else np.zeros((0, ref.shape[1]))

    def junctions_of(parts: list[np.ndarray]) -> list[int]:
        out, pos = [], 0
        for p in parts[:-1]:
            pos += len(p)
            out.append(pos)
        return out

    naive = concat(raws)
    trimmed = concat(contents)
    corrected = concat(kept)
    return (
        BuiltTrack("naive", naive, junctions_of(raws), len(naive)),
        BuiltTrack("trimmed", trimmed, junctions_of(contents), len(trimmed)),
        BuiltTrack("corrected", corrected, junctions_of(kept), len(corrected)),
        warnings,
    )


# ---------------------------------------------------------------------------
# Seam analysis
# ---------------------------------------------------------------------------

def analyze_project(proj: Project) -> dict:
    ref_wav = read_wav(Path(proj.workdir, "reference.wav"))
    ref = ref_wav.samples
    naive, trimmed, corrected, warnings = build_tracks(proj)
    # Cross-correlation windows are capped at 1024 half-width in analysis;
    # max_lag only has to cover one window plus a margin.
    max_lag = 1100

    ref_junctions = proj.cuts  # cut positions are source sample indices

    def per_track(track: BuiltTrack) -> list[dict]:
        reports = []
        for i, (rj, bj) in enumerate(zip(ref_junctions, track.junctions)):
            left, right = proj.segments[i], proj.segments[i + 1]
            trust_order = {TRUST_NONE: 0, TRUST_PARTIAL: 1, TRUST_RELIABLE: 2}
            trust = min(
                (left.padding_trust, right.padding_trust),
                key=lambda t: trust_order[t],
            )
            notes = [
                n for s in (left, right) for n in s.padding_notes
            ]
            reports.append(
                analyze_seam(
                    i, ref, track.samples, rj, bj, max_lag,
                    padding_trust=trust, trust_notes=list(dict.fromkeys(notes)),
                ).as_dict()
            )
        return reports

    return {
        "reference": {
            "samples": len(ref),
            "sample_rate": ref_wav.sample_rate,
            "channels": ref_wav.channels,
        },
        "tracks": {
            "naive": {
                "samples": naive.length,
                "delta_vs_reference": naive.length - len(ref),
                "seams": per_track(naive),
            },
            "trimmed": {
                "samples": trimmed.length,
                "delta_vs_reference": trimmed.length - len(ref),
                "seams": per_track(trimmed),
            },
            "corrected": {
                "samples": corrected.length,
                "delta_vs_reference": corrected.length - len(ref),
                "seams": per_track(corrected),
            },
        },
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Keep-range adjustment with undo
# ---------------------------------------------------------------------------

def adjust_keep(
    proj: Project, segment: int, keep_start: int | None, keep_end: int | None
) -> None:
    if not 0 <= segment < len(proj.segments):
        raise IndexError(f"segment {segment} does not exist")
    seg = proj.segments[segment]
    new_start = seg.keep_start if keep_start is None else keep_start
    new_end = seg.keep_end if keep_end is None else keep_end
    if not (0 <= new_start < new_end <= seg.source_length):
        raise ValueError(
            f"keep range [{new_start}, {new_end}) invalid for segment "
            f"{segment} of length {seg.source_length} "
            "(indices are source-relative within the segment)"
        )
    proj.undo_stack.append(
        {"segment": segment, "keep_start": seg.keep_start, "keep_end": seg.keep_end}
    )
    seg.keep_start, seg.keep_end = new_start, new_end
    proj.save()


def undo(proj: Project) -> bool:
    if not proj.undo_stack:
        return False
    snap = proj.undo_stack.pop()
    seg = proj.segments[snap["segment"]]
    seg.keep_start, seg.keep_end = snap["keep_start"], snap["keep_end"]
    proj.save()
    return True
