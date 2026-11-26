"""Core WAV segmentation, manifest verification and sample comparison.

The module uses only the Python standard library.  It deliberately works on
raw interleaved WAV sample bytes so cuts can be proven to be contiguous at
sample-frame granularity.
"""

from __future__ import annotations

import hashlib
import json
import math
import shutil
import struct
import sys
import time
from array import array
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import BinaryIO, Iterable, Iterator, Sequence

TOOL_NAME = "wav-sample-split-restore"
MANIFEST_VERSION = 1
CHUNK_FRAMES = 1 << 16


class WavToolError(Exception):
    """Base error for user-visible WAV tool failures."""


class WavFormatError(WavToolError):
    pass


class CutError(WavToolError):
    pass


@dataclass(frozen=True)
class WavInfo:
    audio_format: int
    channels: int
    sample_rate: int
    sample_width: int
    bits_per_sample: int
    block_align: int
    total_frames: int
    data_offset: int
    data_size: int

    @property
    def frame_width(self) -> int:
        return self.channels * self.sample_width

    @property
    def duration_seconds(self) -> float:
        return self.total_frames / self.sample_rate if self.sample_rate else 0.0

    def to_dict(self) -> dict:
        d = asdict(self)
        d["frame_width"] = self.frame_width
        d["duration_seconds"] = self.duration_seconds
        return d


class WavReader:
    """Small streaming RIFF/WAVE reader for uncompressed PCM/float WAV files."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        if not self.path.is_file():
            raise WavFormatError(f"文件不存在：{self.path}")
        self.info = self._parse()

    def _parse(self) -> WavInfo:
        try:
            file_size = self.path.stat().st_size
        except OSError as exc:
            raise WavFormatError(f"无法读取文件：{self.path}") from exc

        with self.path.open("rb") as f:
            head = f.read(12)
            if len(head) < 12 or head[0:4] != b"RIFF" or head[8:12] != b"WAVE":
                raise WavFormatError("不是有效的 RIFF/WAVE 文件")

            fmt_body: bytes | None = None
            data_offset: int | None = None
            data_size: int | None = None
            pos = 12

            while pos + 8 <= file_size:
                f.seek(pos)
                chunk_header = f.read(8)
                if len(chunk_header) < 8:
                    break
                chunk_id, chunk_size = struct.unpack("<4sI", chunk_header)
                body_start = pos + 8
                body_end = body_start + chunk_size

                if chunk_id == b"fmt ":
                    f.seek(body_start)
                    fmt_body = f.read(chunk_size)
                elif chunk_id == b"data" and data_offset is None:
                    data_offset = body_start
                    data_size = chunk_size

                # RIFF chunks are two-byte aligned.
                pos = body_end + (chunk_size & 1)

            if fmt_body is None:
                raise WavFormatError("WAV 中缺少 fmt 块")
            if data_offset is None or data_size is None:
                raise WavFormatError("WAV 中缺少 data 块")

            if len(fmt_body) < 16:
                raise WavFormatError("fmt 块长度不足 16 字节")

            format_tag, channels, sample_rate, byte_rate, block_align, bits = struct.unpack_from(
                "<HHIIHH", fmt_body, 0
            )
            effective_format = format_tag
            if format_tag == 0xFFFE and len(fmt_body) >= 40:
                # WAVEFORMATEXTENSIBLE.SubFormat begins with a two-byte format tag.
                effective_format = struct.unpack_from("<H", fmt_body, 24)[0]

            if effective_format not in (1, 3):
                raise WavFormatError(
                    f"仅支持未压缩 PCM(1) 或 IEEE float(3)，当前格式标识为 {effective_format}"
                )
            if channels < 1:
                raise WavFormatError("声道数必须大于 0")
            if sample_rate <= 0:
                raise WavFormatError("采样率必须大于 0")

            sample_width = 0
            if block_align and channels and block_align % channels == 0:
                sample_width = block_align // channels
            if sample_width <= 0:
                sample_width = max(1, bits // 8)

            if effective_format == 1 and sample_width not in (1, 2, 3, 4):
                raise WavFormatError(f"不支持的 PCM 采样字节数：{sample_width}")
            if effective_format == 3 and sample_width not in (4, 8):
                raise WavFormatError(f"不支持的 float 采样精度：{sample_width * 8} bit")

            frame_width = channels * sample_width
            if block_align and block_align != frame_width:
                # Some malformed files still have usable bits/sample.  Prefer the
                # computed width but expose the discrepancy through parsing only.
                if bits and bits // 8 == sample_width:
                    frame_width = channels * sample_width
            if frame_width <= 0:
                raise WavFormatError("无法确定采样帧宽度")

            available_data = max(0, file_size - data_offset)
            if data_size > available_data:
                # Do not silently pretend the header is correct; range reads will
                # report truncation.  Keep header-declared count for diagnostics.
                pass

            total_frames = data_size // frame_width
            if total_frames <= 0:
                raise WavFormatError("音频 data 块中没有完整采样帧")

            return WavInfo(
                audio_format=effective_format,
                channels=channels,
                sample_rate=sample_rate,
                sample_width=sample_width,
                bits_per_sample=bits or sample_width * 8,
                block_align=block_align or frame_width,
                total_frames=total_frames,
                data_offset=data_offset,
                data_size=data_size,
            )

    def read_raw_range(self, start_frame: int = 0, end_frame: int | None = None) -> bytes:
        end_frame = self.info.total_frames if end_frame is None else end_frame
        self._validate_range(start_frame, end_frame)
        length = (end_frame - start_frame) * self.info.frame_width
        with self.path.open("rb") as f:
            f.seek(self.info.data_offset + start_frame * self.info.frame_width)
            data = f.read(length)
        if len(data) != length:
            raise WavFormatError(
                f"WAV 数据被截断：需要 {length} 字节，实际读到 {len(data)} 字节"
            )
        return data

    def iter_raw_range(
        self,
        start_frame: int = 0,
        end_frame: int | None = None,
        chunk_frames: int = CHUNK_FRAMES,
    ) -> Iterator[bytes]:
        end_frame = self.info.total_frames if end_frame is None else end_frame
        self._validate_range(start_frame, end_frame)
        frame_width = self.info.frame_width
        remaining = end_frame - start_frame
        with self.path.open("rb") as f:
            f.seek(self.info.data_offset + start_frame * frame_width)
            while remaining > 0:
                n = min(chunk_frames, remaining)
                data = f.read(n * frame_width)
                if len(data) != n * frame_width:
                    raise WavFormatError("WAV 数据被截断，无法完成逐段校验/复制")
                yield data
                remaining -= n

    def hash_raw_range(self, start_frame: int = 0, end_frame: int | None = None) -> str:
        h = hashlib.sha256()
        for chunk in self.iter_raw_range(start_frame, end_frame):
            h.update(chunk)
        return h.hexdigest()

    def _validate_range(self, start: int, end: int) -> None:
        if start < 0 or end < 0 or start > end:
            raise WavToolError(f"非法采样帧区间：[{start}, {end})")
        if end > self.info.total_frames:
            raise WavToolError(
                f"区间末端 {end} 超出 WAV 总帧数 {self.info.total_frames}"
            )


def sha256_file(path: str | Path, chunk_size: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def write_wav_header(
    f: BinaryIO,
    *,
    channels: int,
    sample_rate: int,
    sample_width: int,
    total_frames: int,
    audio_format: int = 1,
) -> None:
    bits = sample_width * 8
    block_align = channels * sample_width
    byte_rate = sample_rate * block_align
    data_size = total_frames * block_align
    if data_size > 0xFFFFFFFF - 37:
        raise WavToolError("音频过大，超过标准 RIFF/WAV 4 GiB 限制")
    pad = data_size & 1
    riff_size = 36 + data_size + pad
    f.write(b"RIFF")
    f.write(struct.pack("<I", riff_size))
    f.write(b"WAVE")
    f.write(b"fmt ")
    f.write(struct.pack("<I", 16))
    f.write(struct.pack("<HHIIHH", audio_format, channels, sample_rate, byte_rate, block_align, bits))
    f.write(b"data")
    f.write(struct.pack("<I", data_size))


def write_data_padding(f: BinaryIO, total_frames: int, frame_width: int) -> None:
    """RIFF chunks with an odd body length receive one zero pad byte."""
    if (total_frames * frame_width) & 1:
        f.write(b"\x00")


def write_wav_from_raw_chunks(
    out_path: str | Path,
    *,
    channels: int,
    sample_rate: int,
    sample_width: int,
    total_frames: int,
    chunks: Iterable[bytes],
    audio_format: int = 1,
) -> Path:
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("wb") as f:
        write_wav_header(
            f,
            channels=channels,
            sample_rate=sample_rate,
            sample_width=sample_width,
            total_frames=total_frames,
            audio_format=audio_format,
        )
        for chunk in chunks:
            f.write(chunk)
        write_data_padding(f, total_frames, channels * sample_width)
    return out_path


def write_segment(source: WavReader, start_frame: int, end_frame: int, out_path: str | Path) -> Path:
    frame_count = end_frame - start_frame
    info = source.info
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("wb") as f:
        write_wav_header(
            f,
            channels=info.channels,
            sample_rate=info.sample_rate,
            sample_width=info.sample_width,
            total_frames=frame_count,
            audio_format=info.audio_format,
        )
        for chunk in source.iter_raw_range(start_frame, end_frame):
            f.write(chunk)
        write_data_padding(f, frame_count, info.frame_width)
    return out_path


# ---------------------------------------------------------------------------
# Cut planning
# ---------------------------------------------------------------------------


def _round_half_up(value: float) -> int:
    return int(math.floor(value + 0.5))


def plan_fixed_cuts(total_frames: int, sample_rate: int, interval_seconds: float) -> list[dict]:
    if not math.isfinite(interval_seconds) or interval_seconds <= 0:
        raise CutError("固定间隔必须是大于 0 的秒数")
    if sample_rate <= 0:
        raise CutError("采样率无效")

    cuts: list[dict] = []
    k = 1
    while True:
        requested_seconds = k * interval_seconds
        requested_float = requested_seconds * sample_rate
        frame = _round_half_up(requested_float)
        if frame >= total_frames:
            break
        if frame > 0:
            if cuts and cuts[-1]["frame"] == frame:
                raise CutError(
                    f"固定间隔过短：第 {k - 1}、{k} 个切点取整后都落在采样点 {frame}，"
                    "请增大间隔或改用精确采样点"
                )
            cuts.append(
                _cut_dict(
                    index=len(cuts) + 1,
                    raw_text=f"{interval_seconds:g} × {k}",
                    requested_seconds=requested_seconds,
                    requested_frame_float=requested_float,
                    frame=frame,
                    sample_rate=sample_rate,
                )
            )
        k += 1
        if k > total_frames + 10:
            raise CutError("切点数量异常，请检查固定间隔是否过小")
    _reindex(cuts)
    return cuts


def plan_custom_cuts(
    total_frames: int,
    sample_rate: int,
    values: Sequence[str | float | int],
    unit: str = "seconds",
) -> list[dict]:
    if unit not in ("seconds", "frames"):
        raise CutError("自定义切点单位只能是 seconds 或 frames")

    parsed: list[tuple[str, float, float]] = []
    for raw in values:
        text = str(raw).strip()
        if not text:
            continue
        try:
            if unit == "frames":
                requested_frame = float(text)
                if not requested_frame.is_integer():
                    raise CutError(f"采样点切点必须是整数：{text}")
                requested_seconds = requested_frame / sample_rate
            else:
                requested_seconds = float(text)
                requested_frame = requested_seconds * sample_rate
        except CutError:
            raise
        except ValueError as exc:
            raise CutError(f"无法解析切点：{text!r}") from exc
        if not math.isfinite(requested_frame) or not math.isfinite(requested_seconds):
            raise CutError(f"切点必须是有限数值：{text!r}")
        parsed.append((text, requested_seconds, requested_frame))

    parsed.sort(key=lambda item: item[2])
    cuts: list[dict] = []
    seen: dict[int, str] = {}
    for text, requested_seconds, requested_frame in parsed:
        frame = int(requested_frame) if unit == "frames" else _round_half_up(requested_frame)
        if frame <= 0 or frame >= total_frames:
            raise CutError(
                f"切点 {text} 落在采样点 {frame}，必须满足 0 < 采样点 < {total_frames}"
            )
        if frame in seen:
            raise CutError(
                f"切点 {text} 与 {seen[frame]} 取整后都落在采样点 {frame}，请加大间距"
            )
        seen[frame] = text
        cuts.append(
            _cut_dict(
                index=len(cuts) + 1,
                raw_text=text,
                requested_seconds=requested_seconds,
                requested_frame_float=requested_frame,
                frame=frame,
                sample_rate=sample_rate,
            )
        )
    _reindex(cuts)
    return cuts


def _cut_dict(
    *,
    index: int,
    raw_text: str,
    requested_seconds: float,
    requested_frame_float: float,
    frame: int,
    sample_rate: int,
) -> dict:
    delta = frame - requested_frame_float
    return {
        "index": index,
        "raw_text": raw_text,
        "requested_seconds": requested_seconds,
        "requested_frame_float": requested_frame_float,
        "frame": frame,
        "time_seconds": frame / sample_rate,
        "delta_frames": delta,
        "delta_seconds": delta / sample_rate,
    }


def _reindex(cuts: list[dict]) -> None:
    for i, cut in enumerate(cuts, 1):
        cut["index"] = i


def segments_from_cuts(total_frames: int, cuts: Sequence[dict | int]) -> list[dict]:
    cut_frames = [c["frame"] if isinstance(c, dict) else int(c) for c in cuts]
    cut_frames = sorted(set(cut_frames))
    if any(f <= 0 or f >= total_frames for f in cut_frames):
        raise CutError("所有切点必须位于 0 和总采样帧数之间")
    boundaries = [0, *cut_frames, total_frames]
    segments = []
    for i in range(len(boundaries) - 1):
        start, end = boundaries[i], boundaries[i + 1]
        segments.append(
            {
                "index": i,
                "order": i + 1,
                "filename": f"segment_{i + 1:03d}.wav",
                "file": f"segments/segment_{i + 1:03d}.wav",
                "start_frame": start,
                "end_frame": end,
                "frame_count": end - start,
                "start_seconds": None,  # filled by caller with sample rate
                "end_seconds": None,
            }
        )
    return segments


# ---------------------------------------------------------------------------
# Export / manifest
# ---------------------------------------------------------------------------


def split_wav(
    source_path: str | Path,
    out_dir: str | Path,
    cut_frames: Sequence[int] | None = None,
    cuts: Sequence[dict] | None = None,
) -> dict:
    if cuts is not None:
        cut_frames = [int(c["frame"]) for c in cuts]
    if cut_frames is None:
        cut_frames = []

    reader = WavReader(source_path)
    info = reader.info
    segment_plan = segments_from_cuts(info.total_frames, cut_frames)
    out_dir = Path(out_dir)
    seg_dir = out_dir / "segments"
    seg_dir.mkdir(parents=True, exist_ok=True)

    manifest_segments = []
    for seg in segment_plan:
        out_path = out_dir / seg["file"]
        write_segment(reader, seg["start_frame"], seg["end_frame"], out_path)
        raw_hash = reader.hash_raw_range(seg["start_frame"], seg["end_frame"])
        file_hash = sha256_file(out_path)
        entry = dict(seg)
        entry["start_seconds"] = seg["start_frame"] / info.sample_rate
        entry["end_seconds"] = seg["end_frame"] / info.sample_rate
        entry["sha256_raw"] = raw_hash
        entry["sha256_file"] = file_hash
        manifest_segments.append(entry)

    source_path = Path(source_path)
    manifest = {
        "tool": TOOL_NAME,
        "manifest_version": MANIFEST_VERSION,
        "created_at_unix": time.time(),
        "source": {
            "filename": source_path.name,
            "sha256_file": sha256_file(source_path),
            "wav": info.to_dict(),
        },
        "cuts": [c for c in (cuts or [])],
        "segments": manifest_segments,
    }
    write_manifest(manifest, out_dir / "manifest.json")
    return manifest


def write_manifest(manifest: dict, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def load_manifest(path_or_text: str | Path | bytes) -> dict:
    if isinstance(path_or_text, (str, Path)) and Path(path_or_text).exists():
        text = Path(path_or_text).read_text(encoding="utf-8")
    elif isinstance(path_or_text, bytes):
        text = path_or_text.decode("utf-8")
    else:
        text = str(path_or_text)
    try:
        manifest = json.loads(text)
    except json.JSONDecodeError as exc:
        raise WavToolError(f"清单不是有效 JSON：{exc}") from exc
    if manifest.get("manifest_version") != MANIFEST_VERSION:
        raise WavToolError("清单版本不受支持")
    if not isinstance(manifest.get("segments"), list) or not manifest["segments"]:
        raise WavToolError("清单中没有 segments")
    return manifest


# ---------------------------------------------------------------------------
# Import verification
# ---------------------------------------------------------------------------


def expected_range_description(seg: dict, sample_rate: int) -> dict:
    return {
        "start_frame": seg["start_frame"],
        "end_frame": seg["end_frame"],
        "frame_count": seg["frame_count"],
        "start_seconds": seg["start_frame"] / sample_rate,
        "end_seconds": seg["end_frame"] / sample_rate,
    }


def verify_assignments(
    manifest: dict,
    assignments: dict[int | str, str | Path | None],
    provided_filenames: dict[int | str, str] | None = None,
) -> dict:
    """Verify files assigned to manifest positions.

    ``assignments[i]`` is the WAV file assigned to manifest segment position i.
    Mapping by position is what makes swapped hand-ins explicit.  A raw SHA-256
    match against another manifest segment identifies the true range.
    """
    provided_filenames = provided_filenames or {}
    source_info = manifest["source"]["wav"]
    sample_rate = int(source_info["sample_rate"])
    segments = manifest["segments"]

    raw_hash_to_indices: dict[str, list[int]] = {}
    for seg in segments:
        raw_hash_to_indices.setdefault(seg["sha256_raw"], []).append(int(seg["index"]))

    reports: list[dict] = []
    assigned_known_hashes: set[str] = set()

    for seg in segments:
        i = int(seg["index"])
        path = assignments.get(i, assignments.get(str(i)))
        provided_name = provided_filenames.get(i, provided_filenames.get(str(i)))
        if provided_name is None and path is not None:
            provided_name = Path(str(path)).name

        report: dict = {
            "index": i,
            "order": i + 1,
            "expected_filename": seg["filename"],
            "expected_file": seg["file"],
            "provided_filename": provided_name,
            "provided_path": str(path) if path is not None else None,
            "range": expected_range_description(seg, sample_rate),
            "expected_sha256_raw": seg["sha256_raw"],
            "expected_sha256_file": seg["sha256_file"],
            "status": "missing",
            "sample_ok": False,
            "file_checksum_ok": False,
            "name_matches": provided_name == seg["filename"] if provided_name else False,
            "actual_sha256_raw": None,
            "actual_sha256_file": None,
            "actual_segment_indices": [],
            "identity_segment_index": None,
            "swap_with": None,
            "parameter_errors": [],
            "warnings": [],
            "error": None,
        }

        if path is None or not Path(str(path)).exists():
            report["error"] = "未提供文件或文件不存在"
            reports.append(report)
            continue

        p = Path(str(path))
        try:
            report["actual_sha256_file"] = sha256_file(p)
            report["file_checksum_ok"] = report["actual_sha256_file"] == seg["sha256_file"]
            reader = WavReader(p)
            info = reader.info
            report["actual_wav"] = info.to_dict()
            report["actual_sha256_raw"] = reader.hash_raw_range()

            for key in ("channels", "sample_rate", "sample_width", "audio_format"):
                expected_value = source_info.get(key)
                actual_value = getattr(info, key)
                if expected_value is not None and expected_value != actual_value:
                    report["parameter_errors"].append(
                        f"{key}: 清单为 {expected_value}，文件为 {actual_value}"
                    )

            known_indices = raw_hash_to_indices.get(report["actual_sha256_raw"], [])
            report["actual_segment_indices"] = known_indices
            if known_indices:
                assigned_known_hashes.add(report["actual_sha256_raw"])

            if report["actual_sha256_raw"] == seg["sha256_raw"] and not report["parameter_errors"]:
                report["status"] = "ok"
                report["sample_ok"] = True
                report["identity_segment_index"] = i
                if not report["file_checksum_ok"]:
                    report["warnings"].append(
                        "整个 WAV 文件 SHA-256 不一致，但原始采样数据 SHA-256 一致；"
                        "通常是头部/元数据被重新写出，采样本身未变"
                    )
                if provided_name and provided_name != seg["filename"]:
                    report["warnings"].append(
                        f"文件名是 {provided_name}，清单期望 {seg['filename']}，但采样内容正确"
                    )
            elif known_indices:
                other = [j for j in known_indices if j != i] or known_indices
                report["identity_segment_index"] = other[0]
                if len(other) == 1:
                    report["status"] = "swapped"
                    report["swap_with"] = other[0] + 1
                    other_seg = segments[other[0]]
                    report["error"] = (
                        f"内容实际属于第 {other[0] + 1} 段，采样点 "
                        f"{other_seg['start_frame']}..{other_seg['end_frame']}；"
                        f"当前位置期望第 {i + 1} 段，采样点 "
                        f"{seg['start_frame']}..{seg['end_frame']}"
                    )
                else:
                    report["status"] = "ambiguous_duplicate"
                    report["error"] = f"内容与多个清单分段哈希相同：{[j + 1 for j in other]}"
            else:
                if report["name_matches"]:
                    report["status"] = "same_name_replaced"
                    report["error"] = (
                        f"同名文件 {seg['filename']} 的实际采样内容与清单不符，"
                        "且不匹配任何其他分段"
                    )
                else:
                    report["status"] = "hash_mismatch"
                    report["error"] = "实际采样内容与清单不符，且不匹配任何其他分段"
        except Exception as exc:  # report all malformed/unreadable files, continue others
            report["status"] = "invalid_wav"
            report["error"] = f"{type(exc).__name__}: {exc}"
        reports.append(report)

    # Detect reciprocal swaps for a more direct message.
    by_index = {r["index"]: r for r in reports}
    for r in reports:
        if r["status"] == "swapped" and r["identity_segment_index"] is not None:
            other = by_index.get(r["identity_segment_index"])
            if other and other.get("identity_segment_index") == r["index"]:
                r["reciprocal_swap"] = True
            else:
                r["reciprocal_swap"] = False

    expected_hashes = {seg["sha256_raw"] for seg in segments}
    all_expected_hashes_present = expected_hashes.issubset(assigned_known_hashes)
    sample_complete = all(r["sample_ok"] for r in reports)
    strict_complete = sample_complete and all(
        r["status"] == "ok" and r["file_checksum_ok"] and r["name_matches"] for r in reports
    )

    counts: dict[str, int] = {}
    for r in reports:
        counts[r["status"]] = counts.get(r["status"], 0) + 1

    problems = [
        {
            "index": r["index"],
            "order": r["order"],
            "status": r["status"],
            "range": r["range"],
            "message": r["error"],
        }
        for r in reports
        if not r["sample_ok"]
    ]

    return {
        "tool": TOOL_NAME,
        "complete": sample_complete,
        "sample_complete": sample_complete,
        "strict_package_complete": strict_complete,
        "all_expected_content_present": all_expected_hashes_present,
        "corrected_assembly_possible": all_expected_hashes_present,
        "counts": {
            "total": len(reports),
            "ok": counts.get("ok", 0),
            "missing": counts.get("missing", 0),
            "swapped": counts.get("swapped", 0),
            "same_name_replaced": counts.get("same_name_replaced", 0),
            "hash_mismatch": counts.get("hash_mismatch", 0),
            "invalid_wav": counts.get("invalid_wav", 0),
            "ambiguous_duplicate": counts.get("ambiguous_duplicate", 0),
        },
        "segments": reports,
        "problems": problems,
    }


def default_assignments_from_manifest_dir(manifest: dict, manifest_path: str | Path) -> dict[int, Path]:
    base = Path(manifest_path).parent
    assignments = {}
    for seg in manifest["segments"]:
        assignments[int(seg["index"])] = base / seg["file"]
    return assignments


# ---------------------------------------------------------------------------
# Assembly / preview
# ---------------------------------------------------------------------------


def _silence_chunks(frame_count: int, frame_width: int) -> Iterator[bytes]:
    chunk_frames = CHUNK_FRAMES
    remaining = frame_count
    zero = b"\x00" * (min(chunk_frames, frame_count) * frame_width)
    while remaining > 0:
        n = min(chunk_frames, remaining)
        yield zero[: n * frame_width]
        remaining -= n


def assembly_providers(
    manifest: dict, verification: dict, assignments: dict[int | str, str | Path | None]
) -> dict[int, Path]:
    """Map true manifest segment index -> a verified content provider path."""
    providers: dict[int, Path] = {}
    reports = verification["segments"]

    # First use exact, expected-position matches.
    for r in reports:
        i = int(r["index"])
        if r["sample_ok"]:
            path = assignments.get(i, assignments.get(str(i)))
            if path is not None:
                providers[i] = Path(str(path))

    # Then use hash-identified misplaced segments without overwriting a provider.
    for r in reports:
        if r["sample_ok"]:
            continue
        identity = r.get("identity_segment_index")
        if identity is None:
            continue
        if identity in providers:
            continue
        path = assignments.get(int(r["index"]), assignments.get(str(int(r["index"]))))
        if path is not None and Path(str(path)).exists():
            providers[int(identity)] = Path(str(path))

    return providers


def write_assembly(
    out_path: str | Path,
    manifest: dict,
    assignments: dict[int | str, str | Path | None],
    verification: dict | None = None,
    *,
    partial: bool = True,
) -> Path:
    """Write the timeline assembly.

    Verified segments are placed at their manifest positions.  Missing or
    unrecognized ranges are zero-filled in partial mode, preserving the original
    time axis and making gaps visible/audible.
    """
    if verification is None:
        verification = verify_assignments(manifest, assignments)
    if not partial and not verification["sample_complete"]:
        raise WavToolError("仍有分段未通过逐段校验，不能完整拼回")

    source = manifest["source"]["wav"]
    sample_rate = int(source["sample_rate"])
    channels = int(source["channels"])
    sample_width = int(source["sample_width"])
    audio_format = int(source.get("audio_format", 1))
    total_frames = int(source["total_frames"])
    frame_width = channels * sample_width
    providers = assembly_providers(manifest, verification, assignments)

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("wb") as out:
        write_wav_header(
            out,
            channels=channels,
            sample_rate=sample_rate,
            sample_width=sample_width,
            total_frames=total_frames,
            audio_format=audio_format,
        )

        for seg in manifest["segments"]:
            idx = int(seg["index"])
            count = int(seg["frame_count"])
            provider = providers.get(idx)
            if provider is None:
                if not partial:
                    raise WavToolError(f"第 {idx + 1} 段没有可用数据")
                for silence in _silence_chunks(count, frame_width):
                    out.write(silence)
                continue

            reader = WavReader(provider)
            if reader.info.channels != channels or reader.info.sample_width != sample_width:
                # Verification normally catches this.  Never write misaligned bytes.
                for silence in _silence_chunks(count, frame_width):
                    out.write(silence)
                continue
            copy_frames = min(count, reader.info.total_frames)
            for chunk in reader.iter_raw_range(0, copy_frames):
                out.write(chunk)
            if copy_frames < count and partial:
                for silence in _silence_chunks(count - copy_frames, frame_width):
                    out.write(silence)

        write_data_padding(out, total_frames, frame_width)

    return out_path


def restore_manifest(
    manifest_path: str | Path,
    out_path: str | Path,
    assignments: dict[int | str, str | Path | None] | None = None,
    *,
    partial: bool = False,
) -> tuple[dict, Path | None]:
    manifest_path = Path(manifest_path)
    manifest = load_manifest(manifest_path)
    if assignments is None:
        assignments = default_assignments_from_manifest_dir(manifest, manifest_path)
    report = verify_assignments(manifest, assignments)
    if not report["sample_complete"] and not partial:
        return report, None
    output = write_assembly(out_path, manifest, assignments, report, partial=not report["sample_complete"] and partial)
    return report, output


# ---------------------------------------------------------------------------
# Sample comparison
# ---------------------------------------------------------------------------


def decode_interleaved(raw: bytes, info: WavInfo | dict) -> list[int | float]:
    """Decode an interleaved chunk. Intended for chunk-sized comparison work."""
    channels = info["channels"] if isinstance(info, dict) else info.channels
    width = info["sample_width"] if isinstance(info, dict) else info.sample_width
    fmt = info["audio_format"] if isinstance(info, dict) else info.audio_format

    if width == 1 and fmt == 1:
        return [b - 128 for b in raw]

    values: array | list
    if width == 2:
        values = array("h")
        values.frombytes(raw)
        if sys.byteorder != "little":
            values.byteswap()
        return values.tolist()
    if width == 4 and fmt == 1:
        values = array("i")
        values.frombytes(raw)
        if sys.byteorder != "little":
            values.byteswap()
        return values.tolist()
    if width == 4 and fmt == 3:
        values = array("f")
        values.frombytes(raw)
        if sys.byteorder != "little":
            values.byteswap()
        return values.tolist()
    if width == 8 and fmt == 3:
        values = array("d")
        values.frombytes(raw)
        if sys.byteorder != "little":
            values.byteswap()
        return values.tolist()
    if width == 3 and fmt == 1:
        result = [0] * (len(raw) // 3)
        for i in range(len(result)):
            b0, b1, b2 = raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]
            value = b0 | (b1 << 8) | (b2 << 16)
            if value & 0x800000:
                value -= 1 << 24
            result[i] = value
        return result
    raise WavFormatError(f"解码暂不支持格式 format={fmt}, width={width}")


def compare_wavs(
    original_path: str | Path,
    candidate_path: str | Path,
    *,
    max_ranges_per_channel: int = 100,
) -> dict:
    original = WavReader(original_path)
    candidate = WavReader(candidate_path)
    a = original.info
    b = candidate.info

    result: dict = {
        "original": str(original_path),
        "candidate": str(candidate_path),
        "original_total_frames": a.total_frames,
        "candidate_total_frames": b.total_frames,
        "original_total_samples_per_channel": a.total_frames,
        "candidate_total_samples_per_channel": b.total_frames,
        "original_total_sample_values": a.total_frames * a.channels,
        "candidate_total_sample_values": b.total_frames * b.channels,
        "frame_count_match": a.total_frames == b.total_frames,
        "sample_rate_match": a.sample_rate == b.sample_rate,
        "channels_match": a.channels == b.channels,
        "sample_format_match": (
            a.sample_width == b.sample_width and a.audio_format == b.audio_format
        ),
        "sample_rate_original": a.sample_rate,
        "sample_rate_candidate": b.sample_rate,
        "channels_original": a.channels,
        "channels_candidate": b.channels,
        "identical_sample_data": False,
        "channels_report": [],
        "length_differences": [],
        "notes": [],
    }

    if not result["sample_rate_match"]:
        result["notes"].append("采样率不同；以下位置仍按采样帧序号比较，时间按原始采样率换算")
    if not result["sample_format_match"]:
        result["notes"].append("采样位深/格式不同；按解码后的数值比较")

    compare_channels = min(a.channels, b.channels)
    min_frames = min(a.total_frames, b.total_frames)
    width = a.sample_width if result["sample_format_match"] else None

    diff_counts = [0 for _ in range(compare_channels)]
    first_diff: list[dict | None] = [None for _ in range(compare_channels)]
    last_diff: list[dict | None] = [None for _ in range(compare_channels)]
    ranges: list[list[dict]] = [[] for _ in range(compare_channels)]
    run_start: list[int | None] = [None for _ in range(compare_channels)]
    run_last: list[int | None] = [None for _ in range(compare_channels)]
    ranges_truncated = [False for _ in range(compare_channels)]

    chunk_frames = 4096
    frame = 0
    while frame < min_frames:
        n = min(chunk_frames, min_frames - frame)
        raw_a = original.read_raw_range(frame, frame + n)
        raw_b = candidate.read_raw_range(frame, frame + n)

        if raw_a == raw_b and result["sample_format_match"] and a.channels == b.channels:
            # Raw equality closes no runs? It means all equal in this block, so
            # close any runs at previous frame.
            for c in range(compare_channels):
                if run_start[c] is not None:
                    _close_range(
                        ranges[c], run_start[c], (run_last[c] or run_start[c]) + 1,
                        a.sample_rate, max_ranges_per_channel,
                    )
                    if len(ranges[c]) >= max_ranges_per_channel:
                        ranges_truncated[c] = True
                    run_start[c] = None
                    run_last[c] = None
            frame += n
            continue

        samples_a = decode_interleaved(raw_a, a)
        samples_b = decode_interleaved(raw_b, b)
        for local_frame in range(n):
            global_frame = frame + local_frame
            for c in range(compare_channels):
                ia = local_frame * a.channels + c
                ib = local_frame * b.channels + c
                va = samples_a[ia]
                vb = samples_b[ib]
                if va != vb:
                    diff_counts[c] += 1
                    if first_diff[c] is None:
                        first_diff[c] = {
                            "frame": global_frame,
                            "time_seconds": global_frame / a.sample_rate,
                            "expected": va,
                            "actual": vb,
                        }
                    last_diff[c] = {
                        "frame": global_frame,
                        "time_seconds": global_frame / a.sample_rate,
                        "expected": va,
                        "actual": vb,
                    }
                    if run_start[c] is None:
                        run_start[c] = global_frame
                    run_last[c] = global_frame
                elif run_start[c] is not None:
                    _close_range(
                        ranges[c], run_start[c], global_frame,
                        a.sample_rate, max_ranges_per_channel,
                    )
                    if len(ranges[c]) >= max_ranges_per_channel:
                        ranges_truncated[c] = True
                    run_start[c] = None
                    run_last[c] = None
        frame += n

    for c in range(compare_channels):
        if run_start[c] is not None:
            _close_range(
                ranges[c], run_start[c], (run_last[c] or run_start[c]) + 1,
                a.sample_rate, max_ranges_per_channel,
            )
            if len(ranges[c]) >= max_ranges_per_channel:
                ranges_truncated[c] = True

    if a.total_frames != b.total_frames:
        if b.total_frames < a.total_frames:
            item = {
                "kind": "candidate_missing_tail_frames",
                "start_frame": b.total_frames,
                "end_frame": a.total_frames,
                "frame_count": a.total_frames - b.total_frames,
                "start_seconds": b.total_frames / a.sample_rate,
                "end_seconds": a.total_frames / a.sample_rate,
                "message": "拼回文件比原始文件短，末端这些采样帧缺失",
            }
        else:
            item = {
                "kind": "candidate_extra_tail_frames",
                "start_frame": a.total_frames,
                "end_frame": b.total_frames,
                "frame_count": b.total_frames - a.total_frames,
                "start_seconds": a.total_frames / a.sample_rate,
                "end_seconds": b.total_frames / a.sample_rate,
                "message": "拼回文件比原始文件长，末端多出这些采样帧",
            }
        result["length_differences"].append(item)

    all_identical = a.total_frames == b.total_frames and a.channels == b.channels
    channel_reports = []
    for c in range(a.channels):
        if c >= b.channels:
            channel_reports.append(
                {
                    "channel": c,
                    "identical": False,
                    "difference_count": None,
                    "first_difference": None,
                    "difference_ranges": [],
                    "note": "候选文件缺少该声道",
                }
            )
            all_identical = False
            continue
        identical = diff_counts[c] == 0 and a.total_frames == b.total_frames
        if not identical:
            all_identical = False
        bounding_range = None
        if first_diff[c] is not None and last_diff[c] is not None:
            bounding_range = {
                "start_frame": first_diff[c]["frame"],
                "end_frame": last_diff[c]["frame"] + 1,
                "frame_count": last_diff[c]["frame"] + 1 - first_diff[c]["frame"],
                "start_seconds": first_diff[c]["frame"] / a.sample_rate,
                "end_seconds": (last_diff[c]["frame"] + 1) / a.sample_rate,
                "note": "从首个差异到末个差异的外包区间；内部可能有少量样本恰好相同",
            }
        channel_reports.append(
            {
                "channel": c,
                "label": "L" if c == 0 else "R" if c == 1 else str(c + 1),
                "identical": identical,
                "samples_compared": min_frames,
                "difference_count": diff_counts[c],
                "first_difference": first_diff[c],
                "last_difference": last_diff[c],
                "bounding_difference_range": bounding_range,
                "difference_ranges": ranges[c],
                "ranges_truncated": ranges_truncated[c],
            }
        )

    if b.channels > a.channels:
        result["notes"].append(f"候选文件多出 {b.channels - a.channels} 个声道")
        all_identical = False

    result["channels_report"] = channel_reports
    result["identical_sample_data"] = all_identical
    return result


def _close_range(
    ranges: list[dict], start: int, end: int, sample_rate: int, limit: int
) -> None:
    if len(ranges) >= limit:
        return
    ranges.append(
        {
            "start_frame": start,
            "end_frame": end,
            "frame_count": end - start,
            "start_seconds": start / sample_rate,
            "end_seconds": end / sample_rate,
        }
    )


# ---------------------------------------------------------------------------
# Demo sample
# ---------------------------------------------------------------------------


def create_demo_wav(
    out_path: str | Path,
    *,
    sample_rate: int = 44100,
    duration_seconds: float = 4.3,
    interval_seconds: int | float = 1,
) -> dict:
    """Create the built-in stereo sample.

    Left/right use different frequencies and opposite full-scale impulses.
    Each impulse's first/peak sample is exactly on a fixed cut frame.
    """
    total_frames = int(round(duration_seconds * sample_rate))
    cut_frames = [
        int(round(k * interval_seconds * sample_rate))
        for k in range(1, int(duration_seconds / interval_seconds) + 2)
        if int(round(k * interval_seconds * sample_rate)) < total_frames
    ]

    left = array("h", [0]) * total_frames
    right = array("h", [0]) * total_frames
    two_pi = 2.0 * math.pi
    for n in range(total_frames):
        t = n / sample_rate
        # Clearly different channel content.
        lv = 0.22 * math.sin(two_pi * 261.63 * t) + 0.06 * math.sin(two_pi * 523.25 * t)
        rv = 0.22 * math.sin(two_pi * 392.00 * t) + 0.06 * math.sin(two_pi * 783.99 * t)
        left[n] = max(-32767, min(32767, int(lv * 32767)))
        right[n] = max(-32767, min(32767, int(rv * 32767)))

    pulse_frames = []
    for frame in cut_frames:
        if 0 <= frame < total_frames:
            pulse_frames.append(frame)
            # A short decaying click; sample 0 of the burst is exactly at cut.
            for k in range(18):
                idx = frame + k
                if idx >= total_frames:
                    break
                amplitude = int(30000 * math.exp(-k / 4.0))
                left[idx] = min(32767, amplitude)
                right[idx] = max(-32768, -amplitude)
            # Guarantee an unambiguous one-sample peak exactly on the cut.
            left[frame] = 32767
            right[frame] = -32768

    interleaved = array("h")
    # array.extend with generator can be slower; total size is modest.
    for n in range(total_frames):
        interleaved.append(left[n])
        interleaved.append(right[n])

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    write_wav_from_raw_chunks(
        out_path,
        channels=2,
        sample_rate=sample_rate,
        sample_width=2,
        total_frames=total_frames,
        chunks=[interleaved.tobytes()],
        audio_format=1,
    )
    return {
        "path": str(out_path),
        "sample_rate": sample_rate,
        "channels": 2,
        "total_frames": total_frames,
        "duration_seconds": total_frames / sample_rate,
        "interval_seconds": interval_seconds,
        "cut_frames": cut_frames,
        "pulse_frames": pulse_frames,
        "channel_design": "L=C4/C5 sine with positive impulse; R=G4/G5 sine with negative impulse",
    }


def make_demo_workspace(root: str | Path, case: str = "normal") -> dict:
    """Create source, exported segments and one of the demonstration cases."""
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    source = root / "demo_source.wav"
    demo = create_demo_wav(source)
    export_dir = root / "export_normal"
    cuts = plan_fixed_cuts(demo["total_frames"], demo["sample_rate"], demo["interval_seconds"])
    manifest = split_wav(source, export_dir, cuts=cuts)

    assignments = default_assignments_from_manifest_dir(manifest, export_dir / "manifest.json")
    provided_names = {i: Path(p).name for i, p in assignments.items()}
    case_dir = root / f"case_{case}"
    case_dir.mkdir(parents=True, exist_ok=True)

    if case == "missing":
        # Remove the second segment from the assignment set.
        assignments[1] = None
        provided_names[1] = None
    elif case == "swap":
        p0, p1 = assignments[0], assignments[1]
        assignments[0], assignments[1] = p1, p0
        provided_names[0], provided_names[1] = Path(p1).name, Path(p0).name
    elif case == "same_name_replaced":
        replacement = case_dir / "segment_002.wav"
        _create_replacement_wav(replacement, manifest["segments"][1]["frame_count"])
        assignments[1] = replacement
        provided_names[1] = "segment_002.wav"
    elif case != "normal":
        raise WavToolError(f"未知演示场景：{case}")

    verification = verify_assignments(manifest, assignments, provided_names)
    partial_path = case_dir / "partial_preview.wav"
    write_assembly(partial_path, manifest, assignments, verification, partial=True)
    restored_path = case_dir / "restored.wav"
    if verification["sample_complete"]:
        shutil.copyfile(partial_path, restored_path)

    compare = compare_wavs(source, partial_path)
    return {
        "demo": demo,
        "cuts": cuts,
        "manifest": manifest,
        "manifest_path": str(export_dir / "manifest.json"),
        "assignments": {str(k): str(v) if v is not None else None for k, v in assignments.items()},
        "provided_filenames": {str(k): v for k, v in provided_names.items()},
        "verification": verification,
        "partial_preview": str(partial_path),
        "restored": str(restored_path) if verification["sample_complete"] else None,
        "comparison_partial": compare,
        "source": str(source),
    }


def _create_replacement_wav(path: Path, frame_count: int, sample_rate: int = 44100) -> None:
    """A valid but wrong stereo WAV used for same-name replacement demos."""
    samples = array("h")
    for n in range(frame_count):
        value = int(9000 * math.sin(2 * math.pi * 1200 * n / sample_rate))
        samples.append(value)
        samples.append(-value)
    write_wav_from_raw_chunks(
        path,
        channels=2,
        sample_rate=sample_rate,
        sample_width=2,
        total_frames=frame_count,
        chunks=[samples.tobytes()],
    )
