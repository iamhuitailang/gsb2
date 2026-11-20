"""示例项目：本地辅助函数，污点会经这些函数继续传播。"""


def build_search_sql(keyword):
    # 辅助函数内部做字符串拼接，返回值仍然带污点
    return "SELECT * FROM products WHERE name LIKE '%" + keyword + "%'"


def wrap_table_name(name):
    # 只做透传，没有任何清洗
    return name


def table_from_request(request):
    # 从请求对象里取输入再返回，属于外部输入来源
    return request.args.get("table", "products")


def clean_keyword(keyword):
    # 清洗逻辑委托给无法静态解析的外部组件，
    # 工具无法确认清洗效果，这条链路会被标为待复核
    from external_sanitizer import escape_sql

    return escape_sql(keyword)
