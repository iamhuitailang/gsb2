#!/usr/bin/env bash
# 运行全部测试
set -euo pipefail
cd "$(dirname "$0")"
exec python3 -m unittest discover -t . -s tests -v
