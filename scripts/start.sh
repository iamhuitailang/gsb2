#!/usr/bin/env bash
# 启动本地服务（仅绑定 127.0.0.1）。
set -euo pipefail
cd "$(dirname "$0")/.."

PYTHON="${PYTHON:-python3}"
DATABASE="${POLICY_DB_PATH:-data/policy.db}"
PORT="${PORT:-8000}"

exec "$PYTHON" -m app.cli --db "$DATABASE" serve --port "$PORT"
