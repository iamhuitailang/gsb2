"""Web 层调用数据访问层：演示跨文件的污点传递与安全参数绑定并存。"""

from flask import request

from .dao import (
    UserDAO,
    fetch_user,
    fetch_user_safe,
    partial_parameterized,
)


def unsafe_endpoint():
    """外部输入 -> 跨文件函数 fetch_user -> build_query -> execute。"""
    user_id = request.args.get("id")
    # HIGH：值经过多个函数后被拼进查询文本
    return fetch_user(user_id)


def safe_endpoint():
    """同样的外部输入，但走参数绑定 —— 不应报告。"""
    user_id = request.args.get("id")
    return fetch_user_safe(user_id)


def dao_unsafe_endpoint():
    """外部输入 -> set_filter 存入实例字段 -> search 拼进 SQL。"""
    value = request.form.get("name")
    dao = UserDAO("app.db")  # 本地构造，分析器可推断对象类型
    dao.set_filter(value)
    return dao.search()


def partial_endpoint():
    """表名被拼接但过滤值参数化 —— MEDIUM。"""
    table = request.args.get("table")
    return partial_parameterized(table)
