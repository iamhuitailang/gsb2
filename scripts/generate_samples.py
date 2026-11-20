#!/usr/bin/env python3
"""生成审片台演示样片（纯本地，无网络依赖）。

输出（samples/ 目录）：
  sample_v1.mp4 —— 3.0s @30fps，90 帧，原片
  sample_v2.mp4 —— 在 v1 第 40 帧后插入 15 帧蓝场，共 105 帧，修订版

设计要点：
  - 每帧画面包含帧号、时间码和一个随帧移动的圆点，形成唯一的“画面指纹”，
    供审片台在替换修订版时做画面相似度匹配；
  - v2 的第 55..104 帧与 v1 的第 40..89 帧画面一致（时间轴整体后移 15 帧），
    用于演示意见自动迁移；插入的 15 帧蓝场用于演示“待人工确认”。

用法：  python3 -I scripts/generate_samples.py
"""
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

W, H, FPS = 960, 540, 30
V1_FRAMES = 90
INSERT_AT = 40          # 在 v1 第 40 帧处插入
INSERT_FRAMES = 15      # 插入 15 帧（0.5s）

# SMPTE 风格彩条
BARS = [
    (192, 192, 192), (192, 192, 0), (0, 192, 192), (0, 192, 0),
    (192, 0, 192), (192, 0, 0), (0, 0, 192), (26, 26, 26),
]
BG = (24, 26, 32)
BLUE = (47, 111, 219)

FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT_REG = "/System/Library/Fonts/Supplemental/Arial.ttf"


def load_font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


F_NUM = load_font(FONT_BOLD, 64)
F_TC = load_font(FONT_BOLD, 30)
F_SMALL = load_font(FONT_REG, 22)
F_BAND = load_font(FONT_BOLD, 26)


def timecode(frame):
    h = frame // (FPS * 3600)
    m = (frame // (FPS * 60)) % 60
    s = (frame // FPS) % 60
    f = frame % FPS
    return f"{h:02d}:{m:02d}:{s:02d}:{f:02d}"


def draw_content_frame(src_frame, version_label):
    """绘制“内容帧”。src_frame 决定画面内容（彩条/圆点/帧号），与版本无关。"""
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # 顶部彩条
    bar_h = 110
    bw = W // len(BARS)
    for i, c in enumerate(BARS):
        d.rectangle([i * bw, 0, (i + 1) * bw - 1, bar_h], fill=c)

    # 固定的 LOGO 区域（给矩形标注演示用的静止参照物）
    d.rectangle([40, 150, 200, 250], outline=(220, 70, 70), width=3)
    d.text((120, 196), "LOGO", fill=(220, 70, 70), font=F_SMALL, anchor="mm")

    # 随帧移动的圆点——画面时间指纹
    cx = 70 + (src_frame * 9) % (W - 140)
    cy = 350
    d.ellipse([cx - 26, cy - 26, cx + 26, cy + 26], fill=(255, 214, 64), outline=(255, 255, 255), width=3)

    # 中央大帧号（内容身份 = 源帧号）
    d.text((W // 2, 250), f"FRAME {src_frame:03d}", fill=(235, 235, 235), font=F_NUM, anchor="mm")

    # 底部信息带
    d.rectangle([0, H - 64, W, H], fill=(10, 10, 14))
    d.text((24, H - 32), version_label, fill=(120, 220, 255), font=F_BAND, anchor="lm")
    d.text((W - 24, H - 32), timecode(src_frame), fill=(255, 255, 255), font=F_TC, anchor="rm")
    return img


def draw_insert_frame(insert_idx, timeline_frame):
    """插入段：纯蓝场 + 提示文字。"""
    img = Image.new("RGB", (W, H), BLUE)
    d = ImageDraw.Draw(img)
    d.text((W // 2, H // 2 - 50), "INSERTED SHOT", fill=(255, 255, 255), font=F_NUM, anchor="mm")
    d.text((W // 2, H // 2 + 30), f"revision-only clip  {insert_idx + 1:02d}/{INSERT_FRAMES:02d}",
           fill=(220, 230, 255), font=F_SMALL, anchor="mm")
    d.rectangle([0, H - 64, W, H], fill=(10, 10, 14))
    d.text((24, H - 32), "REVIEW SAMPLE V2", fill=(120, 220, 255), font=F_BAND, anchor="lm")
    d.text((W - 24, H - 32), timecode(timeline_frame), fill=(255, 255, 255), font=F_TC, anchor="rm")
    return img


def encode(frames, out_path):
    cmd = [
        "ffmpeg", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
        "-i", "-",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an",
        out_path,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for img in frames:
        proc.stdin.write(img.tobytes())
    proc.stdin.close()
    err = proc.stderr.read().decode("utf-8", "replace")
    code = proc.wait()
    if code != 0:
        sys.stderr.write(err)
        raise SystemExit(f"ffmpeg 编码失败：{out_path}")


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, "samples")
    os.makedirs(out_dir, exist_ok=True)

    v1 = [draw_content_frame(n, "REVIEW SAMPLE V1") for n in range(V1_FRAMES)]
    encode(v1, os.path.join(out_dir, "sample_v1.mp4"))

    v2 = []
    timeline = 0
    for n in range(INSERT_AT):                       # 与 v1 相同的前 40 帧
        v2.append(draw_content_frame(n, "REVIEW SAMPLE V2"))
        timeline += 1
    for k in range(INSERT_FRAMES):                   # 插入的蓝场
        v2.append(draw_insert_frame(k, timeline))
        timeline += 1
    for n in range(INSERT_AT, V1_FRAMES):            # v1 后续内容整体后移
        v2.append(draw_content_frame(n, "REVIEW SAMPLE V2"))
        timeline += 1
    encode(v2, os.path.join(out_dir, "sample_v2.mp4"))

    print(f"sample_v1.mp4: {V1_FRAMES} frames ({V1_FRAMES / FPS:.1f}s)")
    print(f"sample_v2.mp4: {timeline} frames ({timeline / FPS:.1f}s), "
          f"{INSERT_FRAMES} frames inserted after frame {INSERT_AT - 1}")


if __name__ == "__main__":
    main()
