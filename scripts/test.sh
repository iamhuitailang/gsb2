#!/bin/sh
# 运行单元测试并生成样例素材
set -e
cd "$(dirname "$0")/.."
node --test tests/project.test.js tests/state.test.js tests/export.test.js
node scripts/generate-sample.mjs
