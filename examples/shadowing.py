"""样例：变量遮蔽与重新赋值 —— 都不应报告。

- 函数内的局部变量遮蔽模块级同名变量；
- 污点变量被重新赋值为常量后，污点被清除。
"""
import os

name = "module-level-constant"


def check(cur):
    # 局部变量遮蔽模块级 name，且未被污染
    name = "local-safe"
    cur.execute("SELECT * FROM t WHERE n = '%s'" % name)


def check2(cur):
    user = os.getenv("APP_USER")
    # 重新赋值为常量，污点被清除
    user = "admin"
    cur.execute("SELECT * FROM t WHERE u = '%s'" % user)
