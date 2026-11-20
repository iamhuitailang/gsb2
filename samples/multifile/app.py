"""多文件示例：入口文件，与 services.py 一起检查。"""
from flask import request

from services import risky_helper


def endpoint():
    item = request.args.get("item", "")
    # 跨文件函数当前无法解析，调用点按可能风险保守处理（见 README 局限）
    risky_helper(item)
