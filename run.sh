#!/usr/bin/env bash
# Start the temperature batch service.
# Usage: ./run.sh [port]
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-8000}"
export TEMP_DB_PATH="${TEMP_DB_PATH:-$PWD/data/temps.db}"
exec python3 -m uvicorn app.main:app --host 0.0.0.0 --port "$PORT"
