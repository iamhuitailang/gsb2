"""本地验证入口：python3 tools/run_tests.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
suite = unittest.defaultTestLoader.discover(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tests"))
result = unittest.TextTestRunner(verbosity=2).run(suite)
sys.exit(0 if result.wasSuccessful() else 1)
