"""启发式 sink：定义无法在项目内解析、但名字明显与 SQL 执行相关。

这类发现给 LOW，提示人工确认，避免对未知封装保持沉默。
"""

from flask import request

# 外部库提供的函数，项目内没有它的定义，因此过程间分析无法解析
from some_external_db_lib import run_sql  # noqa: F401  仅作静态分析样例


def endpoint():
    keyword = request.args.get("keyword")
    # 名称命中启发式规则且定义不可解析 -> LOW
    run_sql("SELECT * FROM items WHERE name = '" + keyword + "'")
