#!/usr/bin/env python3
"""启动本地轮廓测量工具（仅监听 127.0.0.1）。

用法：python3 run_app.py [--port 8765] [--rebuild-demo]
"""
import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from core.app import create_app, DEMO_DIR          # noqa: E402
from core.demo_data import generate_all            # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--rebuild-demo", action="store_true",
                    help="启动前重新生成演示图")
    args = ap.parse_args()

    if args.rebuild_demo or not (DEMO_DIR / "ground_truth.json").exists():
        generate_all(DEMO_DIR)
        print(f"演示图已生成于 {DEMO_DIR}")

    app = create_app()
    print(f"轮廓测量工具已启动: http://{args.host}:{args.port}")
    print("按 Ctrl+C 退出")
    app.run(host=args.host, port=args.port, debug=False)


if __name__ == "__main__":
    main()
