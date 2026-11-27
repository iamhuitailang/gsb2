"""ffprobe / ffmpeg 调用封装：仅依赖系统 ffmpeg，全部本地执行。"""

from __future__ import annotations

import json
import shutil
import subprocess
from fractions import Fraction


class FFmpegError(RuntimeError):
    pass


def ensure_ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        raise FFmpegError("未找到 ffmpeg，请先安装并加入 PATH（如 brew install ffmpeg）")
    return exe


def _run(cmd: list[str], timeout: float | None = None) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False
        )
    except FileNotFoundError as e:
        raise FFmpegError(f"命令不存在: {cmd[0]}") from e
    except subprocess.TimeoutExpired as e:
        raise FFmpegError(f"命令超时: {' '.join(cmd)}") from e


def _parse_fps(rate: str | None) -> Fraction | None:
    if not rate or rate == "0/0":
        return None
    try:
        num, den = rate.split("/")
        return Fraction(int(num), int(den))
    except (ValueError, ZeroDivisionError):
        return None


def probe(path: str, read_frames: bool = True, frame_limit: int = 20000) -> dict:
    """读取素材元数据。返回结构：
    {path, duration, size, video: {...}|None, audio: {...}|None,
     frame_count, frame_times: [...], has_audio, has_video}
    """

    exe = shutil.which("ffprobe") or "ffprobe"
    base = [exe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]
    p = _run(base)
    if p.returncode != 0:
        raise FFmpegError(f"ffprobe 失败: {p.stderr.strip() or path}")
    meta = json.loads(p.stdout)

    info: dict = {
        "path": path,
        "duration": float(meta.get("format", {}).get("duration", 0.0) or 0.0),
        "size": int(meta.get("format", {}).get("size", 0) or 0),
        "video": None,
        "audio": None,
        "frame_count": 0,
        "frame_times": [],
        "is_vfr": False,
        "has_audio": False,
        "has_video": False,
    }

    for st in meta.get("streams", []):
        codec_type = st.get("codec_type")
        if codec_type == "video" and info["video"] is None:
            fps = _parse_fps(st.get("avg_frame_rate")) or _parse_fps(st.get("r_frame_rate"))
            info["video"] = {
                "codec": st.get("codec_name"),
                "width": st.get("width"),
                "height": st.get("height"),
                "fps": float(fps) if fps else None,
                "fps_fraction": f"{fps.numerator}/{fps.denominator}" if fps else None,
                "pix_fmt": st.get("pix_fmt"),
                "nb_frames": int(st["nb_frames"]) if st.get("nb_frames") else None,
            }
            info["has_video"] = True
        elif codec_type == "audio" and info["audio"] is None:
            info["audio"] = {
                "codec": st.get("codec_name"),
                "sample_rate": int(st["sample_rate"]) if st.get("sample_rate") else None,
                "channels": st.get("channels"),
                "duration": float(st.get("duration", 0.0) or 0.0),
            }
            info["has_audio"] = True

    if info["has_video"] and read_frames:
        cmd = [
            exe, "-v", "error", "-select_streams", "v:0",
            "-show_entries", "frame=pts_time,best_effort_timestamp_time",
            "-print_format", "json", path,
        ]
        pf = _run(cmd, timeout=120)
        if pf.returncode == 0:
            frames = json.loads(pf.stdout).get("frames", [])[:frame_limit]
            times = []
            for f in frames:
                t = f.get("pts_time")
                if t is None:
                    t = f.get("best_effort_timestamp_time")
                if t is not None:
                    try:
                        times.append(float(t))
                    except ValueError:
                        pass
            info["frame_times"] = times
            info["frame_count"] = len(times)
            # 帧间隔标准差/均值超过 2% 视为 VFR
            if len(times) >= 4:
                deltas = [b - a for a, b in zip(times, times[1:])]
                mean = sum(deltas) / len(deltas)
                if mean > 0:
                    var = sum((d - mean) ** 2 for d in deltas) / len(deltas)
                    info["is_vfr"] = (var ** 0.5 / mean) > 0.02

    if info["frame_count"] == 0 and info["video"] and info["video"].get("nb_frames"):
        info["frame_count"] = info["video"]["nb_frames"]

    return info


def extract_frame(path: str, time_sec: float, out_path: str, width: int = 480) -> None:
    """抽取指定时间点的一帧为 JPEG，供前端对比预览。"""

    ensure_ffmpeg()
    cmd = [
        "ffmpeg", "-y", "-v", "error", "-ss", f"{max(time_sec, 0):.6f}",
        "-i", path, "-frames:v", "1", "-vf", f"scale={width}:-2",
        "-q:v", "3", out_path,
    ]
    p = _run(cmd, timeout=60)
    if p.returncode != 0:
        raise FFmpegError(f"抽帧失败 @ {time_sec}s: {p.stderr.strip()}")


def _atempo_chain(tempo: float) -> str:
    """atempo 单段只接受 0.5~2.0，超出范围自动串联。tempo=1/speed。"""

    parts: list[str] = []
    remaining = tempo
    while remaining > 2.0:
        parts.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5:
        parts.append("atempo=0.5")
        remaining /= 0.5
    parts.append(f"atempo={remaining:.6f}")
    return ",".join(parts)


def build_convert_command(
    src: str,
    dst: str,
    dst_fps: float,
    speed: float,
    method: str,
    keep_pitch: bool,
    has_audio: bool,
    video_codec: str = "libx264",
    crf: int = 18,
    preset: str = "medium",
) -> list[str]:
    """生成实际转码命令。视频与音频使用同一 speed 时间基准保证音画同步。"""

    ensure_ffmpeg()
    if method == "blend":
        # minterpolate 运动补偿混合：相邻源帧加权生成新帧，平滑但有拖影
        vf = f"setpts=PTS*{1.0 / speed:.6f},minterpolate=fps={float(dst_fps):g}:mi_mode=blend"
    else:
        # fps 滤镜 nearest 语义：重复/丢帧，round=near 与映射表 half-up 一致
        vf = f"setpts=PTS*{1.0 / speed:.6f},fps=fps={float(dst_fps):g}:round=near"

    cmd = ["ffmpeg", "-y", "-v", "error", "-i", src, "-vf", vf,
           "-c:v", video_codec, "-crf", str(crf), "-preset", preset, "-pix_fmt", "yuv420p"]

    if has_audio:
        tempo = 1.0 / speed
        if keep_pitch:
            # atempo 保调变速：时长变为原来的 tempo 倍，音调不变（单段限 0.5~2.0，自动串联）
            af = _atempo_chain(tempo)
        else:
            # 变速变调：直接按 speed 改播放采样率。
            # speed>1 → 采样率提高、播放更快、音调升高，时长 = 源时长/speed，与视频天然对齐
            af = f"asetrate=44100*{speed:.6f},aresample=44100"
        cmd += ["-af", af, "-c:a", "aac", "-b:a", "192k"]
    else:
        cmd += ["-an"]

    cmd += ["-movflags", "+faststart"]
    if has_audio:
        # 以视频流时长为准收尾，避免 AAC priming 样本把容器时长拖长
        cmd += ["-shortest"]
    cmd += [dst]
    return cmd


def run_convert(cmd: list[str], progress_cb=None) -> tuple[bool, str]:
    """执行转码。progress_cb(line) 可收集 stderr 日志；失败返回 (False, 日志)。"""

    ensure_ffmpeg()
    logs: list[str] = []
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            text=True, bufsize=1,
        )
    except FileNotFoundError as e:
        raise FFmpegError("ffmpeg 不存在") from e

    assert proc.stderr is not None
    for line in proc.stderr:
        logs.append(line.rstrip())
        if progress_cb:
            progress_cb(line.rstrip())
    proc.wait()
    return proc.returncode == 0, "\n".join(logs[-200:])
