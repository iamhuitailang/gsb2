"""示例项目：包含直接 SQL 注入风险的写法。

这个文件本身不会被运行，只作为 sqlaudit 的静态分析对象。
"""

import sqlite3

from flask import request


def direct_concat():
    """用户输入直接拼进查询文本 —— HIGH。"""
    user_id = request.args.get("id")
    conn = sqlite3.connect("app.db")
    cursor = conn.cursor()
    # 危险：字符串拼接进入 execute 的查询文本位置
    cursor.execute("SELECT * FROM users WHERE id = " + user_id)
    return cursor.fetchall()


def f_string_query():
    """f-string 插值进查询 —— HIGH。"""
    name = request.form["name"]
    conn = sqlite3.connect("app.db")
    cursor = conn.cursor()
    cursor.execute(f"SELECT * FROM users WHERE name = '{name}'")
    return cursor.fetchall()


def percent_format_query():
    """% 格式化进查询 —— HIGH。"""
    order_id = request.json.get("order_id")
    conn = sqlite3.connect("app.db")
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM orders WHERE id = %s" % order_id)
    return cursor.fetchall()


def format_method_query():
    """str.format 拼进查询 —— HIGH。"""
    table = request.args.get("table", "users")
    conn = sqlite3.connect("app.db")
    cursor = conn.cursor()
    cursor.execute("SELECT count(*) FROM {}".format(table))
    return cursor.fetchall()


def stdin_query():
    """内置 input() 也是用户可控源 —— HIGH。"""
    keyword = input("keyword: ")
    conn = sqlite3.connect("app.db")
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM products WHERE name LIKE '%" + keyword + "%'")
    return cursor.fetchall()
