#!/bin/sh
# 依次跑语法/导入校验、单元测试与离线核对脚本。
set -e
cd "$(dirname "$0")/.."
node scripts/smoke.mjs
node --test tests/solver.test.js
node scripts/verify.mjs
