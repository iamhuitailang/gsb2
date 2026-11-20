#!/usr/bin/env python3
"""测试入口：在隔离模式下也能找到 sqli_scanner 包。

运行方式：
    python3 -I run_tests.py            # 运行全部测试
    python3 -I run_tests.py -v         # 详细输出
    python3 -I run_tests.py tests.test_analyzer   # 只跑某个测试模块
"""

import os
import sys
import unittest

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

if __name__ == "__main__":
    loader = unittest.TestLoader()
    argv = sys.argv[1:]
    if argv and not argv[0].startswith("-"):
        suite = loader.loadTestsFromNames(argv)
        verbosity = 2 if "-v" in argv else 1
    else:
        suite = loader.discover(os.path.join(ROOT, "tests"))
        verbosity = 2 if "-v" in argv else 1
    result = unittest.TextTestRunner(verbosity=verbosity).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
