"""便捷测试入口：python3 scripts/run_tests.py [pytest 参数]"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import pytest  # noqa: E402

if __name__ == "__main__":
    args = sys.argv[1:] or ["tests"]
    raise SystemExit(pytest.main(["-q", *args]))
