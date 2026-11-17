"""数据访问层：跨函数、跨文件、跨方法的污点传递示例。"""

import sqlite3


def build_query(user_id):
    """把传入的值拼进查询文本再返回 —— 污点在函数内继续传播。"""
    return "SELECT * FROM users WHERE id = " + user_id


def fetch_user(user_id):
    """跨函数风险：污点经过 build_query 到达 execute —— HIGH。"""
    conn = sqlite3.connect("app.db")
    cursor = conn.cursor()
    query = build_query(user_id)
    cursor.execute(query)
    return cursor.fetchall()


def fetch_user_safe(user_id):
    """安全写法：查询文本固定，值走参数绑定 —— 不应报告。"""
    conn = sqlite3.connect("app.db")
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    return cursor.fetchone()


class UserDAO:
    """通过实例字段在方法之间传递污点的场景。"""

    def __init__(self, db_path):
        self.db_path = db_path
        self.filter_value = None

    def set_filter(self, value):
        # 污点存入 self.filter_value
        self.filter_value = value

    def search(self):
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        # 风险：self.filter_value 来自外部输入并被拼进查询 —— HIGH
        cursor.execute(
            "SELECT * FROM users WHERE name = '" + self.filter_value + "'"
        )
        return cursor.fetchall()


def cross_file_entry(dao, value):
    """调用点把外部值送进对象字段，再由另一个方法拼成 SQL。"""
    dao.set_filter(value)
    return dao.search()


def partial_parameterized(table):
    """表名无法参数化而被拼接，但过滤值走了绑定 —— MEDIUM。"""
    conn = sqlite3.connect("app.db")
    cursor = conn.cursor()
    # 拼接部分仍可注入；参数化只保护了第二个值
    cursor.execute(
        "SELECT * FROM " + table + " WHERE status = ?",
        ("active",),
    )
    return cursor.fetchall()
