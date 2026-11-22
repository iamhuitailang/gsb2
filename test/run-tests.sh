#!/usr/bin/env bash
# run-tests.sh — 启动静态服务与无头 Chrome，依次跑单元测试和两套浏览器测试，结束自动清理
set -euo pipefail
cd "$(dirname "$0")/.."

PORT_HTTP=8901
PORT_CDP=9233
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROFILE="/tmp/occl-test-profile-$$"

cleanup() {
  [ -n "${CHROME_PID:-}" ] && kill "$CHROME_PID" 2>/dev/null || true
  [ -n "${HTTP_PID:-}" ] && kill "$HTTP_PID" 2>/dev/null || true
  rm -rf "$PROFILE" 2>/dev/null || true
}
trap cleanup EXIT

python3 -m http.server "$PORT_HTTP" --bind 127.0.0.1 >/tmp/occl-test-http.log 2>&1 &
HTTP_PID=$!
sleep 1

"$CHROME" --headless=new --disable-gpu --no-first-run --no-sandbox \
  --remote-debugging-port="$PORT_CDP" --user-data-dir="$PROFILE" \
  --window-size=1400,950 "http://127.0.0.1:$PORT_HTTP/index.html" >/tmp/occl-test-chrome.log 2>&1 &
CHROME_PID=$!

for _ in $(seq 1 20); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT_CDP/json" && break
  sleep 0.5
done

echo "===== 单元测试 ====="
node test/core.test.js
echo
echo "===== 浏览器测试 1（视图/冲突/路线/命中/截图） ====="
CDP_PORT=$PORT_CDP node test/browser.test.js
echo
echo "===== 浏览器测试 2（录制/导入导出/配置/重置） ====="
CDP_PORT=$PORT_CDP node test/browser2.test.js
