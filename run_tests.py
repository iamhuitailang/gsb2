"""测试入口：以隔离模式（-I 语义）运行全部 unittest 用例。

用法：
    python3 -I run_tests.py
"""

from __future__ import annotations

import os
import sys
import unittest

# -I 隔离模式不会把当前目录加入 sys.path，这里显式加入仓库根目录，
# 保证 forensics 包可被导入，同时仍然不读取 PYTHONPATH/用户 site 包。
REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = loader.discover(start_dir=os.path.join(REPO_ROOT, "tests"),
                            pattern="test_*.py")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
