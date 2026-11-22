#!/bin/sh
# 一键跑测试并输出摘要。
set -eu
cd "$(dirname "$0")"
exec "${PYTHON:-python3}" -I -m unittest discover -s tests -v
