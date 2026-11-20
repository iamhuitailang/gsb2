"""样例：Web 请求参数经 str.format 进入查询 —— 应报告 SQLI001。"""
import sqlite3

from flask import request


def search():
    kw = request.args.get("q", "")
    conn = sqlite3.connect("app.db")
    cur = conn.cursor()
    sql = "SELECT * FROM items WHERE name LIKE '%{}%'".format(kw)
    cur.execute(sql)
