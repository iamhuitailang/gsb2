import os
import sys

# 支持 `python -I -m unittest discover`：隔离模式不自动加入 cwd
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
