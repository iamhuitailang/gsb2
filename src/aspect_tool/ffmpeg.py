"""ffmpeg / ffprobe 调用封装: 抽帧、构造转码滤镜链、转码。

滤镜链与 geometry.py 的坐标映射保持同一套语义:
  存储帧 --(noautorotate + 显式 transpose 旋转/翻转)--> 中间帧
         --(scale 方形化, setsar=1)--> 显示平面 D
         --(pad=fit / crop=crop)--> 输出平面 O
输出文件不带显示矩阵、SAR=1, 播放器不会再多转一次。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

from .geometry import DisplayTransform, OutputPlan


class FFmpegError(RuntimeError):
    pass


def _ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        raise FFmpegError("未找到 ffmpeg, 请先安装并加入 PATH")
    return exe


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise FFmpegError(
            f"命令失败 ({proc.returncode}):\n  {' '.join(cmd)}\n{proc.stderr.strip()}"
        )
    return proc


# ---------------------------------------------------------------------------
# 抽帧
# ---------------------------------------------------------------------------

def extract_frame(path: str, at_sec: float, out_png: str, *,
                  autorotate: bool, width: int | None = None,
                  square_sar: bool = False) -> None:
    """抽取指定时间点的一帧为 PNG。

    autorotate=True  -> 播放器看到的正常显示方向 (应用显示矩阵)
    autorotate=False -> 原始存储像素方向 (不旋转)
    square_sar=True  -> 对非方形像素按 SAR 方形化 (纯 SAR 时 ffmpeg 的
                        autorotate 不会缩放, 需显式 scale 才能还原播放器画面)
    """
    cmd = [_ffmpeg(), "-y", "-loglevel", "error"]
    if not autorotate:
        cmd.append("-noautorotate")
    cmd += ["-ss", f"{max(0.0, at_sec):.3f}", "-i", path, "-frames:v", "1"]
    vf = []
    if square_sar:
        # 用 showinfo 探测后的 DAR 缩放: scale 到方形像素, 高度取偶
        vf.append("scale=w=iw*sar:h=ih")
    if width:
        vf.append(f"scale={width}:-2")
    if vf:
        cmd += ["-vf", ",".join(vf), "-vsync", "0"]
    cmd.append(out_png)
    _run(cmd)


def frame_at_index(path: str, index: int, out_png: str, *,
                   autorotate: bool, square_sar: bool = False) -> None:
    """按帧序号精确抽帧 (用于同时间点逐帧比较, 避免 -ss  seek 偏差)。"""
    cmd = [_ffmpeg(), "-y", "-loglevel", "error"]
    if not autorotate:
        cmd.append("-noautorotate")
    vf = [f"select=eq(n\\,{index})"]
    if square_sar and autorotate:
        vf.append("scale=w=iw*sar:h=ih")
    cmd += ["-i", path, "-vf", ",".join(vf), "-frames:v", "1",
            "-vsync", "0", out_png]
    _run(cmd)


# ---------------------------------------------------------------------------
# 滤镜链构造
# ---------------------------------------------------------------------------

def _transpose_chain(dt: DisplayTransform) -> list[str]:
    """把旋转/镜像翻成显式 transpose 滤镜 (输入已 -noautorotate)。

    ffmpeg transpose 方向:
      1 = clock (顺时针90), 2 = counter-clock (逆时针90),
      0 = cclock_flip (逆时针90+垂直翻转 = 水平镜像),
      3 = clock_flip (顺时针90+垂直翻转)
    镜像 + 旋转的组合用单个 transpose 的 *_flip 表达。
    """
    cw = dt.cw_deg
    rot = {0: [], 90: ["transpose=1"],
           180: ["transpose=1,transpose=1"],
           270: ["transpose=2"]}[cw]
    if not dt.flip:
        return rot
    # 镜像放在旋转之后 (顺序已经过 ffmpeg autorotate 像素级核对)
    return rot + ["hflip"]


def _square_filter(dt: DisplayTransform) -> list[str]:
    """旋转后的中间帧 -> 方形像素显示平面 D, 尺寸严格对齐 geometry 的 dw/dh。"""
    dw, dh = dt.dw, dt.dh
    # 直接 scale 到显示平面整数尺寸并 setsar=1, 等价于按 SAR 方形化
    return [f"scale=w={dw}:h={dh}:flags=lanczos", "setsar=1"]


def _output_filter(plan: OutputPlan) -> list[str]:
    """D -> O: fit 用 pad 补黑边, crop 用 crop 裁切后铺满。"""
    ow, oh = plan.ow, plan.oh
    if plan.mode == "fit":
        return [
            f"scale=w={ow}:h={oh}:force_original_aspect_ratio=decrease:flags=lanczos",
            f"pad=w={ow}:h={oh}:x=(ow-iw)/2:y=(oh-ih)/2:color=black",
            "setsar=1",
        ]
    x0, y0, x1, y1 = plan.crop_box_in_d
    crop_w = int(round(x1 - x0 + 1))
    crop_h = int(round(y1 - y0 + 1))
    cx = int(round(x0))
    cy = int(round(y0))
    return [
        f"crop=w={crop_w}:h={crop_h}:x={cx}:y={cy}",
        f"scale=w={ow}:h={oh}:flags=lanczos",
        "setsar=1",
    ]


def build_filter_chain(dt: DisplayTransform, plan: OutputPlan) -> str:
    parts = (_transpose_chain(dt) + _square_filter(dt) + _output_filter(plan))
    return ",".join(p for p in parts if p)


# ---------------------------------------------------------------------------
# 转码
# ---------------------------------------------------------------------------

def normalize(
    input_path: str,
    dt: DisplayTransform,
    plan: OutputPlan,
    output_path: str,
    *,
    keep_audio: bool = True,
    crf: int = 18,
) -> dict:
    """执行规范化转码, 返回 ffmpeg 命令与输出路径信息。"""
    chain = build_filter_chain(dt, plan)
    cmd = [_ffmpeg(), "-y", "-loglevel", "error", "-noautorotate",
           "-i", input_path]
    if keep_audio:
        cmd += ["-map", "0:v:0", "-map", "0:a:0?"]
    else:
        cmd += ["-map", "0:v:0"]
    cmd += ["-vf", chain,
            "-c:v", "libx264", "-preset", "medium", "-crf", str(crf),
            "-pix_fmt", "yuv420p"]
    if keep_audio:
        cmd += ["-c:a", "aac", "-b:a", "160k"]
    # 关键: 显式清除任何旋转/矩阵元数据
    cmd += ["-metadata:s:v:0", "rotate=", "-movflags", "+faststart",
            output_path]
    _run(cmd)
    return {"output": output_path, "filter_chain": chain, "command": cmd}


def count_frames(path: str) -> int:
    cmd = [shutil.which("ffprobe") or "ffprobe", "-v", "error",
           "-count_frames", "-select_streams", "v:0",
           "-show_entries", "stream=nb_read_frames",
           "-of", "json", path]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    data = json.loads(proc.stdout)
    return int(data["streams"][0]["nb_read_frames"])
