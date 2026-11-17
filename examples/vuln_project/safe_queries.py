"""安全用法：参数化查询，污点只出现在参数位置，不应被报告。"""

import sqlite3

from flask import request


def placeholder_tuple():
    user_id = request.args.get("id")
    conn = sqlite3.connect("app.db")
    cursor = conn.cursor()
    # 安全：查询文本是常量，值通过第二个参数绑定
    cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    return cursor.fetchall()


def named_placeholder():
    params = {
        "name": request.form.get("name"),
        "age": request.form.get("age"),
    }
    conn = sqlite3.connect("app.db")
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM users WHERE name = :name AND age > :age",
        params,
    )
    return cursor.fetchall()


def keyword_parameters():
    user_id = request.args.get("id")
    conn = sqlite3.connect("app.db")
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM users WHERE id = %(id)s",
        {"id": user_id},
    )
    return cursor.fetchall()


def cast_before_query():
    """强转后污点被清除（int() 无法承载注入片段）。"""
    raw = request.args.get("id")
    user_id = int(raw)
    conn = sqlite3.connect("app.db")
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    return cursor.fetchall()


def executemany_safe():
    rows = request.json.get("rows", [])
    conn = sqlite3.connect("app.db")
    cursor = conn.cursor()
    cursor.executemany(
        "INSERT INTO users (name, age) VALUES (?, ?)",
        rows,
    )
    conn.commit()


def static_query_with_tainted_param():
    limit = request.args.get("limit")
    conn = sqlite3.connect("app.db")
    cursor = conn.cursor()
    # 安全：文本固定，污点在参数位
    cursor.execute("SELECT * FROM users LIMIT ?", (limit,))
    return cursor.fetchall()
