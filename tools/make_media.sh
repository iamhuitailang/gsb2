#!/usr/bin/env bash
# 程序化生成本地切换台所需的演示素材：
#   三段不同画幅/不同音调的短片 + 彩条图 + 临时插入板
# 用法: tools/make_media.sh   （在仓库根目录或任意目录执行均可）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/assets"
mkdir -p "$OUT"

# 短片1: 16:9, 12s, 440Hz 提示音
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=12" \
  -f lavfi -i "sine=frequency=440:duration=12" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$OUT/clip1_16x9.mp4"

# 短片2: 4:3, 10s, 550Hz
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=960x720:rate=30:duration=10" \
  -f lavfi -i "sine=frequency=550:duration=10" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$OUT/clip2_4x3.mp4"

# 短片3: 9:16 竖幅, 8s, 660Hz
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=720x1280:rate=30:duration=8" \
  -f lavfi -i "sine=frequency=660:duration=8" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$OUT/clip3_9x16.mp4"

# 彩条图（节目源/失效回退共用）
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "smptebars=size=1280x720:duration=1" \
  -frames:v 1 "$OUT/colorbars.png"

# 临时插入板
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "mandelbrot=size=1280x720:rate=1" \
  -frames:v 1 "$OUT/insert_slate.png"

echo "生成完成 -> $OUT"
ls -lh "$OUT"
