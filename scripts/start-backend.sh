#!/usr/bin/env bash
# 一键启动后端（自动创建虚拟环境并安装依赖）。
# 用法：./scripts/start-backend.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "错误：未找到 ffmpeg，请先按 README 安装 FFmpeg。" >&2
  exit 1
fi

if [ ! -d backend/.venv ]; then
  python3 -m venv backend/.venv
  backend/.venv/bin/pip install --upgrade pip
  backend/.venv/bin/pip install -r backend/requirements.txt
fi

exec backend/.venv/bin/uvicorn app.main:app \
  --app-dir backend \
  --host 127.0.0.1 --port 8000
