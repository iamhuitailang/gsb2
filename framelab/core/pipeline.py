"""分析流水线与导出：把 mapping/ffmpeg/project_store 串起来。"""

from __future__ import annotations

import csv
import json
import os

from .ffmpeg_tools import (
    FFmpegError,
    build_convert_command,
    extract_frame,
    probe,
    run_convert,
)
from .mapping import build_mapping
from .project_store import cache_key, project_dir, save_project


def analyze_source(project: dict, read_frames: bool = True) -> dict:
    """探测源素材。失败时把错误写回项目并保留已有分析结果后重新抛出。"""

    src = project["source"]["path"]
    try:
        info = probe(src, read_frames=read_frames)
    except FFmpegError as e:
        project["source"]["analyze_error"] = str(e)
        raise
    project["source"]["probe"] = info
    project["source"]["analyzed"] = True
    project["source"]["analyze_error"] = None
    project["mapping_cache"] = {}
    return info


def compute_mapping(project: dict) -> dict:
    """按当前设置计算（或取缓存）时间映射。"""

    if not project["source"].get("analyzed"):
        raise RuntimeError("源素材尚未完成分析")
    info = project["source"]["probe"]
    s = project["settings"]
    key = cache_key(s)
    cached = project["mapping_cache"].get(key)
    if cached:
        return cached

    src_fps = (info["video"] or {}).get("fps") or 30.0
    src_count = info["frame_count"] or int(info["duration"] * src_fps)
    src_times = info["frame_times"] if info.get("is_vfr") else None

    result = build_mapping(
        src_fps=src_fps,
        src_count=src_count,
        dst_fps=s["dst_fps"],
        speed=s["speed"],
        method=s["method"],
        src_times=src_times,
    )
    payload = result.to_dict()
    project["mapping_cache"][key] = payload
    return payload


def frame_preview(workspace: str, project: dict, src_index: int) -> str:
    """抽取源帧 JPEG（按帧序号换算时间点），返回相对项目目录的路径。"""

    info = project["source"]["probe"]
    fps = (info["video"] or {}).get("fps") or 30.0
    times = info.get("frame_times") or []
    if src_index < len(times):
        t = times[src_index]
    else:
        t = src_index / fps

    pdir = project_dir(workspace, project["id"])
    fdir = os.path.join(pdir, "frames")
    os.makedirs(fdir, exist_ok=True)
    rel = f"src_{src_index:06d}.jpg"
    out = os.path.join(fdir, rel)
    if not os.path.exists(out):
        extract_frame(project["source"]["path"], t, out)
    return rel


def export_manifest(workspace: str, project: dict, mapping: dict) -> tuple[str, str]:
    """导出时间映射清单（CSV + JSON），返回两个绝对路径。"""

    pdir = project_dir(workspace, project["id"])
    edir = os.path.join(pdir, "export")
    os.makedirs(edir, exist_ok=True)
    stamp = _stamp()
    csv_path = os.path.join(edir, f"mapping_{stamp}.csv")
    json_path = os.path.join(edir, f"mapping_{stamp}.json")

    fields = [
        ("out_index", "输出帧序号"),
        ("out_timecode", "输出时间码"),
        ("out_time", "输出时间(秒)"),
        ("kind", "帧类型"),
        ("src_index", "源帧序号"),
        ("src_index_2", "混合源帧2"),
        ("blend_weight", "混合权重"),
        ("src_timecode", "源时间码"),
        ("src_time", "源时间(秒)"),
    ]
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        writer.writerow([label for _, label in fields])
        for row in mapping["rows"]:
            writer.writerow([
                "" if row[k] is None else row[k] for k, _ in fields
            ])

    payload = {
        "source": project["source"]["path"],
        "settings": project["settings"],
        "stats": mapping["stats"],
        "rows": mapping["rows"],
    }
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return csv_path, json_path


def make_preview(workspace: str, project: dict, seconds: float = 2.0) -> str:
    """生成前 N 秒短预览，滤镜链与正式导出完全一致。返回绝对路径。"""

    info = project["source"].get("probe")
    if not info:
        raise RuntimeError("源素材尚未完成分析")
    s = project["settings"]
    pdir = project_dir(workspace, project["id"])
    fdir = os.path.join(pdir, "frames")
    os.makedirs(fdir, exist_ok=True)
    out_path = os.path.join(fdir, "preview.mp4")

    cmd = build_convert_command(
        src=project["source"]["path"],
        dst=out_path,
        dst_fps=float(s["dst_fps"]),
        speed=float(s["speed"]),
        method=s["method"],
        keep_pitch=bool(s["keep_pitch"]),
        has_audio=bool(info.get("has_audio")),
    )
    # 在输入处截取前 seconds 秒（-t 插在 -i 之后），保持滤镜链不变
    idx = cmd.index("-i") + 2
    cmd[idx:idx] = ["-t", str(seconds)]
    ok, tail = run_convert(cmd)
    if not ok:
        raise FFmpegError(f"预览生成失败：{tail[-300:]}")
    return out_path


def export_video(workspace: str, project: dict) -> dict:
    """执行视频导出。任何阶段失败都先保存项目，已完成的分析结果不丢失。"""

    info = project["source"].get("probe")
    if not info:
        raise RuntimeError("源素材尚未完成分析")
    s = project["settings"]
    pdir = project_dir(workspace, project["id"])
    edir = os.path.join(pdir, "export")
    os.makedirs(edir, exist_ok=True)
    stamp = _stamp()
    out_path = os.path.join(edir, f"output_{stamp}.mp4")

    cmd = build_convert_command(
        src=project["source"]["path"],
        dst=out_path,
        dst_fps=float(s["dst_fps"]),
        speed=float(s["speed"]),
        method=s["method"],
        keep_pitch=bool(s["keep_pitch"]),
        has_audio=bool(info.get("has_audio")),
        video_codec=s.get("video_codec", "libx264"),
        crf=int(s.get("crf", 18)),
        preset=s.get("preset", "medium"),
    )

    log_lines: list[str] = []
    ok, tail = run_convert(cmd, progress_cb=log_lines.append)
    log_path = os.path.join(pdir, "convert.log")
    try:
        with open(log_path, "w", encoding="utf-8") as f:
            f.write("\n".join(log_lines[-500:]))
    except OSError:
        pass

    record = {
        "time": stamp,
        "output": os.path.basename(out_path),
        "command": cmd,
        "ok": ok,
        "log_tail": tail,
    }
    project["exports"].append(record)
    # 成功或失败都落盘——失败时分析结果与失败命令一起保留
    save_project(workspace, project)
    if not ok:
        raise FFmpegError(f"转码失败，日志见 convert.log：{tail[-300:]}")
    return record


def _stamp() -> str:
    import time
    return time.strftime("%Y%m%d_%H%M%S")
