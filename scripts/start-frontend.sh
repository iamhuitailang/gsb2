#!/usr/bin/env bash
# 一键启动前端开发服务器（自动安装依赖）。
# 用法：./scripts/start-frontend.sh
set -euo pipefail

cd "$(dirname "$0")/../frontend"

if [ ! -d node_modules ]; then
  npm install
fi

exec npm run dev
