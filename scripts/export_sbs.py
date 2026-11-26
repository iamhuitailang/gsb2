#!/usr/bin/env python3
"""帧精确导出左右眼并排视频（ffmpeg），对齐设置可直接用界面保存的 JSON。

与页面内 MediaRecorder 导出的区别：
  - 逐帧 seek、重编码，起止帧精确，输出 MP4(H.264) 或 MKV/WEBM
  - 适合较长素材与归档；页面导出适合快速预览

时间模型与 js/core.js 完全一致：
  eyeT = T - timeOffset（timeOffset 正值 = 该眼画面偏晚）
  垂直：verticalOffset 正值 = 画面向下移（顶部补黑）

用法：
  python3 -I scripts/export_sbs.py \\
      --left public/samples/left.mp4 \\
      --right public/samples/right.mp4 \\
      --settings alignment.json \\
      --out out/sbs.mp4
也可不传 --settings，用命令行参数单独指定偏移与帧率。
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
from fractions import Fraction
from pathlib import Path


def ffprobe(path: Path) -> dict:
    if not path.exists():
        raise SystemExit(f"素材不存在：{path}")
    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,duration",
        "-show_entries", "format=duration",
        "-of", "json", str(path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(f"ffprobe 失败：{proc.stderr}")
    data = json.loads(proc.stdout)
    st = data["streams"][0]
    fr = st.get("r_frame_rate", "25/1")
    fps = float(Fraction(fr))
    if st.get("nb_frames") and st["nb_frames"].isdigit():
        n = int(st["nb_frames"])
    else:
        dur = float(st.get("duration") or data["format"]["duration"])
        n = max(1, round(dur * fps))
    return {
        "width": int(st["width"]), "height": int(st["height"]),
        "fps": fps, "frameCount": n,
    }


def eye_valid_range(meta: dict, offset: float, base_fps: float) -> tuple[int, int]:
    """与 core.js eyeValidRange 相同的半开区间 [lo, hi)。"""
    eps = 1e-9
    lo = math.ceil(base_fps * (offset - 0.5 / meta["fps"]) - eps)
    hi = math.ceil(base_fps * (offset + (meta["frameCount"] - 0.5) / meta["fps"]) - eps)
    return max(0, lo), max(0, hi)


def vertical_filter(vo: int, src_h: int) -> str:
    """正值 = 内容向下移（顶部补黑、底部等量裁掉），负值反之。
    全程字面像素值，输出尺寸严格保持 src_h。

    vo>0：pad 把输入钉在新画布 y=vo（顶部出现 vo 行黑），
          再从 y=0 裁 src_h 行 -> 黑边保留在顶部、输入底部 vo 行移出。
    vo<0：先从 y=-vo 裁（丢掉顶部 -vo 行），再在底部补 -vo 行黑。
    """
    if vo == 0:
        return "null"
    if vo > 0:
        return (f"pad=iw:{src_h + vo}:0:{vo}:black,"
                f"crop=iw:{src_h}:0:0")
    return (f"crop=iw:{src_h + vo}:0:{-vo},"
            f"pad=iw:{src_h}:0:0:black")


def build(args: argparse.Namespace) -> None:
    left_meta = ffprobe(args.left)
    right_meta = ffprobe(args.right)

    settings = {}
    if args.settings:
        settings = json.loads(Path(args.settings).read_text(encoding="utf-8"))

    eyes_cfg = settings.get("eyes", {})
    base_fps = args.base_fps or settings.get("baseFps") or max(
        left_meta["fps"], right_meta["fps"])

    l_off = args.left_time_offset if args.left_time_offset is not None \
        else eyes_cfg.get("left", {}).get("timeOffset", 0.0)
    r_off = args.right_time_offset if args.right_time_offset is not None \
        else eyes_cfg.get("right", {}).get("timeOffset", 0.0)
    l_vo = args.left_vertical if args.left_vertical is not None \
        else int(eyes_cfg.get("left", {}).get("verticalOffset", 0))
    r_vo = args.right_vertical if args.right_vertical is not None \
        else int(eyes_cfg.get("right", {}).get("verticalOffset", 0))

    l_lo, l_hi = eye_valid_range(left_meta, l_off, base_fps)
    r_lo, r_hi = eye_valid_range(right_meta, r_off, base_fps)
    lo = max(l_lo, r_lo, args.start_frame or 0)
    hi = min(l_hi, r_hi)
    if args.end_frame is not None:
        hi = min(hi, args.end_frame + 1)
    if hi <= lo:
        raise SystemExit("两路没有共同可导出区间（检查时间偏移与帧率设置）")

    out_h = max(left_meta["height"], right_meta["height"])
    if out_h % 2:
        out_h += 1
    l_w = round(left_meta["width"] * out_h / left_meta["height"])
    r_w = round(right_meta["width"] * out_h / right_meta["height"])
    l_w += l_w % 2
    r_w += r_w % 2
    out_w = l_w + r_w

    def chain(idx: int, meta: dict, off: float, vo: int) -> str:
        t0 = lo / base_fps - off
        t1 = hi / base_fps - off
        return (
            f"[{idx}:v]"
            f"trim=start={t0:.6f}:end={t1:.6f},setpts=PTS-STARTPTS,"
            f"{vertical_filter(vo, meta['height'])},"
            f"scale={l_w if idx == 0 else r_w}:{out_h},"
            f"setsar=1,fps={base_fps}[v{idx}]"
        )

    filter_complex = ";".join([
        chain(0, left_meta, l_off, l_vo),
        chain(1, right_meta, r_off, r_vo),
        f"[v0][v1]hstack=inputs=2[vout]",
    ])

    args.out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(args.left), "-i", str(args.right),
        "-filter_complex", filter_complex,
        "-map", "[vout]",
        "-r", str(base_fps),
        "-frames:v", str(hi - lo),
    ]
    if args.out.suffix.lower() == ".webm":
        cmd += ["-c:v", "libvpx-vp9", "-b:v", "8M"]
    else:
        cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
                "-preset", "medium"]
    cmd.append(str(args.out))

    print(f"左眼 {args.left} {left_meta['width']}x{left_meta['height']} "
          f"offset={l_off:+.3f}s vo={l_vo:+d}px 有效主帧[{l_lo},{l_hi})")
    print(f"右眼 {args.right} {right_meta['width']}x{right_meta['height']} "
          f"offset={r_off:+.3f}s vo={r_vo:+d}px 有效主帧[{r_lo},{r_hi})")
    print(f"导出共同主帧 [{lo},{hi})，共 {hi - lo} 帧，"
          f"输出 {out_w}x{out_h} @ {base_fps}fps -> {args.out}")
    print("+", " ".join(cmd), file=sys.stderr)
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr[-3000:])
        raise SystemExit(f"ffmpeg 失败，退出码 {proc.returncode}")

    # 导出后用 ffprobe 核对帧数与尺寸
    got = ffprobe(args.out)
    assert got["width"] == out_w and got["height"] == out_h, "导出尺寸不符"
    print(f"核对通过：{args.out} {got['width']}x{got['height']}，{got['frameCount']} 帧")


def main() -> None:
    if not shutil.which("ffmpeg"):
        raise SystemExit("未找到 ffmpeg")
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--left", required=True, type=Path)
    ap.add_argument("--right", required=True, type=Path)
    ap.add_argument("--settings", type=Path, help="界面保存的对齐设置 JSON")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--base-fps", type=float)
    ap.add_argument("--left-time-offset", type=float)
    ap.add_argument("--right-time-offset", type=float)
    ap.add_argument("--left-vertical", type=int)
    ap.add_argument("--right-vertical", type=int)
    ap.add_argument("--start-frame", type=int, help="主帧起点（默认共同区间起点）")
    ap.add_argument("--end-frame", type=int, help="主帧终点（含，默认共同区间末帧）")
    build(ap.parse_args())


if __name__ == "__main__":
    main()
