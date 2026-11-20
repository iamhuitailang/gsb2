"""场景三：参数绑定写法 —— 不应报为注入问题。"""

from .db import get_connection


def search_products_safe(request):
    keyword = request.args.get("keyword", "")
    conn = get_connection()
    cursor = conn.cursor()
    # 查询字符串是静态的，输入只走绑定参数
    cursor.execute(
        "SELECT * FROM products WHERE name = ?",
        (keyword,),
    )
    return cursor.fetchall()


def search_products_named_params(request):
    category = request.form.get("category")
    page = request.args.get("page", "1")
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM products WHERE category = :category LIMIT :page",
        {"category": category, "page": page},
    )
    return cursor.fetchall()


def executemany_safe(request):
    rows = request.json.get("rows", [])
    conn = get_connection()
    cursor = conn.cursor()
    cursor.executemany(
        "INSERT INTO products (name) VALUES (?)",
        rows,
    )
    conn.commit()
