"""测试包：通过 sys.path 引导，使测试可用 `python -I -m unittest` 直接运行。"""

import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
