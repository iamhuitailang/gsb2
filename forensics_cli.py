#!/usr/bin/env python3
"""命令行启动脚本，兼容 ``python3 -I`` 隔离模式。

``python3 -I -m forensics`` 在隔离模式下不会把当前目录加入 sys.path，
因此提供本入口：运行 ``python3 -I forensics_cli.py <子命令>`` 即可，
脚本所在目录（仓库根）会被显式加入 sys.path，不依赖 PYTHONPATH 等环境变量。
"""

from __future__ import annotations

import os
import sys

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from forensics.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
