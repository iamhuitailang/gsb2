#!/usr/bin/env bash
# 启动本地账号登录服务（纯标准库，无需安装依赖）
set -euo pipefail
cd "$(dirname "$0")"
exec python3 -m app.main
