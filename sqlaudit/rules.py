"""污点源（source）与危险执行点（sink）的识别规则。

规则全部基于 AST 上的名称/属性结构匹配，不依赖任何字符串搜索，
也不导入被扫描项目的任何模块。
"""

from __future__ import annotations

import ast
import re
from typing import Optional

# ---------------------------------------------------------------------------
# 污点源：用户可控输入
# ---------------------------------------------------------------------------

# request 对象上承载外部输入的属性/方法名（Flask / Django 风格）
_REQUEST_INPUT_ATTRS = frozenset({
    "args", "form", "values", "json", "data", "cookies",
    "headers", "query_params", "GET", "POST",
})
# 常见的 request 对象命名（变量名或属性链上出现即视为请求对象）
_REQUEST_ROOTS = frozenset({"request", "req", "flask_request"})
# 从输入容器里取值的方法
_SUBSCRIPT_METHODS = frozenset({"get", "getlist", "getlist_or_404",
                                "get_or_404", "getvalue"})


def _attr_chain(node: ast.AST) -> list[str]:
    """把 a.b.c 这样的属性访问拆成 ['a', 'b', 'c']，无法拆解时返回 []。"""
    chain: list[str] = []
    cur = node
    while isinstance(cur, ast.Attribute):
        chain.append(cur.attr)
        cur = cur.value
    if isinstance(cur, ast.Name):
        chain.append(cur.id)
        chain.reverse()
        return chain
    return []


def extract_source(node: ast.AST) -> Optional[tuple[str, str]]:
    """若 node 是用户可控输入源，返回 (source_kind, 展示代码)，否则 None。"""
    # input() 内置函数
    if isinstance(node, ast.Call):
        func = node.func
        if isinstance(func, ast.Name) and func.id == "input":
            return "input()", "input()"
        # request.args.get(...) / os.environ.get(...) 等取值方法
        if isinstance(func, ast.Attribute) and func.attr in _SUBSCRIPT_METHODS:
            inner_src = extract_source(func.value)
            if inner_src:
                return inner_src[0], ast.unparse(node)
        # os.getenv("NAME")
        if isinstance(func, ast.Attribute) and func.attr == "getenv":
            chain = _attr_chain(func.value)
            if chain and chain[0] == "os":
                return "os.getenv", ast.unparse(node)
        return None

    # sys.argv —— 命令行参数，外部可控
    chain = _attr_chain(node)
    if chain and chain[:2] == ["sys", "argv"]:
        return "sys.argv", ".".join(chain)

    # os.environ[...] / os.getenv(...) 在 Call 分支之外：
    # 直接属性访问 os.environ 视为源
    if chain and chain[0] == "os" and "environ" in chain:
        return "os.environ", ".".join(chain)
    if isinstance(node, ast.Subscript):
        sub_src = _subscript_source(node)
        if sub_src:
            return sub_src

    # request.args / request.form['k'] / self.request.json ...
    if chain:
        hits_request = any(name in _REQUEST_ROOTS for name in chain)
        hits_input_attr = any(name in _REQUEST_INPUT_ATTRS for name in chain)
        if hits_request and hits_input_attr:
            return "request." + next(
                name for name in chain if name in _REQUEST_INPUT_ATTRS
            ), ".".join(chain)

    return None


def _subscript_source(node: ast.Subscript) -> Optional[tuple[str, str]]:
    """处理 request.args['id']、os.environ['x']、sys.argv[1] 这类下标。"""
    chain = _attr_chain(node.value)
    if chain:
        if chain[:2] == ["sys", "argv"]:
            return "sys.argv", ast.unparse(node)
        if chain[0] == "os" and "environ" in chain:
            return "os.environ", ast.unparse(node)
        hits_request = any(name in _REQUEST_ROOTS for name in chain)
        hits_input_attr = any(name in _REQUEST_INPUT_ATTRS for name in chain)
        if hits_request and hits_input_attr:
            attr = next(name for name in chain if name in _REQUEST_INPUT_ATTRS)
            return "request." + attr, ast.unparse(node)
    # 嵌套下标，例如 request.json['a']['b']
    inner = extract_source(node.value)
    if inner:
        return inner[0], ast.unparse(node)
    return None


# ---------------------------------------------------------------------------
# 危险执行点：数据库查询调用
# ---------------------------------------------------------------------------

# 已知的 DB-API / 常见库执行接口。
# 元组含义：(展示名, query 所在位置参数下标, 参数化实参的位置下标集合,
#           承载参数的关键字名集合)
# 关键：参数化实参位置上出现污点不算注入，只有查询文本位置出现才算。
_KNOWN_SINKS: dict[str, tuple[str, int, frozenset[int], frozenset[str]]] = {
    # DB-API 2.0：cursor.execute(sql, params) / executemany
    "execute": ("execute", 0, frozenset({1}), frozenset({"parameters", "params"})),
    "executemany": ("executemany", 0, frozenset({1}),
                    frozenset({"parameters", "params"})),
    # SQLAlchemy：session.execute(statement, params)
    # 注意 text() 包裹的动态文本在调用点通过文本构造污点自然追踪
    "executescript": ("executescript", 0, frozenset(), frozenset()),
    # Django：RawSQL(sql, params)、raw(sql, params)
    "raw": ("raw", 0, frozenset({1}), frozenset({"params"})),
    "RawSQL": ("RawSQL", 0, frozenset({1}), frozenset({"params"})),
    # pandas.read_sql(sql, con, params=...)
    "read_sql": ("read_sql", 0, frozenset({2}), frozenset({"params"})),
}

# 启发式 sink：无法解析到定义、但名字明显是数据库执行的函数。
# 命中时给 LOW，提示人工确认，避免对未知封装保持沉默。
_HEURISTIC_SINK_RE = re.compile(
    r"^(run|exec|execute|do|query|fetch|find|get|select|count)_?"
    r"(sql|query|statement|stmt|raw)$"
    r"|^(sql|raw|query)_"
    r"(exec|execute|run|query|fetch|find|get|select|count)$",
    re.IGNORECASE,
)

# SQLAlchemy text() 本身不是执行点，但它的字符串参数会原样进入 SQL，
# 污点正常按普通函数传播（text 不可解析时透传实参污点）。


def match_sink(node: ast.Call) -> Optional[dict]:
    """若调用是数据库执行点，返回描述字典，否则 None。

    返回字段：
      name            调用名（用于展示）
      query_index     查询文本所在的位置参数下标
      param_indexes   参数化实参的位置下标集合（这些位置污点安全）
      param_keywords  参数化实参的关键字名集合
      heuristic       是否为启发式匹配（LOW 等级）
    """
    func = node.func
    name = func.attr if isinstance(func, ast.Attribute) else (
        func.id if isinstance(func, ast.Name) else ""
    )
    if not name:
        return None

    if name in _KNOWN_SINKS:
        display, qidx, pidx, pkw = _KNOWN_SINKS[name]
        return {
            "name": display,
            "query_index": qidx,
            "param_indexes": set(pidx),
            "param_keywords": set(pkw),
            "heuristic": False,
        }

    if _HEURISTIC_SINK_RE.match(name):
        return {
            "name": name,
            "query_index": 0,
            "param_indexes": {1},
            "param_keywords": {"params", "parameters", "args"},
            "heuristic": True,
        }
    return None


def call_has_params(call: ast.Call, sink_info: dict) -> bool:
    """判断该执行调用是否提供了参数化实参（用于分级与展示）。"""
    for idx in sink_info["param_indexes"]:
        if idx < len(call.args):
            return True
    for kw in call.keywords:
        if kw.arg in sink_info["param_keywords"]:
            return True
    return False
