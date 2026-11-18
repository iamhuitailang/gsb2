#!/usr/bin/env python3
"""隔离模式启动包装器。

`python3 -I` 不会把脚本目录加入 sys.path(也忽略 PYTHONPATH),
因此先显式加入仓库根目录, 再把参数转交给 run.py。
用法: python3 -I run_isolated.py [--port 8765]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from run import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
