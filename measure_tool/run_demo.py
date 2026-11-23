#!/usr/bin/env python3
"""重新生成程序绘制的演示扫描图与 ground_truth.json。"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from core.demo_data import generate_all            # noqa: E402

if __name__ == "__main__":
    summary = generate_all(ROOT / "demo")
    print(f"已生成 {len(summary['images'])} 张演示图 -> {ROOT / 'demo'}")
    for img in summary["images"]:
        print(" -", img["image"])
