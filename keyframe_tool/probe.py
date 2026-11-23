"""素材探测：显示时间、关键帧位置、轨道起点、音轨覆盖。

设计要点：
- ffprobe 的 packets 按解码顺序（DTS）给出，遇到含 B 帧（重排帧）的素材时，
  必须按 pts_time 重新排序，得到的才是播放器上的显示顺序。
- 所有时间同时保留两套：容器绝对时间 pts_time 和减去轨道起点后的显示时间。
- 帧类型（I/P/B）尽量通过 -show_frames 补充；取不到时关键帧仍可由 packet flags
  的 K 标记判定，其余帧类型标为 unknown，不硬猜。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from . import times
from .ffmpeg_utils import FFmpegError, ffmpeg_capture, ffprobe_json

# 超过该帧数的素材不算逐帧哈希，改用画面相似度做读回映射（耗时考虑）
HASH_FRAME_LIMIT = 3000


@dataclass
class FrameInfo:
    """一帧视频。idx 是显示顺序序号（0 起），与播放器里的帧号一致。"""

    idx: int
    pts_time: float          # 容器绝对时间
    display_time: float      # 显示时间（减去轨道起点）
    duration: float
    dts_time: float | None
    is_keyframe: bool
    pict_type: str           # I / P / B / unknown
    md5: str | None = None

    def to_dict(self) -> dict:
        return {
            "idx": self.idx,
            "pts_time": round(self.pts_time, 6),
            "display_time": round(self.display_time, 6),
            "duration": round(self.duration, 6),
            "dts_time": None if self.dts_time is None else round(self.dts_time, 6),
            "is_keyframe": self.is_keyframe,
            "pict_type": self.pict_type,
            "md5": self.md5,
        }


@dataclass
class ProbeResult:
    path: str
    format_start: float
    format_duration: float
    size: int
    video: dict
    audio: dict | None
    frames: list[FrameInfo]
    video_start: float = 0.0      # 视频流自身起点（视频 seek/trim 的换算基准）
    audio_start: float | None = None  # 音轨自身起点（atrim 的换算基准）
    warnings: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    has_hash: bool = False

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "format_start_time": round(self.format_start, 6),
            "format_duration": round(self.format_duration, 6),
            "video_start": round(self.video_start, 6),
            "audio_start": None if self.audio_start is None else round(self.audio_start, 6),
            "size": self.size,
            "video": self.video,
            "audio": self.audio,
            "frames": [f.to_dict() for f in self.frames],
            "keyframes": [f.idx for f in self.frames if f.is_keyframe],
            "warnings": self.warnings,
            "notes": self.notes,
            "has_hash": self.has_hash,
        }


def _to_float(value, default=None):
    if value in (None, "N/A"):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _parse_rate(rate: str) -> float | None:
    if not rate or rate == "0/0":
        return None
    num, _, den = rate.partition("/")
    den = float(den or 1)
    if den == 0:
        return None
    return float(num) / den


def _framemd5(path: str) -> list[str]:
    """用 ffmpeg framemd5 取每帧解码后画面的 MD5，输出即显示顺序。"""
    _, stdout, _ = ffmpeg_capture(["-i", path, "-an", "-f", "framemd5", "-"])
    hashes: list[str] = []
    for line in stdout.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split(",")]
        # 数据行：stream#, dts, pts, duration, size, hash（首字段为流号）
        if len(parts) >= 6 and parts[0].lstrip("-").isdigit():
            hashes.append(parts[-1])
    return hashes


def probe_media(path: str) -> ProbeResult:
    if not os.path.isfile(path):
        raise FFmpegError(f"文件不存在: {path}")

    head = ffprobe_json(path, "-show_format", "-show_streams")
    fmt = head.get("format", {})
    streams = head.get("streams", [])
    v_streams = [s for s in streams if s.get("codec_type") == "video"]
    a_streams = [s for s in streams if s.get("codec_type") == "audio"]
    if not v_streams:
        raise FFmpegError("文件中没有视频流，无法做关键帧裁切检查")

    warnings: list[str] = []
    notes: list[str] = []

    format_start = _to_float(fmt.get("start_time"), 0.0) or 0.0
    format_duration = _to_float(fmt.get("duration"), 0.0) or 0.0

    v = v_streams[0]
    v_start = _to_float(v.get("start_time"), format_start)
    if v_start is None:
        v_start = format_start

    # ---- 视频包：DTS 顺序，之后按 pts_time 重排成显示顺序 ----
    packets_raw = ffprobe_json(path, "-select_streams", "v:0", "-show_packets")
    raw_packets = packets_raw.get("packets", [])
    if not raw_packets:
        raise FFmpegError("视频流读不到任何包，源文件可能已损坏或读不全")

    packets = []
    for p in raw_packets:
        pts = _to_float(p.get("pts_time"))
        dts = _to_float(p.get("dts_time"))
        if pts is None:  # 极少数容器没有 pts，退化为 dts
            pts = dts
        if pts is None:
            continue
        packets.append(
            {
                "pts_time": pts,
                "dts_time": dts,
                "duration": _to_float(p.get("duration_time"), 0.0) or 0.0,
                "is_keyframe": "K" in (p.get("flags") or ""),
            }
        )
    # 稳定排序：pts 相同（罕见）时保留解码先后
    packets.sort(key=lambda p: p["pts_time"])

    # ---- 帧类型（显示顺序的 I/P/B），小素材直接取，取不到也不影响关键帧判断 ----
    pict_by_pts: dict[float, str] = {}
    try:
        frames_raw = ffprobe_json(path, "-select_streams", "v:0", "-show_frames")
        for fr in frames_raw.get("frames", []):
            pts = _to_float(fr.get("pts_time"))
            if pts is not None and fr.get("pict_type"):
                pict_by_pts[round(pts, 6)] = fr["pict_type"]
    except FFmpegError:
        notes.append("帧类型信息读取失败，关键帧仍以 packet 的 K 标记为准")

    reorder_detected = any(
        p["dts_time"] is not None and abs(p["dts_time"] - p["pts_time"]) > 1e-6
        for p in packets
    )
    if reorder_detected:
        notes.append("检测到重排帧（含 B 帧），时间线已按显示顺序（PTS）重排")

    # 典型帧时长，用于补 duration=0 的情况
    durations = sorted(p["duration"] for p in packets if p["duration"] > 0)
    typical_dur = durations[len(durations) // 2] if durations else 0.0
    if len(set(round(d, 6) for d in durations)) > 1:
        warnings.append("检测到可变帧间隔（VFR），帧时长不完全一致，吸附按最近帧处理")

    frames: list[FrameInfo] = []
    for i, p in enumerate(packets):
        duration = p["duration"] or typical_dur
        pict = pict_by_pts.get(round(p["pts_time"], 6), "unknown")
        if p["is_keyframe"] and pict == "unknown":
            pict = "I"
        frames.append(
            FrameInfo(
                idx=i,
                pts_time=p["pts_time"],
                display_time=times.to_display(p["pts_time"], v_start),
                duration=duration,
                dts_time=p["dts_time"],
                is_keyframe=p["is_keyframe"],
                pict_type=pict,
            )
        )

    # 读不全的信号：最后一帧时间戳与容器声明时长差太多
    last_end = frames[-1].pts_time + frames[-1].duration
    if format_duration and abs(last_end - (format_start + format_duration)) > 0.5:
        warnings.append(
            f"实际帧结尾 {times.hms(last_end)} 与容器声明时长 "
            f"{times.hms(format_start + format_duration)} 相差较大，源文件可能读不全"
        )

    # ---- 逐帧画面哈希，供裁切后精确比对源帧 ----
    has_hash = False
    if len(frames) <= HASH_FRAME_LIMIT:
        try:
            hashes = _framemd5(path)
            if len(hashes) == len(frames):
                for fr, h in zip(frames, hashes):
                    fr.md5 = h
                has_hash = True
            else:
                notes.append("framemd5 帧数与包数不一致，已跳过逐帧哈希，读回改用画面相似度")
        except FFmpegError as exc:
            notes.append(f"逐帧哈希失败，读回改用画面相似度: {str(exc)[:120]}")
    else:
        notes.append(f"素材超过 {HASH_FRAME_LIMIT} 帧，跳过逐帧哈希，读回使用画面相似度")

    # ---- 视频流信息 ----
    avg_fps = _parse_rate(v.get("avg_frame_rate", ""))
    video_info = {
        "codec": v.get("codec_name"),
        "width": v.get("width"),
        "height": v.get("height"),
        "pix_fmt": v.get("pix_fmt"),
        "start_time": round(v_start, 6),
        "display_start_time": round(times.to_display(v_start, format_start), 6),
        "avg_fps": round(avg_fps, 4) if avg_fps else None,
        "nb_frames": len(frames),
        "has_b_frames_field": v.get("has_b_frames"),
        "reorder_detected": reorder_detected,
    }

    # ---- 音轨覆盖范围（绝对时间 + 显示时间两套都给）----
    audio_info = None
    if a_streams:
        a = a_streams[0]
        a_start_stream = _to_float(a.get("start_time"), format_start)
        ap_raw = ffprobe_json(path, "-select_streams", "a:0", "-show_packets")
        ap = ap_raw.get("packets", [])
        ap_pts = [_to_float(x.get("pts_time")) for x in ap]
        ap_pts = [x for x in ap_pts if x is not None]
        if ap_pts:
            first_pts = min(ap_pts)
            last_pkt = max(ap, key=lambda x: _to_float(x.get("pts_time"), -1))
            last_dur = _to_float(last_pkt.get("duration_time"), 0.0) or 0.0
            last_pts = _to_float(last_pkt.get("pts_time"))
            a_end = last_pts + last_dur
        else:
            first_pts, a_end = a_start_stream, _to_float(a.get("duration"), 0.0) + format_start
        audio_info = {
            "codec": a.get("codec_name"),
            "sample_rate": int(a.get("sample_rate", 0) or 0),
            "channels": a.get("channels"),
            "stream_start_time": round(a_start_stream, 6),
            "first_packet_pts": round(first_pts, 6),
            "end_pts": round(a_end, 6),
            # 页面时间线使用显示时间
            "display_start": round(times.to_display(first_pts, format_start), 6),
            "display_end": round(times.to_display(a_end, format_start), 6),
            "nb_packets": len(ap),
        }
    else:
        notes.append("素材没有音轨，裁切时只处理视频")

    if abs(format_start) > 1e-6:
        notes.append(
            f"容器起点为 {times.hms(format_start)}（非零轨道起点），"
            "所有换算均已扣除该起点，不会被重复计为用户偏移"
        )

    return ProbeResult(
        path=os.path.abspath(path),
        format_start=format_start,
        format_duration=format_duration,
        size=int(fmt.get("size", 0) or 0),
        video=video_info,
        audio=audio_info,
        frames=frames,
        video_start=v_start,
        audio_start=_to_float(a_streams[0].get("start_time"), format_start) if a_streams else None,
        warnings=warnings,
        notes=notes,
        has_hash=has_hash,
    )


# ---------------- 时间线上的查询辅助 ----------------

def frame_at_display(frames: list[FrameInfo], display_time: float) -> FrameInfo:
    """显示时间吸附到最近的帧（显示顺序）。"""
    return min(frames, key=lambda f: abs(f.display_time - display_time))


def frame_containing_display(frames: list[FrameInfo], display_time: float) -> FrameInfo:
    """返回显示时间落在哪一帧的展示区间内；超出尾部则给最后一帧。

    半开区间语义：落在帧边界（=下一帧起点）时归属前一帧。
    时间戳是浮点（如 3.733333+0.033333=3.766666 与下一帧 3.766667 仅差 1ns），
    因此先找「起点 <= 输入」的最后一帧，再判断输入是否越过它的结束边界；
    只要未明显越过（容差为半个帧时长）就归属该帧，避免 1ns 噪声跳到下一帧。
    """
    if display_time <= frames[0].display_time + times.EPS:
        return frames[0]
    chosen = frames[0]
    for f in frames:
        # 上界不能放宽 EPS：浮点噪声常只有 1ns，放宽 1e-6 会把下一帧也吞进来
        if f.display_time <= display_time:
            chosen = f
        else:
            break
    end = chosen.display_time + chosen.duration
    # 明显越过当前帧结束边界（超过半个帧时长）才算下一帧
    if display_time > end + chosen.duration * 0.5 and chosen is not frames[-1]:
        return frames[chosen.idx + 1]
    return chosen


def nearest_keyframes(frames: list[FrameInfo], display_time: float) -> dict:
    """离指定显示时间最近的前一个 / 后一个关键帧（包含落在关键帧上的情况）。"""
    keys = [f for f in frames if f.is_keyframe]
    target = frame_at_display(frames, display_time)
    prev_k = next((f for f in reversed(keys) if f.display_time <= target.display_time + times.EPS), None)
    next_k = next((f for f in keys if f.display_time >= target.display_time - times.EPS), None)
    return {
        "at": target.to_dict(),
        "prev_keyframe": prev_k.to_dict() if prev_k else None,
        "next_keyframe": next_k.to_dict() if next_k else None,
    }
