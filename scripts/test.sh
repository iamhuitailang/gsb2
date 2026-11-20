#!/usr/bin/env bash
# 运行自动化测试。
set -euo pipefail
cd "$(dirname "$0")/.."

PYTHON="${PYTHON:-python3}"
exec "$PYTHON" -m pytest "$@"
