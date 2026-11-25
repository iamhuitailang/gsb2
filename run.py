#!/usr/bin/env python3
"""入口包装: 允许用 `python3 -I run.py ...` 运行 (隔离模式下 sys.path 不含 cwd)。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from reframer.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
