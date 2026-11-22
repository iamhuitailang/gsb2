#!/usr/bin/env bash
# 启动采样率转换试听台（优先用仓库内 .venv）
set -euo pipefail
cd "$(dirname "$0")"
if [ -x ".venv/bin/python" ]; then
  PY=".venv/bin/python"
else
  PY="python3"
fi
exec "$PY" -m srbench.gui_main
