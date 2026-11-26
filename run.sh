#!/usr/bin/env bash
# NoiseKit 一键启动: 缺依赖时提示安装, 自动生成样音, 启动本地服务
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"

if ! "$PYTHON" -c "import numpy, soundfile" 2>/dev/null; then
  echo "缺少依赖, 正在安装: $PYTHON -m pip install -r requirements.txt"
  "$PYTHON" -m pip install -r requirements.txt
fi

if [ ! -f public/samples/manifest.json ]; then
  echo "首次运行: 生成演示样音 ..."
  "$PYTHON" noisekit/cli.py generate-samples
fi

PORT="${1:-8765}"
exec "$PYTHON" noisekit/server.py --port "$PORT"
