#!/usr/bin/env python3
"""命令行入口的便捷封装，等价于 ``python -m lut_tool.cli``。

在隔离模式（``-I``）下也能从仓库根直接运行：

    python3 -I lut_tool.py check examples/samples/identity_3d.cube
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lut_tool.cli import main  # noqa: E402

if __name__ == "__main__":
    main()
