#!/usr/bin/env python3
"""启动入口：python3 -I run.py web | scan <path> | check <code>。

显式把项目根目录加入 sys.path，使脚本在隔离模式（-I）下也能找到本包；
工作台自身代码是用户要求构建的本地代码，不影响“待检源码只解析不执行”的约束。
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from taintbench.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
