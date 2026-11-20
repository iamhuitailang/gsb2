"""样例：参数化查询，外部数据只作为查询参数传入 —— 不应报告。"""
import os
import sqlite3


def main():
    uid = os.getenv("USER_ID")
    conn = sqlite3.connect("app.db")
    cur = conn.cursor()
    # 安全写法：数据通过参数传入，不拼进查询文本
    cur.execute("SELECT * FROM users WHERE id = ?", (uid,))
