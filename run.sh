#!/usr/bin/env bash
# 一键启动本地全景拼接工具(仅监听 127.0.0.1, 不访问任何在线服务)
cd "$(dirname "$0")"
exec python3 -m app.server "$@"
