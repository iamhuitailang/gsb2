#!/usr/bin/env python3
"""启动 Tkinter 图形界面。"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lut_tool.app import main  # noqa: E402

if __name__ == "__main__":
    main()
