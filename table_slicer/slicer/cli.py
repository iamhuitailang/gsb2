"""启动入口：python -m slicer.cli [项目目录] [--port 8765] [--no-browser]"""

from __future__ import annotations

import argparse
import threading
import webbrowser
from pathlib import Path

from .app import create_app


def main() -> None:
    parser = argparse.ArgumentParser(description="本地表格切格检查工具")
    parser.add_argument("project", nargs="?", default="./slicer_project",
                        help="项目数据目录（默认 ./slicer_project）")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    root = Path(args.project).resolve()
    root.mkdir(parents=True, exist_ok=True)
    app = create_app(root)
    url = f"http://{args.host}:{args.port}/"
    print(f"项目目录: {root}")
    print(f"服务地址: {url}  （Ctrl+C 退出）")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    app.run(host=args.host, port=args.port, debug=False)


if __name__ == "__main__":
    main()
