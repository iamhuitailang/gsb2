"""样例：污点跨函数传递 —— 应报告 SQLI001，路径中能看到函数间传递。"""
import sqlite3


def read_user_input():
    return input("name: ")


def build_query(name):
    return "SELECT * FROM users WHERE name = '%s'" % name


def run():
    name = read_user_input()
    q = build_query(name)
    conn = sqlite3.connect("app.db")
    conn.cursor().execute(q)
