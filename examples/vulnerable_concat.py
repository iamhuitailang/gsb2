"""样例：命令行参数被拼接进查询 —— 应报告 SQLI001。"""
import sqlite3
import sys


def main():
    name = sys.argv[1]
    conn = sqlite3.connect("app.db")
    cur = conn.cursor()
    query = "SELECT * FROM users WHERE name = '" + name + "'"
    cur.execute(query)
