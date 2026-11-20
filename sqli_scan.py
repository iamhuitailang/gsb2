#!/usr/bin/env python3
"""免安装启动器：python3 sqli_scan.py scan <项目路径>。

也可以在普通模式（非 -I）下使用 python3 -m sqli_scanner。
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sqli_scanner.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
