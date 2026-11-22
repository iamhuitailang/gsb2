"""ffmpeg / ffprobe 封装：探测、原始像素抽取、范围转换、样例生成。

本模块只依赖标准库与系统 ffmpeg（要求 PATH 中存在 ffmpeg / ffprobe）。
所有输出文件都写入调用方指定的工作区目录，不改动源文件。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"

# 可零重编码修改范围标记的编码器（MP4/MOV 走码流 VUI bsf）
BSF_CODECS = {"h264": "h264_metadata", "hevc": "hevc_metadata"}
RANGE_LABEL = {"tv": "limited (TV, 16–235)", "pc": "full (PC, 0–255)"}


class FFmpegError(RuntimeError):
    def __init__(self, message: str, stderr: str = ""):
        super().__init__(message)
        self.stderr = stderr


def _run(cmd: list[str], timeout: int = 600) -> subprocess.CompletedProcess:
    try:
        proc = subprocess.run(
            cmd, capture_output=True, timeout=timeout, check=False
        )
    except FileNotFoundError as exc:  # pragma: no cover
        raise FFmpegError("系统中未找到 ffmpeg，请先安装并加入 PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise FFmpegError(f"ffmpeg 执行超时（>{timeout}s）: {' '.join(cmd[:3])} ...") from exc
    if proc.returncode != 0:
        raise FFmpegError(
            f"ffmpeg 返回码 {proc.returncode}",
            proc.stderr.decode("utf-8", "replace")[-4000:],
        )
    return proc


def ensure_tools() -> None:
    if not os.path.exists(FFMPEG) or not os.path.exists(FFPROBE):
        raise FFmpegError("未找到 ffmpeg/ffprobe，请先安装（如 brew install ffmpeg）")


# --------------------------------------------------------------------------- #
# 探测
# --------------------------------------------------------------------------- #

def probe(path: str) -> dict:
    """返回视频/音频流信息与容器信息。color_range 为 tv / pc / unknown。"""
    cmd = [
        FFPROBE, "-v", "error",
        "-show_format", "-show_streams",
        "-of", "json", path,
    ]
    proc = _run(cmd)
    data = json.loads(proc.stdout.decode("utf-8"))
    vstream = next((s for s in data.get("streams", [])
                    if s.get("codec_type") == "video"), None)
    astreams = [s for s in data.get("streams", [])
                if s.get("codec_type") == "audio"]
    fmt = data.get("format", {})

    info: dict = {
        "path": path,
        "basename": os.path.basename(path),
        "container": (fmt.get("format_name") or "").split(",")[0],
        "duration": _to_float(fmt.get("duration")),
        "size_bytes": int(fmt.get("size", 0) or 0),
        "has_audio": bool(astreams),
        "audio": [
            {
                "codec": s.get("codec_name"),
                "channels": s.get("channels"),
                "sample_rate": s.get("sample_rate"),
            }
            for s in astreams
        ],
        "video": None,
    }
    if vstream:
        num, den = (vstream.get("r_frame_rate") or "0/1").split("/")
        fps = float(num) / float(den) if float(den or 0) else 0.0
        info["video"] = {
            "codec": vstream.get("codec_name"),
            "width": vstream.get("width"),
            "height": vstream.get("height"),
            "pix_fmt": vstream.get("pix_fmt"),
            "color_range": vstream.get("color_range") or "unknown",
            "color_space": vstream.get("color_space") or "unknown",
            "color_primaries": vstream.get("color_primaries") or "unknown",
            "color_transfer": vstream.get("color_transfer") or "unknown",
            "fps": round(fps, 3),
        }
    return info


def count_frames(path: str) -> int:
    cmd = [
        FFPROBE, "-v", "error", "-count_frames",
        "-select_streams", "v:0",
        "-show_entries", "stream=nb_read_frames",
        "-of", "csv=p=0", path,
    ]
    proc = _run(cmd, timeout=900)
    out = proc.stdout.decode().strip()
    return int(out) if out.isdigit() else 0


# --------------------------------------------------------------------------- #
# 原始像素抽取（不经过任何范围自动转换，返回编码后的真实 YUV444p 字节）
# --------------------------------------------------------------------------- #

def extract_frame(path: str, frame_no: int, max_width: int = 960) -> tuple[bytes, int, int]:
    """抽取指定帧，输出原始 yuv444p（Y/U/V 三个平面，取值即文件内编码电平）。

    setparams 固定帧的范围属性，scale 显式同范围直通，确保缩放不触发任何
    电平重映射——前端拿到的 Y 就是码流里实际编码的电平。
    """
    src_rng = _declared_or_assumed(path)
    vf = (
        f"select=eq(n\\,{int(frame_no)}),"
        f"setparams=range={src_rng},"
        f"scale=w='min({max_width},iw)':h=-2:flags=lanczos:"
        f"in_range={src_rng}:out_range={src_rng},"
        f"format=yuv444p"
    )
    cmd = [
        FFMPEG, "-hide_banner", "-loglevel", "error",
        "-i", path,
        "-vf", vf,
        "-vframes", "1",
        "-f", "rawvideo", "-pix_fmt", "yuv444p", "-",
    ]
    proc = _run(cmd)
    w, h = _probe_dimensions(path, max_width)
    expected = w * h * 3
    if len(proc.stdout) < expected:
        raise FFmpegError(f"抽帧数据不完整：期望 {expected} 字节，实际 {len(proc.stdout)}")
    return proc.stdout[:expected], w, h


def _probe_dimensions(path: str, max_width: int) -> tuple[int, int]:
    info = probe(path)
    v = info["video"]
    w0, h0 = v["width"], v["height"]
    if w0 <= max_width:
        return w0, h0
    scale = max_width / w0
    import math
    w = max_width
    h = int(math.ceil(h0 * scale / 2) * 2)
    return w, h


def _declared_or_assumed(path: str) -> str:
    """抽帧时给 ffmpeg 的范围：有标记按标记；无标记按 limited 假设（不做转换，
    仅阻止解码器套用自动范围逻辑），前端两种解释都基于同一份原始 Y 自行渲染。"""
    rng = (probe(path).get("video") or {}).get("color_range", "unknown")
    return "jpeg" if rng == "pc" else "tv"


# --------------------------------------------------------------------------- #
# 电平统计
# --------------------------------------------------------------------------- #

def frame_stats(yuv: bytes, w: int, h: int) -> dict:
    """基于真实编码 Y 平面统计直方图/越界比例/灰阶条带电平。"""
    plane = yuv[: w * h]
    hist = [0] * 256
    for y in plane:
        hist[y] += 1
    total = len(plane)
    below = sum(hist[:16])
    above = sum(hist[236:])
    # 最暗 / 最亮的非空电平
    used = [i for i, c in enumerate(hist) if c]
    ymin, ymax = used[0], used[-1]
    mean = sum(i * c for i, c in enumerate(hist)) / total

    # 等宽 16 条灰阶带的代表电平（取每带内频数最高的电平）
    bands = []
    for b in range(16):
        lo, hi = b * 16, min(256, (b + 1) * 16)
        seg = hist[lo:hi]
        peak = lo + seg.index(max(seg))
        bands.append({"band": b, "lo": lo, "hi": hi - 1, "peak_y": peak,
                      "count": max(seg)})
    return {
        "histogram": hist,
        "y_min": ymin,
        "y_max": ymax,
        "y_mean": round(mean, 2),
        "below_16_pct": round(100.0 * below / total, 3),
        "above_235_pct": round(100.0 * above / total, 3),
        "bands": bands,
        "width": w,
        "height": h,
    }


# --------------------------------------------------------------------------- #
# 转换：仅改标记（不重编码） / 实际转换像素
# --------------------------------------------------------------------------- #

@dataclass
class ConvertResult:
    output_path: str
    mode: str           # retag | pixels
    target_range: str   # tv | pc
    declared_before: str
    declared_after: str
    assumed_source: str
    ffmpeg_cmd: str
    warning: str = ""
    lossless: bool = True   # retag 在 MP4/MOV 上无损；MKV 需一次保像素重编码


def _range_for_scale(rng: str) -> str:
    return "jpeg" if rng == "pc" else "tv"


def _encoder_args(codec: str) -> tuple[list[str], str]:
    """返回（编码器参数, 对应的 metadata bsf 名称）。"""
    if codec == "hevc":
        return (["-c:v", "libx265", "-tag:v", "hvc1"], "hevc_metadata")
    return (["-c:v", "libx264", "-crf", "16", "-preset", "medium",
             "-tag:v", "avc1"], "h264_metadata")


def _is_mkv(info: dict, out_path: str) -> bool:
    return info["container"] in ("matroska", "webm") or out_path.endswith((".mkv", ".webm"))


def _audio_args(info: dict, out_path: str) -> list[str]:
    """保留音轨：默认流复制；MP4 不支持的编码回退 AAC，保证音轨不丢。"""
    if not info["has_audio"]:
        return []
    audio_codec = (info["audio"][0] or {}).get("codec") or ""
    mp4_compatible = {"aac", "mp3", "alac", "ac3", "eac3", "flac", "opus"}
    if out_path.endswith((".mp4", ".mov", ".m4v")) and audio_codec not in mp4_compatible:
        return ["-map", "0:a?", "-c:a", "aac", "-b:a", "192k"]
    return ["-map", "0:a?", "-c:a", "copy"]


def convert_retag(path: str, target: str, out_path: str) -> ConvertResult:
    """只修正范围标记、不改变像素电平。

    MP4/MOV：范围标志在码流 VUI，用 metadata bsf 流复制，真正零重编码、无损。
    MKV/WebM：范围在容器 BlockGroup，ffmpeg 无法用流复制改写；这里用 setparams
    只改帧的范围属性（scale 同范围直通，像素值不变）后重编码，属“保像素但有损压缩”。
    """
    info = probe(path)
    v = info["video"]
    codec = v["codec"]
    declared = v["color_range"]
    warning = ""

    if _is_mkv(info, out_path):
        if codec not in BSF_CODECS:
            raise FFmpegError(
                f"MKV 内编码 {codec} 不支持改标记，请改用「实际转换像素」模式")
        if target == "tv":
            # ffmpeg 的 MKV muxer 只按帧属性写容器 ColourRange：要写 tv 就必须
            # 产出 limited 帧，full-range 像素会被钳位，无法做到“只改标记不动像素”
            raise FFmpegError(
                "MKV/WebM 容器无法在不改变像素的情况下把标记改成 limited："
                "其容器 ColourRange 元素由帧属性驱动，写 tv 时 full-range 电平"
                "（Y<16 / Y>235）会被钳位。请改用「实际转换像素」（电平被正确"
                "重映射而非硬钳），或先另存为 MP4 再做无损改标记。")
        enc_args, bsf_name = _encoder_args(codec)
        # tv->pc：setparams 把帧属性改为 full；scale 按 full 直通，电平不重映射
        vf = "setparams=range=jpeg,scale=in_range=jpeg:out_range=jpeg"
        cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
               "-i", path, "-vf", vf, "-map", "0:v:0"]
        cmd += _audio_args(info, out_path)
        cmd += enc_args
        cmd += ["-pix_fmt", "yuvj420p",
                "-bsf:v", f"{bsf_name}=video_full_range_flag=1",
                "-color_range", "pc", out_path]
        lossless = False
        warning = ("MKV 容器的范围标志无法流复制改写，本次为保持像素电平不变的"
                   "重编码（CRF16，电平不变但有压缩损失）；MP4 改标记则是完全无损的。")
    elif codec in BSF_CODECS:
        flag = 1 if target == "pc" else 0
        cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", path,
               "-map", "0:v:0"]
        cmd += _audio_args(info, out_path)
        cmd += ["-c:v", "copy",
                "-bsf:v", f"{BSF_CODECS[codec]}=video_full_range_flag={flag}",
                out_path]
        lossless = True
    else:
        raise FFmpegError(
            f"容器 {info['container']} / 编码 {codec} 不支持仅改标记，"
            "请改用「实际转换像素」模式"
        )
    _run(cmd, timeout=1800)
    after = probe(out_path)["video"]["color_range"]
    return ConvertResult(
        output_path=out_path, mode="retag", target_range=target,
        declared_before=declared, declared_after=after,
        assumed_source=declared if declared in ("tv", "pc") else "tv(假设)",
        ffmpeg_cmd=" ".join(cmd), warning=warning, lossless=lossless,
    )


def convert_pixels(path: str, source_range: str, target: str,
                   out_path: str) -> ConvertResult:
    """实际重映射像素电平并重新编码视频；音频原样复制，容器不变。"""
    info = probe(path)
    v = info["video"]
    declared = v["color_range"]
    src = _range_for_scale(source_range)
    dst = _range_for_scale(target)
    pix_fmt = "yuvj420p" if target == "pc" else "yuv420p"

    vf = f"scale=in_range={src}:out_range={dst}:flags=lanczos,format={pix_fmt}"
    cmd = [
        FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
        "-i", path,
        "-vf", vf,
        "-map", "0:v:0",
    ]
    # 有音轨则保留；MP4 不兼容的编码回退 AAC
    cmd += _audio_args(info, out_path)
    enc_args, bsf_name = _encoder_args(v["codec"])
    cmd += enc_args
    # MP4/MOV：显式把 full_range_flag 写进 VUI，limited 标记这样才可靠；
    # MKV：同样需要 bsf + pix_fmt 才能让容器元素写成 limited
    cmd += ["-pix_fmt", pix_fmt,
            "-bsf:v", f"{bsf_name}=video_full_range_flag={'1' if target == 'pc' else '0'}",
            "-color_range", target]
    cmd.append(out_path)
    _run(cmd, timeout=1800)

    after = probe(out_path)
    return ConvertResult(
        output_path=out_path, mode="pixels", target_range=target,
        declared_before=declared,
        declared_after=after["video"]["color_range"],
        assumed_source=source_range,
        ffmpeg_cmd=" ".join(cmd),
    )


# --------------------------------------------------------------------------- #
# 程序生成样例：灰阶阶梯 + 色条，带音轨
# --------------------------------------------------------------------------- #

# 上半幅：full-range 16 级灰阶阶梯（Y = 0,17,…,255）；下半幅：SMPTE 色条
SAMPLE_FILTER = (
    "color=c=black:s=1280x360:r=30:d=4,format=gray,"
    "geq=lum='17*floor(16*X/1280)':cb=128:cr=128,"
    "setparams=range=jpeg,format=yuvj444p[grayhalf];"
    "smptebars=s=1280x360:r=30:d=4,setparams=range=jpeg,"
    "format=yuvj444p[barhalf];"
    "[grayhalf][barhalf]vstack=inputs=2,"
    "setparams=range=jpeg,format=yuvj444p[vout]"
)

# 同一张图样，在 complex graph 内把 full 电平缩到 limited（不能再叠加 -vf）
SAMPLE_FILTER_LIMITED = SAMPLE_FILTER.replace(
    "setparams=range=jpeg,format=yuvj444p[vout]",
    "scale=in_range=jpeg:out_range=tv,setparams=range=tv,"
    "format=yuv420p[vout]",
)


def generate_samples(out_dir: str) -> list[dict]:
    """生成三份样例并回读校验，返回每份的探测与电平统计。"""
    os.makedirs(out_dir, exist_ok=True)
    base = os.path.join(out_dir, "ramp_bars")
    full_mp4 = base + "_full_correct_pc.mp4"
    wrong_mp4 = base + "_full_wrongtag_tv.mp4"
    limited_mp4 = base + "_limited_correct_tv.mp4"
    results = []

    def encode(out: str, pix_fmt: str, bsf_flag: int):
        # full-range 图样直接编码；标记由 VUI full_range_flag 决定，像素完全相同
        cmd = [
            FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
            "-filter_complex", SAMPLE_FILTER,
            "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
            "-map", "[vout]", "-map", "0:a:0",
            "-c:v", "libx264", "-crf", "16", "-preset", "medium",
            "-pix_fmt", pix_fmt,
            "-bsf:v", f"h264_metadata=video_full_range_flag={bsf_flag}",
            "-c:a", "aac", "-shortest", out,
        ]
        _run(cmd, timeout=900)

    # 1) full-range 像素 + 正确 pc 标记
    encode(full_mp4, "yuvj420p", 1)
    # 2) 同一份 full-range 像素 + 错误 tv 标记（典型“蒙灰”素材）
    encode(wrong_mp4, "yuvj420p", 0)
    # 3) 把全范围像素缩到 limited，再打正确的 tv 标记（标准广播/网络片）
    cmd = [
        FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
        "-filter_complex", SAMPLE_FILTER_LIMITED,
        "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
        "-map", "[vout]", "-map", "0:a:0",
        "-c:v", "libx264", "-crf", "16", "-preset", "medium",
        "-pix_fmt", "yuv420p",
        "-bsf:v", "h264_metadata=video_full_range_flag=0",
        "-c:a", "aac", "-shortest", limited_mp4,
    ]
    _run(cmd, timeout=900)

    for path, intent in [
        (full_mp4, "full-range 像素 + 正确 full 标记"),
        (wrong_mp4, "full-range 像素 + 错误 limited 标记（播放器会发灰）"),
        (limited_mp4, "limited-range 像素 + 正确 limited 标记"),
    ]:
        info = probe(path)
        yuv, w, h = extract_frame(path, 0)
        stats = frame_stats(yuv, w, h)
        results.append({
            "path": path,
            "filename": os.path.basename(path),
            "intent": intent,
            "declared_range": info["video"]["color_range"],
            "codec": info["video"]["codec"],
            "y_min": stats["y_min"],
            "y_max": stats["y_max"],
            "below_16_pct": stats["below_16_pct"],
            "above_235_pct": stats["above_235_pct"],
            "has_audio": info["has_audio"],
        })
    return results


def _to_float(v) -> float | None:
    try:
        return round(float(v), 3)
    except (TypeError, ValueError):
        return None
