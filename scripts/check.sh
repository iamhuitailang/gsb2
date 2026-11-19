#!/bin/sh
# 运行核心单元测试并做类型检查（若已安装依赖）。
set -e
cd "$(dirname "$0")"
echo "== node --test =="
node --test src/core/simulation.test.ts
if [ -x node_modules/.bin/tsc ]; then
  echo "== tsc --noEmit =="
  node_modules/.bin/tsc --noEmit
else
  echo "(跳过 tsc：未安装依赖，先运行 npm install)"
fi
