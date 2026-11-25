#!/usr/bin/env bash
# 一键启动本地视频防抖工作台(自动检查 ffmpeg 与依赖)。
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "⚠ 未找到 ffmpeg。macOS 可执行: brew install ffmpeg"
  echo "  仍可启动, 但视频导出将退化为无声 mp4v。"
fi

PY="${PYTHON:-python3}"
if ! "$PY" -c "import flask, cv2, numpy" >/dev/null 2>&1; then
  echo "→ 正在安装 Python 依赖…"
  "$PY" -m pip install -r requirements.txt
fi

exec "$PY" app.py "$@"
