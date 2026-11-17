#!/usr/bin/env python3
"""测试启动器。

推荐以隔离模式运行, 避免从当前目录意外加载第三方同名模块:

    python3 -I run_tests.py

脚本会把仓库根目录显式加入 sys.path, 再交给 unittest 发现 tests/ 下的用例。
"""

import os
import sys
import unittest

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, REPO_ROOT)

if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = loader.discover(start_dir=os.path.join(REPO_ROOT, "tests"))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
