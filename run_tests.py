#!/usr/bin/env python3
"""一键运行全部自动化测试（仅标准库，无需安装依赖）。

用法：python3 run_tests.py
"""
import os
import sys
import unittest

if __name__ == "__main__":
    repo_root = os.path.dirname(os.path.abspath(__file__))
    tests_dir = os.path.join(repo_root, "tests")
    sys.path.insert(0, repo_root)
    sys.path.insert(0, tests_dir)
    loader = unittest.TestLoader()
    suite = loader.discover(start_dir=tests_dir, pattern="test_*.py")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
