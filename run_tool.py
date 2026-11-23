#!/usr/bin/env python3
"""工具入口。

即使以隔离模式 `python3 -I run_tool.py ...` 运行也能导入本包：
隔离模式不会把脚本目录自动放进 sys.path，这里显式注入。
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from keyframe_tool import genmedia, server  # noqa: E402
from keyframe_tool.ffmpeg_utils import ensure_tools  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="关键帧裁切检查工具")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_serve = sub.add_parser("serve", help="启动本机操作页面")
    p_serve.add_argument("--host", default="127.0.0.1")
    p_serve.add_argument("--port", type=int, default=8765)
    p_serve.add_argument("--out-dir", default=os.path.join(os.path.dirname(__file__), "outputs"))

    p_gen = sub.add_parser("generate", help="生成带帧号/长短 GOP/提示音的测试素材")
    p_gen.add_argument("--out-dir", default=os.path.join(os.path.dirname(__file__), "public", "samples"))

    sub.add_parser("selftest", help="端到端自测（生成素材 -> 两种裁切 -> 读回核对）")

    args = parser.parse_args()
    ensure_tools()

    if args.cmd == "serve":
        server.serve(args.host, args.port, args.out_dir)
    elif args.cmd == "generate":
        manifest = genmedia.generate(args.out_dir)
        print(f"已生成 {len(manifest['files'])} 个测试素材: {args.out_dir}")
        for name in manifest["files"]:
            print(" -", name)
        print("关键帧帧号:", manifest["keyframe_indices"])
    elif args.cmd == "selftest":
        from selftest import run_selftest

        return run_selftest()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
