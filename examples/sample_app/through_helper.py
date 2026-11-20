"""场景二：外部输入经本地辅助函数传递后进入 SQL —— 应报为确认风险。"""

from .db import get_connection
from .helpers import build_search_sql, wrap_table_name, table_from_request


def search_via_helper(request):
    keyword = request.args.get("keyword", "")
    # 输入 -> 本地辅助函数拼接 -> execute
    query = build_search_sql(keyword)
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(query)
    return cursor.fetchall()


def dynamic_table(request):
    # 输入经两个辅助函数传递，表名无法参数绑定
    table = wrap_table_name(table_from_request(request))
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM " + table)
    return cursor.fetchall()
