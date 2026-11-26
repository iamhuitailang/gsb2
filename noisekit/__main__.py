"""支持 `python3 -m noisekit ...` 调用, 等价于 python3 noisekit/cli.py。"""

from .cli import main

if __name__ == "__main__":
    raise SystemExit(main())
