"""规则定义：不可信输入来源、命令执行位置、安全处理函数。

每条规则带 rule_id 与人工可复查的文字依据，页面与结果都展示这些依据。
所有识别只基于 ast 节点的语法形态，不依赖待检代码的实际运行结果。
"""

from __future__ import annotations

import ast
from dataclasses import dataclass

# ---------------------------------------------------------------- 输入来源

# 常见 Web 框架请求参数的属性/取值链（最后一段为方法名或属性名）
_FLASK_GETTERS = {"args", "form", "values", "json", "cookies", "headers", "data"}
_DJANGO_GETTERS = {"GET", "POST", "body"}


@dataclass(frozen=True)
class SourceMatch:
    kind: str
    label: str


def attr_chain(node: ast.AST) -> list[str]:
    """把 a.b.c 形态的属性访问展开成 ['a', 'b', 'c']；不匹配则返回 []。"""
    parts: list[str] = []
    cur = node
    while isinstance(cur, ast.Attribute):
        parts.append(cur.attr)
        cur = cur.value
    if isinstance(cur, ast.Name):
        parts.append(cur.id)
        parts.reverse()
        return parts
    return []


def match_source(node: ast.AST) -> SourceMatch | None:
    """识别不可信输入来源节点。

    支持：
      - input(...) / builtins.input(...)
      - flask: request.args['x'] / request.args.get('x') / request.json / request.data ...
      - django: request.GET['x'] / request.GET.get('x') / request.POST ...
    """
    # input() 直接调用
    if isinstance(node, ast.Call):
        func = node.func
        if isinstance(func, ast.Name) and func.id == "input":
            return SourceMatch("input", "input() 用户输入")
        chain = attr_chain(func)
        if chain and chain[-1] == "input" and chain[0] in ("builtins", "__builtins__"):
            return SourceMatch("input", "builtins.input() 用户输入")

        # request.args.get("x") / request.GET.get("x") 这类带 .get 的调用
        chain = attr_chain(func)
        if chain and chain[-1] == "get":
            getter = _plain_getter(chain[:-1])
            if getter is not None:
                key = _literal_key(node)
                kind, label = getter
                if key is not None:
                    label = f"{label}['{key}']"
                return SourceMatch(kind, label)

    # request.args['x'] / request.GET['x'] 下标形式
    if isinstance(node, ast.Subscript):
        chain = attr_chain(node.value)
        if chain:
            getter = _plain_getter(chain)
            if getter is not None:
                key = _slice_key(node)
                kind, label = getter
                if key is not None:
                    label = f"{label}['{key}']"
                return SourceMatch(kind, label)

    # request.json / request.data 这类整体取值
    if isinstance(node, ast.Attribute) or isinstance(node, ast.Name):
        chain = attr_chain(node)
        if chain:
            getter = _plain_getter(chain)
            if getter is not None:
                return SourceMatch(getter[0], getter[1])
    return None


def _plain_getter(chain: list[str]) -> tuple[str, str] | None:
    # 形如 request.args（允许 self.request 等前缀，只看最后两段语义）
    if len(chain) >= 2 and chain[-2] == "request" and chain[-1] in _FLASK_GETTERS:
        return "flask", f"Flask request.{chain[-1]}"
    if len(chain) >= 2 and chain[-2] == "request" and chain[-1] in _DJANGO_GETTERS:
        return "django", f"Django request.{chain[-1]}"
    return None


def _literal_key(call: ast.Call) -> str | None:
    if call.args and isinstance(call.args[0], ast.Constant) and isinstance(call.args[0].value, str):
        return call.args[0].value
    return None


def _slice_key(node: ast.Subscript) -> str | None:
    sl = node.slice
    if isinstance(sl, ast.Constant) and isinstance(sl.value, str):
        return sl.value
    return None


# ---------------------------------------------------------------- 命令执行位置

@dataclass(frozen=True)
class SinkRule:
    rule_id: str
    kind: str  # shell-string | subprocess
    label: str
    basis: str


SINK_RULES: dict[str, SinkRule] = {
    "os.system": SinkRule(
        "S101", "shell-string", "os.system()",
        "os.system 始终经由 /bin/sh 执行字符串命令，字符串中的 shell 元字符会被解释。",
    ),
    "os.popen": SinkRule(
        "S102", "shell-string", "os.popen()",
        "os.popen 把字符串命令交给 shell 执行，拼接内容中的元字符可改变命令结构。",
    ),
    "subprocess.system-like": SinkRule(
        "S103", "shell-string", "subprocess 调用 (shell=True)",
        "shell=True 时命令字符串交给 /bin/sh 解释，不可信内容可注入分号、管道等元字符。",
    ),
    "subprocess.argv": SinkRule(
        "S104", "subprocess", "subprocess 调用 (参数数组, shell=False)",
        "参数数组不经 shell 解释；单个参数即使含空格或元字符也只作为 argv 元素，规则上不构成命令注入。",
    ),
}

_SUBPROCESS_FUNCS = {"run", "Popen", "call", "check_call", "check_output", "getoutput", "getstatusoutput"}


@dataclass(frozen=True)
class SinkMatch:
    rule: SinkRule
    command_node: ast.AST | None  # 命令参数节点（位置参数第一个，或 shell 字符串）
    shell_true: bool
    call_label: str


def match_sink(call: ast.Call) -> SinkMatch | None:
    """识别命令执行调用，并判断是 shell 字符串还是参数数组形态。"""
    chain = attr_chain(call.func)
    name = chain[-1] if chain else (call.func.id if isinstance(call.func, ast.Name) else None)
    if name is None:
        return None

    shell_true = _keyword_true(call, "shell")

    # os.system / os.popen：容忍 from os import system 后的裸调用，
    # 也容忍 os.popen(...).read() 这类把调用放在属性链中间的写法
    if name in ("system", "popen"):
        module = chain[-2] if len(chain) >= 2 else None
        if module in (None, "os", "posix", "nt"):
            rule = SINK_RULES["os.system" if name == "system" else "os.popen"]
            cmd = call.args[0] if call.args else None
            return SinkMatch(rule, cmd, True, f"os.{name}()")

    # subprocess 家族
    module = chain[-2] if len(chain) >= 2 else None
    if name in _SUBPROCESS_FUNCS and (module in (None, "subprocess")):
        # getoutput/getstatusoutput 内部固定走 shell
        forced_shell = name in ("getoutput", "getstatusoutput")
        is_shell = shell_true or forced_shell
        if is_shell:
            rule = SINK_RULES["subprocess.system-like"]
        else:
            rule = SINK_RULES["subprocess.argv"]
        cmd = call.args[0] if call.args else None
        label = f"subprocess.{name}()" if module == "subprocess" else f"{name}()"
        return SinkMatch(rule, cmd, is_shell, label)

    return None


def _keyword_true(call: ast.Call, key: str) -> bool:
    for kw in call.keywords:
        if kw.arg == key and isinstance(kw.value, ast.Constant) and kw.value.value is True:
            return True
    return False


# ---------------------------------------------------------------- 安全处理

@dataclass(frozen=True)
class SanitizerRule:
    rule_id: str
    label: str
    basis: str


SANITIZER_RULES: dict[str, SanitizerRule] = {
    "shlex.quote": SanitizerRule(
        "Q101", "shlex.quote()",
        "shlex.quote 对字符串做 shell 引用，保证其作为单个 shell 词出现，元字符失去控制含义。",
    ),
    "pipes.quote": SanitizerRule(
        "Q102", "pipes.quote()",
        "pipes.quote 与 shlex.quote 等价（旧模块名），同样产出安全的 shell 引用。",
    ),
    "numeric-cast": SanitizerRule(
        "Q103", "int()/float() 数值转换",
        "转换成功后结果只含数值字符，无法携带 shell 元字符；转换失败会抛异常而不是产生命令片段。",
    ),
}


def match_sanitizer(call: ast.Call) -> SanitizerRule | None:
    """识别安全引用/数值转换调用。"""
    chain = attr_chain(call.func)
    if len(chain) >= 2 and chain[-1] == "quote":
        if chain[0] == "shlex":
            return SANITIZER_RULES["shlex.quote"]
        if chain[0] == "pipes":
            return SANITIZER_RULES["pipes.quote"]
    name = chain[-1] if chain else (call.func.id if isinstance(call.func, ast.Name) else None)
    if name in ("int", "float"):
        return SANITIZER_RULES["numeric-cast"]
    return None


# 规则 ID（Q101 等，污点流上持久化的标识）-> 规则对象
SANITIZER_BY_ID = {rule.rule_id: rule for rule in SANITIZER_RULES.values()}


# ---------------------------------------------------------------- 判定规则依据（页面展示）

DECISION_BASIS = {
    "D201": "shell 字符串命令中包含未经安全引用的不可信数据，可注入 shell 元字符。",
    "D202": "shell 字符串命令中的不可信数据经过 shlex.quote/pipes.quote 引用，元字符被转义，规则上安全。",
    "D203": "subprocess 参数数组（shell=False）不经 shell 解释，带污点的元素只作为单个 argv 参数。",
    "D204": "subprocess 参数数组被传入 shell=True，会被再次拼接为 shell 字符串，等同 shell 注入面。",
    "D205": "命令完全由字面量常量构成，未发现不可信数据流入。",
    "D206": "传播经过当前范围内无法解析的函数/参数，无法确认数据流，保守标记为可能风险。",
}
