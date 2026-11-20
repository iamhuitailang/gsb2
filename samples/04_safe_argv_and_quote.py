"""示例 4：安全参数数组与安全引用（规则上安全，不应报注入）。"""
import shlex
import subprocess
from flask import request


def safe_argv():
    name = request.args.get("name", "")
    # 参数数组 + shell=False：name 只作为单个 argv 元素，即使含 ; | 等字符也不经过 shell
    subprocess.run(["echo", "hello", name], check=True)


def safe_quoted_string():
    host = request.args.get("host", "localhost")
    # 经过 shlex.quote 引用后再拼进 shell 字符串，元字符失去控制含义
    subprocess.run(f"ping -c 1 {shlex.quote(host)}", shell=True)


def safe_numeric():
    count = int(input("次数: "))
    subprocess.run(["sleep", str(count)])
