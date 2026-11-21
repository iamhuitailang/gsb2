#!/bin/sh
# 依次执行语法检查与断言测试；不写任何文件，避免污染工作区。
set -u
cd "$(dirname "$0")/.." || exit 1

echo "== 语法检查 =="
status=0
for f in js/engine.js js/samples.js js/app.js server.js tests/run.js; do
  if node --check "$f"; then
    echo "ok   $f"
  else
    echo "FAIL $f"
    status=1
  fi
done

echo "== 断言测试 =="
node tests/run.js || status=1

exit "$status"
