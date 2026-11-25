#!/usr/bin/env python3
"""生成三套本地示例短片到 samples/ 目录。

用法:
    python3 make_samples.py            # 生成全部
    python3 make_samples.py shake      # 只生成轻微抖动
    python3 make_samples.py pan        # 只生成快速摇摄
    python3 make_samples.py cuts       # 只生成镜头切换

清理素材见 README.md 的「素材清理」一节。
"""

from __future__ import annotations

import sys
import time

from vstab.samples import generate_all, generate_clip, samples_status


def main() -> int:
    kind = sys.argv[1] if len(sys.argv) > 1 else "all"
    t0 = time.time()

    def progress(p: float, msg: str) -> None:
        bar_len = 28
        filled = int(bar_len * p)
        bar = "█" * filled + "░" * (bar_len - filled)
        print(f"\r[{bar}] {p * 100:5.1f}%  {msg:<32}", end="", flush=True)
        if p >= 1.0:
            print()

    if kind == "all":
        paths = generate_all(progress)
    elif kind in ("shake", "pan", "cuts"):
        paths = [generate_clip(kind, progress=progress)]
    else:
        print(f"未知类型: {kind}; 可选 all / shake / pan / cuts")
        return 2

    print(f"\n完成, 用时 {time.time() - t0:.1f}s:")
    for item in samples_status():
        if item["exists"]:
            print(f"  - {item['path']}  ({item['size_kb'] / 1024:.2f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
