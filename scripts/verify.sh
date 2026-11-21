#!/bin/sh
# 一键自检：生成样例 -> 语法检查 -> 单元测试 -> 无头导出演练 -> 校验产物
set -e
cd "$(dirname "$0")/.."

echo "== node =="
node -v

echo "== 生成光栅样例 =="
node scripts/generate-samples.mjs

echo "== 语法检查 =="
for f in src/app.js src/lib/*.js scripts/*.mjs tests/*.mjs; do
  node --check "$f"
done

echo "== 单元测试 =="
node --test tests/imaging.test.mjs
node --test tests/project.test.mjs
node --test tests/batch.test.mjs

echo "== 无头导出演练 =="
rm -rf /tmp/tcp-out
node scripts/export.mjs --project samples/raster-project.json --assets samples/raster --out /tmp/tcp-out || true

echo "== 产物清单 =="
find /tmp/tcp-out -type f | sort
echo "== manifest =="
cat /tmp/tcp-out/manifest.txt
echo "== 一个来源说明 =="
cat "/tmp/tcp-out/砖墙 Brick Wall/ORM.source.txt" 2>/dev/null || true
echo "== 完成 =="