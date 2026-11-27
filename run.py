#!/usr/bin/env python3
"""隔离模式启动器：python3 -I run.py <参数...>

显式把仓库根目录加入 sys.path，保证 -I（隔离站点包/环境变量）下也能导入 framelab。
"""

import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

from framelab.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
