"""示例 1：直接拼接的命令注入（高危，确定风险）。"""
import os
from flask import Flask, request

app = Flask(__name__)


@app.route("/ping")
def ping():
    host = request.args.get("host")
    # 不可信输入直接拼接进 shell 字符串
    os.system("ping -c 1 " + host)
    return "ok"
