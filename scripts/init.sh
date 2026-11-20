#!/usr/bin/env bash
# 初始化本地数据库；带 --baseline 时把基线样例激活为 v1。
set -euo pipefail
cd "$(dirname "$0")/.."

PYTHON="${PYTHON:-python3}"
DATABASE="${POLICY_DB_PATH:-data/policy.db}"

"$PYTHON" -m app.cli --db "$DATABASE" init "$@"
"$PYTHON" -m app.cli --db "$DATABASE" samples
