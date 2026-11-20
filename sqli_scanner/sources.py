"""外部输入源（source）与数据库查询调用（sink）的识别规则。

识别基于调用/属性链的名字启发式判断，不依赖任何第三方库。
"""

from __future__ import annotations

import ast
from typing import List, Optional, Set, Tuple

# 以属性链形式出现的外部输入，例如 request.args.get("id")
# 元组表示属性链前缀，从内向外：request.args.get -> ("request", "args", "get")
SOURCE_ATTR_CHAINS: Tuple[Tuple[str, ...], ...] = (
    ("request", "args", "get"),
    ("request", "args"),
    ("request", "form", "get"),
    ("request", "form"),
    ("request", "cookies", "get"),
    ("request", "cookies"),
    ("request", "headers", "get"),
    ("request", "headers"),
    ("request", "json", "get"),
    ("request", "json"),
    ("request", "GET", "get"),
    ("request", "GET"),
    ("request", "POST", "get"),
    ("request", "POST"),
    ("request", "values", "get"),
    ("request", "values"),
    ("request", "query_params"),
    ("request", "query_params", "get"),
    ("request", "data"),
    # Django
    ("request", "GET", "getlist"),
    ("request", "POST", "getlist"),
)

# 带这些属性名的属性访问通常意味着取外部输入，例如 flask.request.json
SOURCE_ATTR_NAMES: Set[str] = {
    "args",
    "form",
    "cookies",
    "headers",
    "json",
    "query_params",
    "GET",
    "POST",
    "params",
}

# 下标形式的外部输入，例如 flask.request.args["id"]
SOURCE_SUBSCRIPT_ROOTS: Set[str] = {
    "request",
    "flask.request",
    "cherrypy.request",
}

# 裸调用形式的外部输入函数
SOURCE_CALL_NAMES: Set[str] = {
    "input",
    "getenv",
    "environ.get",
}

# 常见 web 框架获取请求对象的函数（其返回值按外部输入处理）
REQUEST_OBJECT_CALLS: Set[str] = {
    "get_request",  # 例如部分框架的 get_request()
}

# 数据库执行方法/函数名（最后一段名字匹配）
SINK_EXECUTE_NAMES: Set[str] = {
    "execute",
    "executemany",
    "executescript",
}

# 直接构造/执行 SQL 的函数名（text() 作为查询构造器按透传处理，见 analyzer）
SINK_QUERY_FUNC_NAMES: Set[str] = {
    "raw",
    "query",
}

# 表示“执行 SQL”的属性链，例如 engine.execute、session.execute 由方法名规则覆盖，
# 这里补充仅凭方法名容易误报的场景
SINK_ATTR_CHAINS: Tuple[Tuple[str, ...], ...] = (
    ("engine", "execute"),
    ("connection", "execute"),
    ("conn", "execute"),
    ("db", "execute"),
    ("cursor", "execute"),
    ("session", "execute"),
)

# 参数绑定相关的关键字名
BINDING_KEYWORDS: Set[str] = {
    "params",
    "parameters",
    "args",
    "param",
    "values",
}

# 只做透传的内置函数/方法：返回值污点 = 参数污点的合并
PASSTHROW_BUILTINS: Set[str] = {
    "str",
    "int",
    "float",
    "str.strip",
    "str.lstrip",
    "str.rstrip",
    "str.upper",
    "str.lower",
    "str.replace",
    "str.ljust",
    "str.rjust",
    "str.zfill",
    "str.expandtabs",
    "str.join",
    "str.format",
    "str.format_map",
}


def attr_chain(node: ast.AST) -> Optional[List[str]]:
    """把属性链展开成名字列表，无法展开（含调用/下标）返回 None。

    request.args.get -> ["request", "args", "get"]
    """
    chain: List[str] = []
    cur = node
    while isinstance(cur, ast.Attribute):
        chain.append(cur.attr)
        cur = cur.value
    if isinstance(cur, ast.Name):
        chain.append(cur.id)
        chain.reverse()
        return chain
    return None


def dotted_name(node: ast.AST) -> Optional[str]:
    chain = attr_chain(node)
    if chain is not None:
        return ".".join(chain)
    if isinstance(node, ast.Name):
        return node.id
    return None


def _chain_endswith(chain: List[str], target: Tuple[str, ...]) -> bool:
    return len(chain) >= len(target) and tuple(chain[-len(target):]) == target


def match_call_source(
    node: ast.Call, extra_sources: Optional[Set[str]] = None
) -> Optional[str]:
    """判断一个 Call 节点是否是外部输入读取，返回来源描述名。"""
    extra_sources = extra_sources or set()
    func = node.func

    chain = attr_chain(func)
    if chain is not None:
        dotted = ".".join(chain)
        # 用户通过 --extra-source 增加的规则（点号全名）
        if dotted in extra_sources:
            return dotted
        for target in SOURCE_ATTR_CHAINS:
            if _chain_endswith(chain, target):
                return dotted
        # 仅以单个名字注册的内置/标准库来源
        if len(chain) == 2 and chain[1] in SOURCE_CALL_NAMES:
            return dotted
        # os.environ.get / os.getenv 一类
        if chain[-1] in SOURCE_CALL_NAMES:
            return dotted
        if chain[-1] in REQUEST_OBJECT_CALLS:
            return dotted
        return None

    if isinstance(func, ast.Name):
        if func.id in SOURCE_CALL_NAMES or func.id in extra_sources:
            return func.id
        if func.id in REQUEST_OBJECT_CALLS:
            return func.id
    return None


def match_subscript_source(node: ast.Subscript) -> Optional[str]:
    """判断 request.args["id"] 这类下标读取是否是外部输入。"""
    chain = attr_chain(node.value)
    if chain is None:
        # 简单的 name 下标，例如 request["id"]
        if isinstance(node.value, ast.Name) and node.value.id in SOURCE_SUBSCRIPT_ROOTS:
            return f"{node.value.id}[]"
        return None
    dotted = ".".join(chain)
    if chain[0] in SOURCE_SUBSCRIPT_ROOTS or any(
        part in SOURCE_ATTR_NAMES for part in chain
    ):
        return dotted + "[]"
    return None


def match_attr_source(node: ast.Attribute) -> Optional[str]:
    """判断 request.args 这类纯属性访问（不调用）是否是外部输入。"""
    chain = attr_chain(node)
    if chain is None:
        return None
    dotted = ".".join(chain)
    if any(part in SOURCE_ATTR_NAMES for part in chain):
        return dotted
    return None


def match_sql_sink(node: ast.Call) -> Optional[str]:
    """判断一个 Call 是否是 SQL 执行点，返回 sink 描述名。"""
    func = node.func
    chain = attr_chain(func)

    if chain is not None:
        dotted = ".".join(chain)
        for target in SINK_ATTR_CHAINS:
            if _chain_endswith(chain, target):
                return dotted
        last = chain[-1]
        if last in SINK_EXECUTE_NAMES or last in SINK_QUERY_FUNC_NAMES:
            return dotted
        return None

    if isinstance(func, ast.Name):
        if func.id in SINK_EXECUTE_NAMES or func.id in SINK_QUERY_FUNC_NAMES:
            return func.id
    return None


def is_binding_keyword(keyword: ast.keyword) -> bool:
    """关键字参数是否属于参数绑定写法，例如 execute(sql, params=...)。"""
    return keyword.arg in BINDING_KEYWORDS
