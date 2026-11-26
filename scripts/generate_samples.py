#!/usr/bin/env python3
"""生成两段几何测试短片（ffmpeg），用于在界面里走真实视频解码链路。

输出目录（默认 public/samples/，已在 .gitignore 中）：
  left.mp4   640x360 @25fps，4s，100 帧，基准画面
  right.mp4  同样规格，但故意带三路故障：
             1. 晚 4 帧（tpad 克隆首帧 + setpts 延迟 0.16s）
             2. 偏高 16px（裁顶 52px / 底 22px 后缩放回 360 高，再向上移 16px，底部留黑）
             3. 上下裁切（顶部多裁 ~14.4%、底部多裁 6.1%，不可逆）
  meta.json  记录故障参数与正确校回值

界面内置的 Canvas 样片（js/sample.js）参数与此一致，二选一即可。
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

W, H, FPS, DURATION = 640, 360, 25, 4
RIGHT_DELAY_FRAMES = 4
RIGHT_UP_PX = 16
CROP_TOP, CROP_BOTTOM = 52, 22  # 36 + 16，保证上移后顶部黑边也来自被裁区域


def run_ffmpeg(cmd: list[str]) -> None:
    print("+", " ".join(cmd), file=sys.stderr)
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr[-3000:])
        raise SystemExit(f"ffmpeg 失败，退出码 {proc.returncode}")


def base_source() -> str:
    """testsrc2 提供移动彩块与时间条纹；再叠加移动方块、中心环与四角标记。"""
    return (
        f"testsrc2=size={W}x{H}:rate={FPS}:duration={DURATION}"
        ",drawgrid=width=40:height=40:thickness=1:color=white@0.25"
        # 随时间左->右移动的方块（x 按秒 t 在 4s 内从 40 走到 520）
        ",drawbox=x=40+120*t:y=240:w=40:h=40:color=yellow@0.9:t=fill"
        # 中心标记
        ",drawbox=x=317:y=177:w=6:h=6:color=white:t=fill"
    )


def corner_marks(color: str) -> str:
    m, length = 16, 18
    parts = []
    for cx, cy, sx, sy in [
        (m, m, 1, 1), (W - m, m, -1, 1),
        (m, H - m, 1, -1), (W - m, H - m, -1, -1),
    ]:
        parts.append(
            f"drawbox=x={cx if sx > 0 else cx - length}:y={cy}:w={length}:h=2:color={color}:t=fill"
        )
        parts.append(
            f"drawbox=x={cx}:y={cy if sy > 0 else cy - length}:w=2:h={length}:color={color}:t=fill"
        )
    return "," + ",".join(parts)


def build_left(out: Path) -> None:
    vf = base_source() + corner_marks("green")
    run_ffmpeg([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", vf,
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-g", str(FPS), "-crf", "18",
        str(out),
    ])


def build_right(out: Path) -> None:
    # 顺序：先做几何故障（裁切->缩放->上移留黑），最后做时间延迟，
    # 避免 tpad 后再经过 scale 等滤镜时帧率被重采样、克隆帧被吃掉。
    # 1) 上下裁切 -> 缩回原尺寸（不可逆）
    cropped = f"crop={W}:{H - CROP_TOP - CROP_BOTTOM}:0:{CROP_TOP},scale={W}:{H}"
    # 2) 整体上移 16px：丢掉顶部 16 行、底部补 16 行黑（黑条保留在画面底部）
    shifted = f"crop={W}:{H - RIGHT_UP_PX}:0:{RIGHT_UP_PX}," \
              f"pad={W}:{H}:0:0:black"
    # 3) 时间晚 4 帧：克隆首帧填充开头，PTS 整体后移 0.16s，截回 100 帧
    delayed = (
        f"tpad=start_mode=clone:start_duration={RIGHT_DELAY_FRAMES / FPS},"
        f"setpts=PTS-STARTPTS+{RIGHT_DELAY_FRAMES}/{FPS}/TB"
    )
    vf = (
        f"testsrc2=size={W}x{H}:rate={FPS}:duration={DURATION},"
        f"drawgrid=width=40:height=40:thickness=1:color=white@0.25,"
        f"drawbox=x=40+120*t:y=240:w=40:h=40:color=yellow@0.9:t=fill,"
        f"drawbox=x=317:y=177:w=6:h=6:color=white:t=fill"
        f"{corner_marks('orange')},"
        f"{cropped},{shifted},{delayed}"
    )
    run_ffmpeg([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", vf,
        "-frames:v", str(FPS * DURATION),
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-g", str(FPS), "-crf", "18",
        str(out),
    ])


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("outdir", nargs="?", default="public/samples",
                    help="输出目录（默认 public/samples）")
    args = ap.parse_args()

    if not shutil.which("ffmpeg"):
        raise SystemExit("未找到 ffmpeg，请先安装（macOS: brew install ffmpeg）")

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    left, right = outdir / "left.mp4", outdir / "right.mp4"
    build_left(left)
    build_right(right)

    meta = {
        "spec": {"width": W, "height": H, "fps": FPS, "duration": DURATION,
                 "frames": FPS * DURATION},
        "rightDefects": {
            "delayFrames": RIGHT_DELAY_FRAMES,
            "delaySeconds": RIGHT_DELAY_FRAMES / FPS,
            "shiftUpPx": RIGHT_UP_PX,
            "cropTopPx": CROP_TOP,
            "cropBottomPx": CROP_BOTTOM,
        },
        "correction": {
            "left": {"timeOffset": 0.0, "verticalOffset": 0},
            "right": {"timeOffset": -RIGHT_DELAY_FRAMES / FPS,
                      "verticalOffset": RIGHT_UP_PX},
        },
        "files": {"left": left.name, "right": right.name},
    }
    (outdir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已生成: {left}")
    print(f"已生成: {right}")
    print(f"已生成: {outdir / 'meta.json'}")


if __name__ == "__main__":
    main()
