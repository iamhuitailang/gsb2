"""样例：动态查询结构 —— 应报告 SQLI002。

查询虽然对数据值使用了 ? 占位符，但表名由外部输入拼入，
占位符保护不了标识符部分。
"""
import sqlite3
import sys


def list_table(cur, table):
    cur.execute(f"SELECT * FROM {table} WHERE id = ?", (1,))


def main():
    conn = sqlite3.connect("app.db")
    list_table(conn.cursor(), sys.argv[1])
