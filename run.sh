#!/bin/sh
# 启动本地亮度范围检查页（纯标准库 + 系统 ffmpeg，无需安装依赖）
# 用法：./run.sh            默认端口 8791
#       PORT=9000 ./run.sh 自定义端口
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8791}" exec python3 -I app/server.py
