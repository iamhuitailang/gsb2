#!/bin/sh
# 运行全部自动化测试（仅依赖 Python 标准库）。
# 用法：./run_tests.sh
set -e
cd "$(dirname "$0")"
python3 -m unittest discover -s tests -v
