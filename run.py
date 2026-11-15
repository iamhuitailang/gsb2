#!/usr/bin/env python3
"""启动入口：python3 run.py [--db data/parking.db] [--port 8000]"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.server import serve  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description="停车记录配对处理台")
    parser.add_argument("--db", default="data/parking.db", help="SQLite 数据库路径")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    os.makedirs(os.path.dirname(os.path.abspath(args.db)), exist_ok=True)
    serve(args.db, args.host, args.port)


if __name__ == "__main__":
    main()
