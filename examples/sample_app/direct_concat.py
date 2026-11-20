"""场景一：直接拼接 / 格式化构造动态 SQL —— 应报为确认风险。"""

from .db import get_connection


def search_products_concat(request):
    keyword = request.args.get("keyword", "")
    # 直接字符串拼接
    query = "SELECT * FROM products WHERE name = '" + keyword + "'"
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(query)
    return cursor.fetchall()


def search_products_fstring(request):
    keyword = request.args.get("keyword", "")
    conn = get_connection()
    cursor = conn.cursor()
    # f-string 插值
    cursor.execute(f"SELECT * FROM products WHERE name = '{keyword}'")
    return cursor.fetchall()


def search_products_percent(request):
    category = request.form.get("category")
    conn = get_connection()
    cursor = conn.cursor()
    # % 格式化
    query = "SELECT * FROM products WHERE category = '%s'" % category
    cursor.execute(query)
    return cursor.fetchall()


def search_products_format(request):
    keyword = request.args["keyword"]
    conn = get_connection()
    cursor = conn.cursor()
    # str.format 拼接（经无法确认的调用，仍会识别出输入来源）
    query = "SELECT * FROM products WHERE name = '{}'".format(keyword)
    cursor.execute(query)
    return cursor.fetchall()
