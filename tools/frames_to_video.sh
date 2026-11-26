#!/usr/bin/env bash
# 将导出的 PNG 序列合成为带透明通道的视频。
# 用法:
#   ./frames_to_video.sh <frames目录> [帧率] [输出文件名(不含扩展名)]
# 示例:
#   unzip 示例_PNG序列.zip -d seq
#   ./frames_to_video.sh seq/frames 30 title_alpha
set -euo pipefail

DIR="${1:?请传入 frame_0001.png 所在目录，例如 seq/frames}"
FPS="${2:-30}"
OUT="${3:-output_alpha}"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "未找到 ffmpeg。macOS 可执行: brew install ffmpeg" >&2
  exit 1
fi

# 序列命名为 frame_0001.png 起；若总帧数超过 9999，导出时会自动用更多位，
# 此时把 %04d 改成实际位数（如 %05d）。
PATTERN="$DIR/frame_%04d.png"
if ! ls "$DIR"/frame_*.png >/dev/null 2>&1; then
  echo "目录 $DIR 下没有找到 frame_*.png" >&2
  exit 1
fi

echo "==> 合成 ProRes 4444 MOV（透明通道，推荐剪辑软件使用）"
ffmpeg -y -framerate "$FPS" -start_number 1 -i "$PATTERN" \
  -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le "${OUT}.mov"

echo "==> 合成 VP9 WebM（透明通道，网页使用）"
ffmpeg -y -framerate "$FPS" -start_number 1 -i "$PATTERN" \
  -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 30 "${OUT}.webm"

echo "完成: ${OUT}.mov 与 ${OUT}.webm"
echo "注意: 普通 H.264 MP4 不支持透明通道，请勿使用 MP4 交付透明背景。"
