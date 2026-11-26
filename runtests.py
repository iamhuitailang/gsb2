"""本地运行测试的入口，避免依赖命令行参数被拦截。"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import pytest  # noqa: E402


def main() -> int:
    args = sys.argv[1:] or ["-q"]
    return pytest.main([str(ROOT / "tests"), *args])


if __name__ == "__main__":
    raise SystemExit(main())
