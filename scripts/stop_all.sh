#!/bin/bash
# 停止 start_all.sh 拉起的全部进程
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

for name in collector source-b source-a; do
  pidfile="data/${name}.pid"
  if [ -f "$pidfile" ]; then
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" && echo "[stop] $name (pid $pid)"
    fi
    rm -f "$pidfile"
  fi
done
