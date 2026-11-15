#!/bin/sh
# 在仓库根目录运行全部单元测试
set -e
cd "$(dirname "$0")/.." || exit 1
python3 -m unittest discover -s tests -v
