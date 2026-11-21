#!/bin/sh
# 一次跑完：生成示例剧情 + 全部单测
set -e
cd "$(dirname "$0")/.."
node scripts/build-sample.js
node scripts/check.mjs
