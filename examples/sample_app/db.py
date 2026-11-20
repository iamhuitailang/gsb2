"""示例项目：模拟一个数据库连接的获取。"""

import sqlite3


def get_connection():
    return sqlite3.connect("app.db")
