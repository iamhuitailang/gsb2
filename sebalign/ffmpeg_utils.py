"""ffmpeg / ffprobe 的薄封装。

约定：
- 所有命令以列表形式传参（不经 shell），路径作为参数处理。
- 探测失败一律抛 :class:`FFprobeError`，由上层决定如何降级（例如索引写了但文件打不开）。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


class FFmpegError(RuntimeError):
    """ffmpeg 执行失败。"""


class FFprobeError(RuntimeError):
    """ffprobe 无法读取该文件（缺失 / 损坏 / 非媒体文件）。"""


def ensure_tools() -> None:
    """确认本机存在 ffmpeg 与 ffprobe，缺哪个就明确报错。"""
    missing = [name for name in ("ffmpeg", "ffprobe") if shutil.which(name) is None]
    if missing:
        raise FFmpegError(f"本机找不到 {', '.join(missing)}，请先安装 ffmpeg 并加入 PATH")


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if proc.returncode != 0:
        # 保留最后一段 stderr，足够定位问题又不刷屏
        tail = "\n".join(proc.stderr.strip().splitlines()[-12:])
        raise FFmpegError(f"命令失败 ({proc.returncode}): {' '.join(cmd)}\n{tail}")
    return proc


def ffprobe_json(path: str | Path) -> dict:
    """读取完整 ffprobe -show_streams/-show_format JSON。文件不可读时抛 FFprobeError。"""
    ensure_tools()
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-print_format",
        "json",
        str(path),
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        raise FFprobeError(f"ffprobe 无法读取 {path}: {proc.stderr.strip()[:300]}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise FFprobeError(f"ffprobe 输出无法解析: {path}") from exc


@dataclass
class MediaInfo:
    """实读出来的媒体事实——重新打开工作区时只信这些，不信索引里的估计值。"""

    width: int
    height: int
    fps: float
    duration: float
    has_audio: bool
    codec: str
    nb_frames: int | None  # 容器可能不提供，None 时按 duration*fps 估算并另行标注

    @property
    def estimated_frames(self) -> int:
        if self.nb_frames:
            return self.nb_frames
        return round(self.duration * self.fps)


def _parse_fps(rate: str | None) -> float:
    if not rate or rate == "0/0":
        return 0.0
    if "/" in rate:
        num, den = rate.split("/", 1)
        den_f = float(den)
        return float(num) / den_f if den_f else 0.0
    return float(rate)


def probe(path: str | Path) -> MediaInfo:
    """探测一个媒体文件的视频流事实；没有视频流即视为不可用。"""
    data = ffprobe_json(path)
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    if video is None:
        raise FFprobeError(f"{path} 中没有视频流")
    fps = _parse_fps(video.get("avg_frame_rate")) or _parse_fps(video.get("r_frame_rate"))
    duration = float(data.get("format", {}).get("duration") or video.get("duration") or 0.0)
    has_audio = any(s.get("codec_type") == "audio" for s in data.get("streams", []))
    nb_raw = video.get("nb_frames")
    nb_frames = int(nb_raw) if nb_raw and nb_raw != "N/A" else None
    return MediaInfo(
        width=int(video.get("width", 0)),
        height=int(video.get("height", 0)),
        fps=fps,
        duration=duration,
        has_audio=has_audio,
        codec=video.get("codec_name", "unknown"),
        nb_frames=nb_frames,
    )


def first_frame_png(path: str | Path, out_path: str | Path) -> None:
    """抽取真正的首帧为 PNG（核验“实际首帧”用，而不是照读索引）。"""
    ensure_tools()
    _run(
        [
            "ffmpeg", "-y", "-v", "error",
            "-i", str(path),
            "-frames:v", "1",
            "-an",
            str(out_path),
        ]
    )


def first_frame_hash(path: str | Path) -> str:
    """计算解码后首帧的原始像素哈希（sha256, rgb24）。

    同一画面在两档分辨率下尺寸不同、像素哈希不同，因此跨档比对不用它；
    它用于同档重新核验：索引里记的首帧哈希是否仍是文件真正的首帧。
    """
    import hashlib

    ensure_tools()
    info = probe(path)
    cmd = [
        "ffmpeg", "-v", "error",
        "-i", str(path),
        "-frames:v", "1",
        "-f", "rawvideo",
        "-pix_fmt", "rgb24",
        "-",
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise FFprobeError(f"无法解码首帧 {path}: {proc.stderr.decode(errors='replace')[:200]}")
    expect = info.width * info.height * 3
    if len(proc.stdout) < expect:
        raise FFprobeError(f"{path} 首帧数据不完整 ({len(proc.stdout)} < {expect})")
    return hashlib.sha256(proc.stdout[:expect]).hexdigest()


def run_ffmpeg(cmd: list[str]) -> None:
    ensure_tools()
    _run(cmd)


def build_concat_filter(specs: list[tuple[str, float, float]]) -> tuple[str, list[str]]:
    """生成 concat filter 描述。

    specs: (输入文件, 起点秒, 时长秒)；输入文件可重复出现（同一源切两段）。
    返回 (filter 字符串, 去重后的 -i 输入列表)。
    """
    inputs: list[str] = []
    index_of: dict[str, int] = {}
    parts: list[str] = []
    for path, _start, _dur in specs:
        if path not in index_of:
            index_of[path] = len(inputs)
            inputs.append(path)
    for n, (path, start, dur) in enumerate(specs):
        idx = index_of[path]
        parts.append(
            f"[{idx}:v]trim=start={start:.6f}:duration={dur:.6f},"
            f"setpts=PTS-STARTPTS[vin{n}]"
        )
    concat_in = "".join(f"[vin{n}]" for n in range(len(specs)))
    parts.append(f"{concat_in}concat=n={len(specs)}:v=1:a=0[vout]")
    return ";".join(parts), inputs


def cut_segments(
    sources: list[tuple[str, float, float]],
    out_path: str | Path,
    width: int,
    height: int,
    fps: float,
    crf: int = 23,
) -> None:
    """按 (源文件, 源内起点, 时长) 列表重编码拼接成一个无音频的分段输出。

    重编码（而非 stream copy）保证切点精确落在帧边界上，不会出现关键帧对齐造成的漂移。
    """
    ensure_tools()
    filter_str, inputs = build_concat_filter(sources)
    # 缩放/帧率处理并入 filter_complex——其输出不能再叠加 -vf 简单滤镜
    filter_str += (
        f";[vout]scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps}[vscaled]"
    )
    cmd = ["ffmpeg", "-y", "-v", "error"]
    for inp in inputs:
        cmd += ["-i", inp]
    cmd += [
        "-filter_complex", filter_str,
        "-map", "[vscaled]",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", str(crf),
        "-pix_fmt", "yuv420p",
        "-an",
        str(out_path),
    ]
    run_ffmpeg(cmd)


def extract_audio(sources: list[tuple[str, float, float]], out_path: str | Path) -> None:
    """把同一组源区间的音频拼接导出为一条连续音轨（预览里的唯一声音来源）。"""
    ensure_tools()
    # 音频版 concat：同一源可能被多个分段引用，按输入索引取流、按条目编号打标签
    parts = []
    index_of: dict[str, int] = {}
    inputs = []
    for path, _s, _d in sources:
        if path not in index_of:
            index_of[path] = len(inputs)
            inputs.append(path)
    for n, (path, start, dur) in enumerate(sources):
        idx = index_of[path]
        parts.append(
            f"[{idx}:a]atrim=start={start:.6f}:duration={dur:.6f},"
            f"asetpts=PTS-STARTPTS[ain{n}]"
        )
    concat_in = "".join(f"[ain{n}]" for n in range(len(sources)))
    parts.append(f"{concat_in}concat=n={len(sources)}:v=0:a=1[aout]")
    cmd = ["ffmpeg", "-y", "-v", "error"]
    for inp in inputs:
        cmd += ["-i", inp]
    cmd += [
        "-filter_complex", ";".join(parts),
        "-map", "[aout]",
        "-c:a", "aac",
        "-b:a", "128k",
        str(out_path),
    ]
    run_ffmpeg(cmd)
