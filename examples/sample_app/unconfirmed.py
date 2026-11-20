"""场景四：无法确认的复杂调用 —— 应标为待复核（review），不算确定漏洞。"""

from some_unknown_lib import build_query  # 虚构的第三方库，扫描时不会真的导入

from .db import get_connection
from .helpers import clean_keyword


def search_unresolved(request):
    keyword = request.args.get("keyword", "")
    # 输入先进入无法解析的第三方函数，其返回值再被拼进 SQL
    query_fragment = build_query(keyword)
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM products WHERE " + query_fragment)
    return cursor.fetchall()


def search_with_external_cleaner(request):
    keyword = clean_keyword(request.args.get("keyword", ""))
    conn = get_connection()
    cursor = conn.cursor()
    # 清洗函数内部依赖了无法确认的调用，无法判定是否安全
    cursor.execute("SELECT * FROM products WHERE name = '" + keyword + "'")
    return cursor.fetchall()
