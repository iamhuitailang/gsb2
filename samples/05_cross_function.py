"""示例 5：跨函数传播。

可解析的同文件函数调用会给出可能风险（medium），
因为上下文不敏感摘要无法逐次确认调用形态，按保守策略标注。
"""
import os
from flask import request


def build_command(user_value):
    prefix = "ls -l "
    return prefix + user_value


def handler():
    path = request.args.get("path", ".")
    cmd = build_command(path)
    os.system(cmd)


def parse_external(payload):
    # 外部库函数无法解析：污点降级为可能风险继续传播，而不是被静默丢弃
    cleaned = some_external_lib.sanitize(payload)  # noqa: F821 - 演示用未定义名
    return cleaned


def external_flow():
    raw = input("路径: ")
    value = parse_external(raw)
    os.popen("cat " + value)
