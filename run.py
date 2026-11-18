#!/usr/bin/env python3
"""本机启动入口: python run.py [--port 8765]。

只绑定 127.0.0.1, 数据写入本地 data/jar.json, 全程无外部网络访问。
"""
from __future__ import annotations

import argparse
import os
import sys

from cookie_sim.webapp import create_server

DEFAULT_PORT = 8765


def main() -> int:
    parser = argparse.ArgumentParser(description="浏览器 Cookie 安全策略模拟器(仅本机)")
    parser.add_argument("--host", default="127.0.0.1", help="绑定地址, 默认仅本机回环")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"端口, 默认 {DEFAULT_PORT}")
    parser.add_argument(
        "--storage",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "jar.json"),
        help="cookie 数据文件路径",
    )
    args = parser.parse_args()

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("拒绝启动: 本模拟器只允许绑定本机回环地址", file=sys.stderr)
        return 2

    server = create_server(args.host, args.port, args.storage)
    url = f"http://{args.host}:{args.port}/"
    print("Cookie 安全策略模拟器已启动(仅本机, 无外部网络访问)")
    print(f"  打开: {url}")
    print(f"  数据: {args.storage}")
    print("  按 Ctrl+C 停止")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
