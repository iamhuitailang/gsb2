"""Thin, defensive wrappers around ffmpeg / ffprobe.

The tool never re-encodes source video: ffprobe reads metadata, ffmpeg is
used for scene analysis and for extracting individual still frames.

Frame accuracy matters here.  ``-ss`` is passed as an *input* option and the
output is re-encoded, so ffmpeg performs an accurate seek (decode from the
previous keyframe, discard frames before the target) instead of a fast
keyframe-only seek.  Analysis timestamps come from the frame PTS reported by
ffmpeg, never from a thumbnail index.

All functions raise :class:`MediaError` with a Chinese message suitable for
showing directly in the UI.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable

from .timecode import frame_duration_ms


class MediaError(RuntimeError):
    """Raised when ffmpeg / ffprobe cannot process a file."""


@dataclass
class MediaInfo:
    duration_ms: int
    fps: float
    width: int
    height: int
    codec: str
    has_audio: bool
    rotation: int = 0
    bit_rate: int | None = None
    raw: dict = field(default_factory=dict)

    @property
    def frame_ms(self) -> int:
        return frame_duration_ms(self.fps)


# ---------------------------------------------------------------------------
# Binaries
# ---------------------------------------------------------------------------


def _binary(name: str, env_name: str) -> str:
    override = os.environ.get(env_name)
    if override:
        return override
    found = shutil.which(name)
    if not found:
        raise MediaError(
            f"找不到 {name}。请先安装 ffmpeg（macOS: brew install ffmpeg），"
            f"或用环境变量 {env_name} 指定路径。"
        )
    return found


def ffmpeg_bin() -> str:
    return _binary("ffmpeg", "SHOT_SHELF_FFMPEG")


def ffprobe_bin() -> str:
    return _binary("ffprobe", "SHOT_SHELF_FFPROBE")


def _run(cmd: list[str], timeout: float | None = None) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
    except FileNotFoundError as exc:  # pragma: no cover - depends on host
        raise MediaError(f"无法执行 {cmd[0]}：{exc}") from exc
    except subprocess.TimeoutExpired as exc:
        raise MediaError(f"{cmd[0]} 执行超时") from exc


# ---------------------------------------------------------------------------
# ffprobe
# ---------------------------------------------------------------------------


def _parse_rate(text: str | None) -> float:
    if not text:
        return 0.0
    if "/" in text:
        num, den = text.split("/", 1)
        try:
            num_f, den_f = float(num), float(den)
        except ValueError:
            return 0.0
        return num_f / den_f if den_f else 0.0
    try:
        return float(text)
    except ValueError:
        return 0.0


def _rotation_of(stream: dict) -> int:
    for side in stream.get("side_data_list") or []:
        if "rotation" in side:
            try:
                return int(round(float(side["rotation"])))
            except (TypeError, ValueError):
                pass
    tags = stream.get("tags") or {}
    if "rotate" in tags:
        try:
            return int(round(float(tags["rotate"])))
        except (TypeError, ValueError):
            pass
    return 0


def probe(path: str | Path) -> MediaInfo:
    path = str(path)
    if not os.path.isfile(path):
        raise MediaError(f"文件不存在：{path}")
    cmd = [
        ffprobe_bin(),
        "-v", "error",
        "-print_format", "json",
        "-show_streams",
        "-show_format",
        path,
    ]
    result = _run(cmd, timeout=120)
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip()
        raise MediaError(f"无法读取视频信息：{detail or path}")
    try:
        payload = json.loads(result.stdout.decode("utf-8", "replace") or "{}")
    except json.JSONDecodeError as exc:
        raise MediaError("ffprobe 返回了无法解析的数据") from exc

    streams = payload.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise MediaError("该文件里没有视频轨道")

    duration = 0.0
    for candidate in (payload.get("format", {}).get("duration"), video.get("duration")):
        try:
            duration = float(candidate or 0)
        except (TypeError, ValueError):
            duration = 0.0
        if duration > 0:
            break

    fps = _parse_rate(video.get("avg_frame_rate"))
    if fps <= 0:
        fps = _parse_rate(video.get("r_frame_rate"))
    if fps <= 0 or fps > 240:
        fps = 25.0

    width = int(video.get("width") or 0)
    height = int(video.get("height") or 0)
    rotation = _rotation_of(video)
    if abs(rotation) in (90, 270):
        width, height = height, width

    bit_rate = payload.get("format", {}).get("bit_rate")
    try:
        bit_rate_int = int(bit_rate) if bit_rate else None
    except (TypeError, ValueError):
        bit_rate_int = None

    return MediaInfo(
        duration_ms=max(0, int(round(duration * 1000))),
        fps=round(fps, 3),
        width=width,
        height=height,
        codec=str(video.get("codec_name") or "unknown"),
        has_audio=any(s.get("codec_type") == "audio" for s in streams),
        rotation=rotation,
        bit_rate=bit_rate_int,
        raw=payload,
    )


# ---------------------------------------------------------------------------
# Scene analysis
# ---------------------------------------------------------------------------

_FRAME_LINE = re.compile(r"^frame:\s*\d+\s+pts:\s*-?\d+\s+pts_time:\s*(-?[0-9.]+)")
_SCORE_PREFIX = "lavfi.scene_score="
_Y_PREFIX = "lavfi.signalstats.YAVG="
_SAT_PREFIX = "lavfi.signalstats.SATAVG="
Row = tuple[int, float, float, float]


class _MetadataParser:
    """Streaming parser for ``metadata=print:file=-`` output."""

    def __init__(self) -> None:
        self.rows: list[Row] = []
        self._current: dict[str, float] = {}
        self._first_t: float | None = None

    def feed(self, raw_line: str) -> None:
        line = raw_line.strip()
        if not line:
            return
        if line.startswith("frame:"):
            self._flush()
            self._current = {}
            match = _FRAME_LINE.match(line)
            if match:
                try:
                    self._current["t"] = float(match.group(1))
                except ValueError:
                    pass
            return
        for prefix, key in ((_SCORE_PREFIX, "score"), (_Y_PREFIX, "y"), (_SAT_PREFIX, "sat")):
            if line.startswith(prefix):
                try:
                    self._current[key] = float(line[len(prefix):])
                except ValueError:
                    pass
                return

    def _flush(self) -> None:
        if "t" not in self._current or "score" not in self._current:
            return
        if self._first_t is None:
            self._first_t = self._current["t"]
        t_ms = int(round((self._current["t"] - self._first_t) * 1000))
        self.rows.append(
            (
                max(0, t_ms),
                float(self._current["score"]),
                float(self._current.get("y", 0.0)),
                float(self._current.get("sat", 0.0)),
            )
        )

    def finish(self) -> list[Row]:
        self._flush()
        # Some containers repeat PTS; keep the strongest score per timestamp.
        deduped: list[Row] = []
        for row in self.rows:
            if deduped and row[0] == deduped[-1][0]:
                if row[1] > deduped[-1][1]:
                    deduped[-1] = row
                continue
            deduped.append(row)
        return deduped


def analyze_scene(
    path: str | Path,
    *,
    max_width: int = 320,
    progress: Callable[[int], None] | None = None,
    duration_ms: int | None = None,
) -> dict:
    """Decode the whole video once and collect per-frame scene evidence.

    ``scene`` is ffmpeg's histogram-based frame difference in 0..1; ``YAVG``
    and ``SATAVG`` are luma / saturation averages used as extra evidence.

    stderr is redirected to a temporary file rather than a pipe: ffmpeg can
    otherwise deadlock when a pipe fills while we are busy reading stdout.
    """

    path = str(path)
    filtergraph = (
        f"scale={max_width}:-2,"
        "signalstats,"
        "select='gte(scene,0)',"
        "metadata=print:file=-"
    )
    cmd = [
        ffmpeg_bin(),
        "-hide_banner",
        "-nostdin",
        "-loglevel", "error",
        "-i", path,
        "-map", "0:v:0",
        "-an", "-sn", "-dn",
        "-vf", filtergraph,
        "-f", "null",
        "-",
    ]

    parser = _MetadataParser()
    with tempfile.TemporaryFile(mode="w+b") as errfile:
        try:
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=errfile,
                text=True,
                bufsize=1,
                errors="replace",
            )
        except FileNotFoundError as exc:  # pragma: no cover
            raise MediaError(f"无法执行 ffmpeg：{exc}") from exc

        assert proc.stdout is not None
        last_report = {"frames": 0}
        try:
            for line in proc.stdout:
                parser.feed(line)
                if progress is not None and len(parser.rows) - last_report["frames"] >= 120:
                    last_report["frames"] = len(parser.rows)
                    progress(len(parser.rows))
        finally:
            proc.stdout.close()
            returncode = proc.wait()
        errfile.seek(0)
        stderr = errfile.read().decode("utf-8", "replace")

    rows = parser.finish()
    if returncode != 0:
        detail = " / ".join(stderr.strip().splitlines()[-4:])
        raise MediaError("场景分析失败：" + (detail or f"ffmpeg 退出码 {returncode}"))
    if not rows:
        raise MediaError("场景分析没有返回任何帧，请确认视频可以正常解码")

    if progress is not None:
        progress(len(rows))

    return {
        "points": rows,
        "frame_count": len(rows),
        "first_t_ms": rows[0][0],
        "last_t_ms": rows[-1][0],
        "duration_ms": duration_ms,
    }


# ---------------------------------------------------------------------------
# Frame extraction
# ---------------------------------------------------------------------------


def _frame_filter(width: int, with_showinfo: bool) -> str:
    chain = f"scale={max(2, int(width))}:-2:flags=lanczos"
    if with_showinfo:
        chain += ",showinfo"
    return chain


def extract_frame_with_pts(
    path: str | Path,
    at_ms: int,
    out_path: str | Path,
    *,
    width: int = 720,
    quality: int = 3,
) -> tuple[Path, int | None]:
    """Extract a frame and report the source PTS that was actually decoded.

    With input-side ``-ss`` ffmpeg emits timestamps relative to the seek
    point, so the decoded frame's source time is ``seek + reported PTS``.
    That number is returned so the UI can display seek rounding instead of
    hiding it.
    """

    path = str(path)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_path.with_name(f"{out_path.name}.part{os.getpid()}")
    at_ms = max(0, int(at_ms))
    seconds = f"{at_ms / 1000.0:.3f}"
    cmd = [
        ffmpeg_bin(),
        "-hide_banner",
        "-nostdin",
        "-loglevel", "info",
        "-ss", seconds,
        "-i", path,
        "-frames:v", "1",
        "-an", "-sn", "-dn",
        "-vf", _frame_filter(width, with_showinfo=True),
        "-q:v", str(int(quality)),
        "-y", str(tmp_path),
    ]
    result = _run(cmd, timeout=120)
    stderr_text = result.stderr.decode("utf-8", "replace")
    if result.returncode != 0 or not tmp_path.exists() or tmp_path.stat().st_size == 0:
        tmp_path.unlink(missing_ok=True)
        detail = " / ".join(stderr_text.strip().splitlines()[-3:])
        raise MediaError(f"抽帧失败（{seconds}s）：{detail or '输出为空'}")
    os.replace(tmp_path, out_path)

    actual_ms: int | None = None
    for line in reversed(stderr_text.splitlines()):
        match = re.search(r"pts_time:\s*(-?[0-9.]+)", line)
        if match:
            try:
                actual_ms = max(0, int(round((at_ms / 1000.0 + float(match.group(1))) * 1000)))
            except ValueError:
                actual_ms = None
            break
    return out_path, actual_ms


def extract_frame(
    path: str | Path,
    at_ms: int,
    out_path: str | Path,
    *,
    width: int = 480,
    quality: int = 3,
) -> Path:
    out, _ = extract_frame_with_pts(path, at_ms, out_path, width=width, quality=quality)
    return out


def make_placeholder(out_path: str | Path, *, width: int = 480) -> Path:
    """A flat-colour JPEG used when a source frame cannot be decoded."""

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    height = max(2, int(round(int(width) * 9 / 16)))
    cmd = [
        ffmpeg_bin(),
        "-hide_banner",
        "-nostdin",
        "-loglevel", "error",
        "-f", "lavfi",
        "-i", f"color=c=0x1b1e26:s={int(width)}x{height}:d=1",
        "-frames:v", "1",
        "-q:v", "6",
        "-y", str(out_path),
    ]
    result = _run(cmd, timeout=30)
    if result.returncode != 0 or not out_path.exists():
        raise MediaError("无法生成占位缩略图")
    return out_path


# ---------------------------------------------------------------------------
# Environment check
# ---------------------------------------------------------------------------


def _filter_names(output: str) -> set[str]:
    names = set()
    for line in output.splitlines():
        parts = line.split()
        if len(parts) >= 2 and re.fullmatch(r"[TSC.]{3}", parts[0]):
            names.add(parts[1])
    return names


ANALYSIS_FILTERS = ("select", "signalstats", "metadata")


def analysis_supported() -> bool:
    """Scene analysis needs ``select`` (scene variable), ``signalstats`` and
    ``metadata``.  Note ffmpeg has no filter literally named ``scene`` — the
    score is a variable provided by ``select``.
    """

    try:
        result = _run([ffmpeg_bin(), "-hide_banner", "-filters"], timeout=20)
    except MediaError:
        return False
    names = _filter_names(result.stdout.decode("utf-8", "replace"))
    return all(name in names for name in ANALYSIS_FILTERS)


# Backwards-compatible name used by older callers/tests.
def scene_filter_supported() -> bool:
    return analysis_supported()


def doctor() -> dict:
    """Self-check used by the UI's environment chip and the sample builder."""

    report: dict = {
        "ffmpeg": None,
        "ffprobe": None,
        "ffmpeg_version": None,
        "analysis_filters": False,
        "scene_filter": False,  # legacy key, mirrors analysis_filters
        "signalstats_filter": False,
        "drawtext_filter": False,
        "libx264": False,
        "errors": [],
    }
    try:
        ffmpeg = ffmpeg_bin()
        report["ffmpeg"] = ffmpeg
        version = _run([ffmpeg, "-hide_banner", "-version"], timeout=20)
        first = version.stdout.decode("utf-8", "replace").splitlines()
        report["ffmpeg_version"] = first[0] if first else ""
        filters = _run([ffmpeg, "-hide_banner", "-filters"], timeout=20)
        names = _filter_names(filters.stdout.decode("utf-8", "replace"))
        report["analysis_filters"] = all(name in names for name in ANALYSIS_FILTERS)
        report["scene_filter"] = report["analysis_filters"]
        report["signalstats_filter"] = "signalstats" in names
        report["drawtext_filter"] = "drawtext" in names
        encoders = _run([ffmpeg, "-hide_banner", "-encoders"], timeout=20)
        report["libx264"] = "libx264" in encoders.stdout.decode("utf-8", "replace")
        missing = [name for name in ANALYSIS_FILTERS if name not in names]
        if missing:
            report["errors"].append("ffmpeg 缺少滤镜：" + ", ".join(missing))
    except (MediaError, OSError) as exc:
        report["errors"].append(str(exc))
    try:
        report["ffprobe"] = ffprobe_bin()
    except MediaError as exc:
        report["errors"].append(str(exc))
    return report
