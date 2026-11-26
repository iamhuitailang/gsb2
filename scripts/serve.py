#!/usr/bin/env python3
"""零依赖静态服务器（仅标准库），支持 Range 请求，方便本地预览视频。

用法：python3 -I scripts/serve.py [--port 8123] [--root .]
直接双击 index.html 用 file:// 打开也可以，本服务器只是让视频 seek 更顺、
并能访问 public/samples 下用 ffmpeg 生成的样片。
"""
from __future__ import annotations

import argparse
import functools
import http.server
import os
import socketserver
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8123)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--root", type=Path, default=ROOT)
    args = ap.parse_args()

    root = str(args.root.resolve())
    handler = functools.partial(RangeHandler, directory=root)
    with ThreadingServer((args.host, args.port), handler) as httpd:
        url = f"http://{args.host}:{args.port}/index.html"
        print(f"立体校对工具已启动：{url}")
        print(f"根目录：{root}（Ctrl+C 退出）")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止")


if __name__ == "__main__":
    main()
