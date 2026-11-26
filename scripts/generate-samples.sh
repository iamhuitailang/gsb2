#!/usr/bin/env bash
# 生成多机位样例素材（纯本地 ffmpeg，合成内容，不含任何外部素材）。
# 不依赖 drawtext（部分 ffmpeg 构建不含 freetype），机位区分靠底色、帧率、运动。
#
# 产出 public/samples/：
#   camA_synctest_25fps.mp4   机位 A：6s，25fps，蓝色，每 1 秒一个同步点击声
#   camB_synctest_30fps.mp4   机位 B：8s，30fps，绿色，同一点击声但整体晚 0.8s
#                             （帧率/时长不同，用于演示帧对齐与越界警示）
#   reference_click.wav       独立参考音频：点击声比 A 早 0.5s，演示音频不同步对齐
#
# 三个文件的点击声是同一份“拍板轨”，仅前置静音长度不同；
# 工具的波形互相关应把偏移还原到 ±5ms（包络采样率 200Hz）以内。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/samples"
mkdir -p "$OUT"
cd "$OUT"

# 共同点击声：t=2,3,4,5s（相对各自音频时间轴）四个 80ms 的 1kHz 爆点，
# 叠加很轻的 220Hz 底噪模拟环境声。$1 为前置静音秒数。
clicks() {
  local pre="$1" dur="$2"
  local p0 p1 p2 p3
  p0=$(awk "BEGIN{printf \"%.0f\", ($pre+2)*1000}")
  p1=$(awk "BEGIN{printf \"%.0f\", ($pre+3)*1000}")
  p2=$(awk "BEGIN{printf \"%.0f\", ($pre+4)*1000}")
  p3=$(awk "BEGIN{printf \"%.0f\", ($pre+5)*1000}")
  echo "sine=frequency=1000:duration=0.08[c0];
       sine=frequency=1000:duration=0.08[c1];
       sine=frequency=1000:duration=0.08[c2];
       sine=frequency=1000:duration=0.08[c3];
       sine=frequency=220:duration=$dur[bed];
       [c0]adelay=$p0:all=1,apad=whole_dur=$dur[d0];
       [c1]adelay=$p1:all=1,apad=whole_dur=$dur[d1];
       [c2]adelay=$p2:all=1,apad=whole_dur=$dur[d2];
       [c3]adelay=$p3:all=1,apad=whole_dur=$dur[d3];
       [bed]volume=0.04[dbed];
       [d0][d1][d2][d3][dbed]amix=inputs=5:duration=longest:normalize=0,aresample=async=1:first_pts=0[a]"
}

# 机位 A：蓝色，25fps，6s，前置静音 0.2s -> 点击声在 2.2/3.2/4.2/5.2s
# 左上角固定白色标记块 + 底部色条作为机位 A 的视觉标识。
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=0x1d4ed8:s=640x360:r=25:d=6" \
  -filter_complex "$(clicks 0.2 6);
    [0:v]drawbox=x='mod(t*120\,560)':y=180:w=80:h=80:color=0x93c5fd:t=fill,
    drawbox=x=16:y=16:w=28:h=28:color=white:t=fill,
    drawbox=x=0:y=330:w=640:h=30:color=0x0c2d6b:t=fill[v]" \
  -map "[v]" -map "[a]" -c:v libx264 -pix_fmt yuv420p -c:a aac \
  camA_synctest_25fps.mp4

# 机位 B：绿色，30fps，8s，前置静音 1.0s -> 点击声在 3.0/4.0/5.0/6.0s
# 与 A 的点击声相差 0.8s；时长更长，切到 A 尾部时会出现“素材已结束”警示。
# 右上角白色标记块 + 底部色条作为机位 B 的视觉标识。
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=0x15803d:s=640x360:r=30:d=8" \
  -filter_complex "$(clicks 1.0 8);
    [0:v]drawbox=x='mod(t*90\,560)':y=150:w=100:h=100:color=0x86efac:t=fill,
    drawbox=x=596:y=16:w=28:h=28:color=white:t=fill,
    drawbox=x=0:y=330:w=640:h=30:color=0x0b4023:t=fill[v]" \
  -map "[v]" -map "[a]" -c:v libx264 -pix_fmt yuv420p -c:a aac \
  camB_synctest_30fps.mp4

# 参考音频：纯 WAV，点击声在 1.7/2.7/3.7/4.7s，
# 比机位 A 早 0.5s（对齐后 reference 的 offset 约为 -0.5s）。
ffmpeg -y -hide_banner -loglevel error \
  -filter_complex "
    sine=frequency=1000:duration=0.08[c0];
    sine=frequency=1000:duration=0.08[c1];
    sine=frequency=1000:duration=0.08[c2];
    sine=frequency=1000:duration=0.08[c3];
    sine=frequency=220:duration=5.5[bed];
    [c0]adelay=1700:all=1,apad=whole_dur=5.5[d0];
    [c1]adelay=2700:all=1,apad=whole_dur=5.5[d1];
    [c2]adelay=3700:all=1,apad=whole_dur=5.5[d2];
    [c3]adelay=4700:all=1,apad=whole_dur=5.5[d3];
    [bed]volume=0.04[dbed];
    [d0][d1][d2][d3][dbed]amix=inputs=5:duration=longest:normalize=0,aresample=async=1:first_pts=0[a]" \
  -map "[a]" -c:a pcm_s16le reference_click.wav

echo "样例已生成到 ${OUT}："
ls -lh "$OUT"
