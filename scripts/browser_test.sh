#!/usr/bin/env bash
# headless Chrome 自检 + 截图。
# 用法：bash scripts/browser_test.sh
# 产物：tmp/selftest.json、tmp/shots/*.png
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=8137
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || CHROME="$(command -v google-chrome || command -v chromium || true)"
[ -n "$CHROME" ] || { echo "找不到 Chrome/Chromium" >&2; exit 1; }

cd "$ROOT"
mkdir -p tmp/shots
PROFILE="$(mktemp -d)"
trap 'kill ${SERVER_PID:-} 2>/dev/null || true; rm -rf "$PROFILE"' EXIT

python3 -I scripts/serve.py --port "$PORT" >tmp/server.log 2>&1 &
SERVER_PID=$!

# 等服务器起来
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/index.html" >/dev/null && break
  sleep 0.1
done

BASE="http://127.0.0.1:$PORT/index.html"
CHROME_OPTS=(--headless=new --disable-gpu --no-first-run --no-default-browser-check
  --user-data-dir="$PROFILE" --window-size=1680,1000 --hide-scrollbars)

echo "== 自检断言 =="
ok=0
for budget in 12000 20000 30000; do
  "$CHROME" "${CHROME_OPTS[@]}" --virtual-time-budget="$budget" \
    --dump-dom "$BASE?selftest=1" > tmp/selftest.dom 2>tmp/chrome1.log || true
  if BUDGET="$budget" python3 - <<'PY'
import json, re, sys, os
from pathlib import Path
dom = Path("tmp/selftest.dom").read_text(encoding="utf-8", errors="replace")
m = re.search(r'<div[^>]*id="selftest"[^>]*>(.*?)</div>', dom, re.S)
if not m or not m.group(1).strip():
    print("  预算 %sms 未产出结果，重试…" % os.environ["BUDGET"], file=sys.stderr)
    sys.exit(2)
data = json.loads(m.group(1).strip())
Path("tmp/selftest.json").write_text(
    json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
for r in data["results"]:
    print(("  PASS " if r["ok"] else "  FAIL ") + r["name"]
          + ("" if r["ok"] else " -> " + r.get("error", "")))
sys.exit(0 if data["ok"] else 1)
PY
  then
    ok=1; break
  fi
  rc=$?
  [ "$rc" = "1" ] && { echo "自检存在失败用例" >&2; exit 1; }
done
[ "$ok" = "1" ] || { echo "自检多次重试仍未产出结果" >&2; exit 1; }

echo "== 截图：初始 / 样片并排 / 叠加 / 校回后 / 缺帧 =="
"$CHROME" "${CHROME_OPTS[@]}" --virtual-time-budget=12000 \
  --screenshot=tmp/shots/01-empty.png "$BASE" >/dev/null 2>&1 || true
"$CHROME" "${CHROME_OPTS[@]}" --virtual-time-budget=12000 \
  --screenshot=tmp/shots/02-samples-sbs.png "$BASE?demo=samples" >/dev/null 2>&1 || true
"$CHROME" "${CHROME_OPTS[@]}" --virtual-time-budget=12000 \
  --screenshot=tmp/shots/03-overlay.png "$BASE?demo=overlay" >/dev/null 2>&1 || true
"$CHROME" "${CHROME_OPTS[@]}" --virtual-time-budget=12000 \
  --screenshot=tmp/shots/04-corrected.png "$BASE?demo=corrected" >/dev/null 2>&1 || true
"$CHROME" "${CHROME_OPTS[@]}" --virtual-time-budget=12000 \
  --screenshot=tmp/shots/05-missing.png "$BASE?demo=missing" >/dev/null 2>&1 || true

ls -la tmp/shots
echo "浏览器自检全部通过"
