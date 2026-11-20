"""示例 3：shell=True 的字符串与列表两种形态。"""
import subprocess
from flask import request


def string_shell():
    name = request.form["name"]
    # shell=True + 字符串：注入面
    subprocess.run("echo hello " + name, shell=True)


def list_with_shell_true():
    name = request.args.get("name", "")
    # shell=True 却传列表：subprocess 会把列表拼成 shell 字符串，仍按高危处理
    subprocess.Popen(["echo", name], shell=True)
