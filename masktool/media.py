"""FFprobe/FFmpeg plumbing and final-video export."""

from __future__ import annotations

import json
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any, Callable

from .core import as_float
from .render import render_frame

ProgressCB = Callable[[float, str, str], None]


class FFmpegUnavailable(RuntimeError):
    pass


def ffmpeg_bin() -> str:
    path = shutil.which("ffmpeg")
    if not path:
        raise FFmpegUnavailable("未找到 ffmpeg，请先安装 FFmpeg 后再导出。")
    return path


def ffprobe_bin() -> str:
    path = shutil.which("ffprobe")
    if not path:
        raise FFmpegUnavailable("未找到 ffprobe，请先安装 FFmpeg 后再导出。")
    return path


def probe_video(path: Path | str) -> dict[str, Any]:
    cmd = [
        ffprobe_bin(),
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    data = json.loads(result.stdout or "{}")
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), {})
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)

    width = int(video.get("width") or 1280)
    height = int(video.get("height") or 720)
    rotation = 0.0
    for side_data in video.get("side_data_list") or []:
        if "rotation" in side_data:
            rotation = as_float(side_data.get("rotation"), 0.0)
    if not rotation:
        rotation = as_float((video.get("tags") or {}).get("rotate"), 0.0)
    # Browsers report the post-rotation dimensions. FFmpeg autorotates decoded
    # frames by default, so the raw overlay must use that same orientation.
    if abs(round(rotation)) in {90, 270}:
        width, height = height, width

    fps = 30.0
    rate = video.get("avg_frame_rate") or video.get("r_frame_rate") or "30/1"
    try:
        num, den = rate.split("/")
        if float(den) != 0:
            fps = float(num) / float(den)
    except (ValueError, ZeroDivisionError):
        fps = 30.0
    if fps <= 1 or fps > 240:
        fps = 30.0

    duration = as_float((data.get("format") or {}).get("duration"), 0.0)
    if duration <= 0:
        duration = as_float(video.get("duration"), 10.0)

    return {
        "width": width,
        "height": height,
        "rotation": rotation,
        "fps": fps,
        "duration": duration,
        "hasAudio": audio is not None,
        "audioCodec": (audio or {}).get("codec_name"),
    }


def _run_simple(cmd: list[str], timeout: int = 180) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def extract_audio(source: Path, out_dir: Path, info: dict[str, Any]) -> Path | None:
    if not info.get("hasAudio"):
        return None
    codec = info.get("audioCodec") or "aac"
    ext = {"aac": "m4a", "mp3": "mp3", "opus": "opus", "alac": "m4a"}.get(codec, "m4a")
    direct_codec = "copy" if codec in {"aac", "mp3", "opus", "alac", "ac3", "eac3"} else "aac"
    audio_path = out_dir / f"source-audio.{ext if direct_codec == 'copy' else 'm4a'}"
    cmd = [ffmpeg_bin(), "-y", "-i", str(source), "-vn"]
    if direct_codec == "copy":
        cmd += ["-c:a", "copy", str(audio_path)]
    else:
        cmd += ["-c:a", "aac", "-b:a", "192k", str(audio_path)]
    result = _run_simple(cmd)
    if result.returncode != 0 and direct_codec == "copy":
        audio_path = out_dir / "source-audio.m4a"
        cmd = [ffmpeg_bin(), "-y", "-i", str(source), "-vn", "-c:a", "aac", "-b:a", "192k", str(audio_path)]
        result = _run_simple(cmd)
    if result.returncode != 0:
        # Audio extraction is auxiliary; muxing can still succeed.
        return None
    return audio_path


def _export_with_audio_mode(
    project: dict[str, Any],
    source: Path,
    out_path: Path,
    info: dict[str, Any],
    frame_count: int,
    fps: float,
    padding: int,
    audio_mode: str,
    on_progress: ProgressCB,
) -> None:
    width = int(info["width"])
    height = int(info["height"])
    vf_label = "[masked]" if padding == 0 else "[padded]"
    filter_complex = f"[0:v][1:v]overlay=0:0:format=auto[masked];"
    if padding:
        filter_complex += f"[masked]pad=iw+{padding * 2}:ih+{padding * 2}:{padding}:{padding}:black{ vf_label}"
    else:
        filter_complex += "[masked]null[outv]"
        vf_label = "[outv]"

    cmd = [
        ffmpeg_bin(),
        "-y",
        "-i",
        str(source),
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgba",
        "-video_size",
        f"{width}x{height}",
        "-framerate",
        f"{fps:.6f}",
        "-i",
        "-",
        "-filter_complex",
        filter_complex,
        "-map",
        vf_label,
    ]

    if info.get("hasAudio"):
        cmd += ["-map", "0:a:0?"]
        if audio_mode == "copy":
            cmd += ["-c:a", "copy"]
        else:
            cmd += ["-c:a", "aac", "-b:a", "192k"]
    cmd += [
        "-r",
        f"{fps:.6f}",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-shortest",
        "-progress",
        "pipe:1",
        "-nostats",
        str(out_path),
    ]

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )
    assert proc.stdin and proc.stdout and proc.stderr

    stderr_tail: list[str] = []

    def drain_stderr() -> None:
        for raw in iter(proc.stderr.readline, b""):
            line = raw.decode("utf-8", "replace").rstrip()
            if line:
                stderr_tail.append(line)
                if len(stderr_tail) > 80:
                    stderr_tail.pop(0)

    err_thread = threading.Thread(target=drain_stderr, daemon=True)
    err_thread.start()

    duration = max(0.1, float(info.get("duration") or frame_count / fps))

    def drain_progress() -> None:
        for raw in iter(proc.stdout.readline, b""):
            line = raw.decode("utf-8", "replace").strip()
            if line.startswith("out_time_us="):
                try:
                    micros = int(line.split("=", 1)[1])
                    ratio = max(0.0, min(0.99, micros / 1_000_000 / duration))
                    on_progress(0.05 + ratio * 0.82, "render", "FFmpeg 正在编码遮盖画面")
                except ValueError:
                    pass
            elif line == "progress=end":
                on_progress(0.9, "render", "编码完成，正在生成验证帧")

    progress_thread = threading.Thread(target=drain_progress, daemon=True)
    progress_thread.start()

    try:
        for index in range(frame_count):
            t = index / fps
            proc.stdin.write(render_frame(project, t, width, height))
            if index % 15 == 0:
                ratio = index / max(1, frame_count)
                on_progress(0.02 + ratio * 0.08, "mask", f"生成遮盖帧 {index + 1}/{frame_count}")
        proc.stdin.close()
    except BrokenPipeError as exc:
        proc.wait()
        err_thread.join(timeout=1)
        detail = "\n".join(stderr_tail[-20:])
        raise RuntimeError(f"FFmpeg 提前退出：\n{detail}") from exc

    return_code = proc.wait()
    err_thread.join(timeout=2)
    progress_thread.join(timeout=2)
    if return_code != 0:
        detail = "\n".join(stderr_tail[-30:])
        raise RuntimeError(f"FFmpeg 导出失败（{return_code}）：\n{detail}")


def export_project(
    project: dict[str, Any],
    source: Path,
    out_dir: Path,
    on_progress: ProgressCB | None = None,
) -> dict[str, Any]:
    def report(ratio: float, stage: str, message: str) -> None:
        if on_progress:
            on_progress(ratio, stage, message)

    out_dir.mkdir(parents=True, exist_ok=True)
    verify_dir = out_dir / "verify"
    verify_dir.mkdir(exist_ok=True)

    report(0.01, "probe", "读取原始视频信息")
    info = probe_video(source)
    fps = float(info["fps"])
    duration = float(info["duration"])
    frame_count = max(1, int(round(duration * fps)))

    padding = int(as_float((project.get("settings") or {}).get("padding"), 0))
    padding = max(0, padding - (padding % 2))

    audio_path = extract_audio(source, out_dir, info)
    report(0.03, "audio", "已保留独立原始音轨" if audio_path else "视频没有音轨，继续导出画面")

    out_path = out_dir / "masked.mp4"
    preferred_audio = "copy" if info.get("audioCodec") in {"aac", "mp3", "opus", "alac", "ac3", "eac3"} else "aac"
    try:
        _export_with_audio_mode(
            project, source, out_path, info, frame_count, fps, padding, preferred_audio, report
        )
    except RuntimeError:
        if not info.get("hasAudio") or preferred_audio == "aac":
            raise
        report(0.1, "audio", "直接复制音轨失败，改用 AAC 编码保留声音")
        _export_with_audio_mode(project, source, out_path, info, frame_count, fps, padding, "aac", report)

    report(0.91, "verify", "导出关键时点验证图片")
    manifest = export_verification_frames(project, source, out_path, verify_dir)

    config_path = out_dir / "mask-project.json"
    config_path.write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")

    report(1.0, "done", "导出完成")
    return {
        "video": out_path.name,
        "config": config_path.name,
        "audio": audio_path.name if audio_path else None,
        "verificationManifest": "verify/manifest.json",
        "verification": manifest,
        "width": info["width"] + padding * 2,
        "height": info["height"] + padding * 2,
        "fps": fps,
        "duration": duration,
        "frameCount": frame_count,
    }


def export_verification_frames(
    project: dict[str, Any], source: Path, final_video: Path, verify_dir: Path
) -> list[dict[str, Any]]:
    times: dict[float, list[str]] = {}
    for target in project.get("targets") or []:
        tname = target.get("name") or target.get("id")
        for key in target.get("keyframes") or []:
            t = round(as_float(key.get("t")), 3)
            times.setdefault(t, []).append(str(tname))

    manifest: list[dict[str, Any]] = []
    ffmpeg = ffmpeg_bin()
    for index, (t, names) in enumerate(sorted(times.items()), 1):
        stem = f"key_{index:03d}_t{t:07.3f}".replace(".", "p")
        original_name = f"{stem}_original.png"
        masked_name = f"{stem}_masked.png"
        original_path = verify_dir / original_name
        masked_path = verify_dir / masked_name

        # Output-side seeking decodes to the requested frame and is accurate.
        for src, dst in ((source, original_path), (final_video, masked_path)):
            cmd = [ffmpeg, "-y", "-i", str(src), "-ss", f"{t:.3f}", "-frames:v", "1", str(dst)]
            result = _run_simple(cmd, timeout=120)
            if result.returncode != 0 and not dst.exists():
                raise RuntimeError(f"验证帧导出失败 t={t:.3f}: {result.stderr[-500:]}")

        manifest.append(
            {
                "time": t,
                "targets": names,
                "original": f"verify/{original_name}",
                "masked": f"verify/{masked_name}",
            }
        )

    (verify_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return manifest
