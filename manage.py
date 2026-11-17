#!/usr/bin/env python3
"""本地运维小工具：取演示账号的当前口令、重置演示数据、跑一遍双窗口演示。"""

from __future__ import annotations

import argparse
import sys

import app
import otp


def cmd_code(args) -> int:
    center = app.AccountCenter()
    user = center.find_user(app.DEMO_USERNAME)
    if user is None:
        print("演示账号不存在，先运行 python3 manage.py reset", file=sys.stderr)
        return 1
    secret = user["totp_secret"] or user["totp_pending_secret"]
    if not secret:
        print("还没有验证器配置：先在 /settings 生成，再来取口令。", file=sys.stderr)
        return 1
    state = "已启用" if user["totp_enabled"] else "待启用"
    print(f"{otp.totp_code(secret)}  ({state}密钥，{otp.TOTP_PERIOD} 秒内有效)")
    return 0


def cmd_reset(args) -> int:
    center = app.AccountCenter()
    center.ensure_demo_user(reset=True)
    print(f"已重置演示账号 {app.DEMO_USERNAME}，密码 {app.DEMO_PASSWORD}，二次验证关闭。")
    return 0


def cmd_demo(args) -> int:
    import demo

    return demo.run(verbose=not args.quiet, rounds=args.rounds)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="gsb2 本地工具")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("code", help="打印演示账号当前验证器口令").set_defaults(func=cmd_code)

    reset = sub.add_parser("reset", help="重置演示账号")
    reset.set_defaults(func=cmd_reset)

    demo_parser = sub.add_parser("demo", help="自动跑一遍双窗口 + 同一备用码并发提交的场景")
    demo_parser.add_argument("--rounds", type=int, default=20, help="并发轮数，默认 20")
    demo_parser.add_argument("--quiet", action="store_true")
    demo_parser.set_defaults(func=cmd_demo)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
