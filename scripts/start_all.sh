#!/bin/bash
# 启动两个模拟来源 + 采集后台（共 3 个进程）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p data logs

PY="${PYTHON:-python3}"

start() {
  local name="$1"; shift
  local pidfile="data/${name}.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "[skip] $name 已在运行 (pid $(cat "$pidfile"))"
    return
  fi
  nohup "$PY" "$@" > "logs/${name}.log" 2>&1 &
  echo $! > "$pidfile"
  echo "[start] $name (pid $!)"
}

start source-a app/mock_server.py source-a
start source-b app/mock_server.py source-b
start collector app/server.py

# 等采集后台健康检查通过
for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:${COLLECTOR_PORT:-8200}/health" >/dev/null 2>&1; then
    echo
    echo "全部启动完成："
    echo "  调度页面  http://127.0.0.1:${COLLECTOR_PORT:-8200}/"
    echo "  模拟来源甲 http://127.0.0.1:${SOURCE_A_PORT:-8101}/admin/quota"
    echo "  模拟来源乙 http://127.0.0.1:${SOURCE_B_PORT:-8102}/admin/quota"
    exit 0
  fi
  sleep 0.2
done
echo "[error] 采集后台未在 10 秒内就绪，请看 logs/collector.log" >&2
exit 1
