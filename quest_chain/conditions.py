"""条件表达式 DSL。

语法 (EBNF, 大小写不敏感的关键字)::

    expr      := or_expr
    or_expr   := and_expr { OR and_expr }
    and_expr  := not_expr { AND not_expr }
    not_expr  := NOT not_expr | comparison
    comparison := primary [ CMP primary ]          # 比较不允许连写, 如 1 < x < 2 会报错
    primary   := NUMBER | STRING | BOOL | IDENT
               | FUNC_NAME "(" [ expr { "," expr } ] ")"
               | "(" expr ")"

支持的写法:
    q_meet("q1")                    任务 q1 已完成
    q_state("q1") == "completed"   取任务状态字符串
    any_of("q1", "q2")             任一完成; all_of(...) 全部完成
    none_of("q1", "q2")            均未完成 (从未完成, 即不在 completed/failed 状态)
    not any_of(...)                通用取反
    flag("got_sword")              自定义开关, 值为真
    var("reputation") >= 10        自定义数值
    var("chapter", 1)              带默认值, 上下文缺失时用默认值
    true / false / 数字 / 字符串 / and / or / not / && / || / ! / 括号

所有函数名、关键字大小写不敏感; 字符串使用双引号; 标识符允许字母数字下划线
及中文等非 ASCII 字符。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

# ---------------------------------------------------------------------------
# 错误
# ---------------------------------------------------------------------------


class ConditionError(Exception):
    """条件表达式相关错误的基类。"""

    def __init__(self, message: str, position: int = -1) -> None:
        super().__init__(message)
        self.message = message
        self.position = position

    def __str__(self) -> str:  # pragma: no cover - 简单转发
        if self.position >= 0:
            return f"{self.message} (位置 {self.position})"
        return self.message


class ConditionSyntaxError(ConditionError):
    """词法或语法错误。"""


class ConditionEvalError(ConditionError):
    """求值期错误 (未知函数、类型不支持比较等)。"""


# ---------------------------------------------------------------------------
# AST
# ---------------------------------------------------------------------------


class Node:
    pos: int = -1


@dataclass
class Literal(Node):
    value: Any
    pos: int = -1


@dataclass
class Ident(Node):
    """裸标识符, 等价于 flag(name)。"""

    name: str
    pos: int = -1


@dataclass
class Unary(Node):
    op: str
    operand: Node
    pos: int = -1


@dataclass
class Binary(Node):
    op: str
    left: Node
    right: Node
    pos: int = -1


@dataclass
class Call(Node):
    name: str
    args: List[Node]
    pos: int = -1


# ---------------------------------------------------------------------------
# 词法分析
# ---------------------------------------------------------------------------

_KEYWORDS = {
    "and": ("AND", "and"),
    "or": ("OR", "or"),
    "not": ("NOT", "not"),
    "true": ("BOOL", True),
    "false": ("BOOL", False),
}

_CMP = {"==", "!=", ">=", "<=", ">", "<"}


@dataclass
class Token:
    kind: str
    value: Any
    pos: int


def _tokenize(text: str) -> List[Token]:
    tokens: List[Token] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch.isspace():
            i += 1
            continue
        if ch == '"':
            start = i
            i += 1
            buf: List[str] = []
            while i < n and text[i] != '"':
                if text[i] == "\\" and i + 1 < n:
                    nxt = text[i + 1]
                    buf.append({"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\"}.get(nxt, nxt))
                    i += 2
                else:
                    buf.append(text[i])
                    i += 1
            if i >= n:
                raise ConditionSyntaxError("字符串缺少结束的双引号", start)
            i += 1  # 跳过结尾引号
            tokens.append(Token("STRING", "".join(buf), start))
            continue
        if ch.isdigit() or (ch == "." and i + 1 < n and text[i + 1].isdigit()):
            start = i
            while i < n and (text[i].isdigit() or text[i] == "."):
                i += 1
            raw = text[start:i]
            try:
                value = float(raw) if "." in raw else int(raw)
            except ValueError as exc:
                raise ConditionSyntaxError(f"非法数字 {raw!r}", start) from exc
            tokens.append(Token("NUMBER", value, start))
            continue
        if ch.isalpha() or ch == "_" or ord(ch) > 127:
            start = i
            while i < n and (text[i].isalnum() or text[i] == "_" or ord(text[i]) > 127):
                i += 1
            word = text[start:i]
            low = word.lower()
            if low in _KEYWORDS:
                kind, val = _KEYWORDS[low]
                tokens.append(Token(kind, val, start))
            else:
                tokens.append(Token("IDENT", word, start))
            continue
        if ch in "()!,":
            if ch == "!":
                if i + 1 < n and text[i + 1] == "=":
                    tokens.append(Token("CMP", "!=", i))
                    i += 2
                    continue
                tokens.append(Token("NOT", "!", i))
            else:
                tokens.append(Token({",": "COMMA", "(": "LPAREN", ")": "RPAREN"}[ch], ch, i))
            i += 1
            continue
        if ch in "<>=":
            start = i
            two = text[i : i + 2]
            if two in _CMP:
                tokens.append(Token("CMP", two, start))
                i += 2
                continue
            if ch in _CMP:
                tokens.append(Token("CMP", ch, start))
                i += 1
                continue
            raise ConditionSyntaxError(f"非法字符 {ch!r}", start)
        if ch == "&" and i + 1 < n and text[i + 1] == "&":
            tokens.append(Token("AND", "&&", i))
            i += 2
            continue
        if ch == "|" and i + 1 < n and text[i + 1] == "|":
            tokens.append(Token("OR", "||", i))
            i += 2
            continue
        raise ConditionSyntaxError(f"非法字符 {ch!r}", i)
    tokens.append(Token("EOF", None, n))
    return tokens


# ---------------------------------------------------------------------------
# 语法分析 (递归下降)
# ---------------------------------------------------------------------------


class _Parser:
    def __init__(self, text: str) -> None:
        self.tokens = _tokenize(text)
        self.idx = 0

    def _peek(self) -> Token:
        return self.tokens[self.idx]

    def _advance(self) -> Token:
        tok = self.tokens[self.idx]
        self.idx += 1
        return tok

    def _expect(self, kind: str, what: str) -> Token:
        tok = self._peek()
        if tok.kind != kind:
            raise ConditionSyntaxError(f"期望 {what}, 但得到 {tok.value!r}", tok.pos)
        return self._advance()

    def parse(self) -> Node:
        node = self._or()
        if self._peek().kind != "EOF":
            tok = self._peek()
            raise ConditionSyntaxError(f"表达式结束后仍有多余内容 {tok.value!r}", tok.pos)
        return node

    def _or(self) -> Node:
        node = self._and()
        while self._peek().kind == "OR":
            op_tok = self._advance()
            right = self._and()
            node = Binary("or", node, right, op_tok.pos)
        return node

    def _and(self) -> Node:
        node = self._not()
        while self._peek().kind == "AND":
            op_tok = self._advance()
            right = self._not()
            node = Binary("and", node, right, op_tok.pos)
        return node

    def _not(self) -> Node:
        tok = self._peek()
        if tok.kind == "NOT":
            self._advance()
            return Unary("not", self._not(), tok.pos)
        return self._comparison()

    def _comparison(self) -> Node:
        left = self._primary()
        tok = self._peek()
        if tok.kind == "CMP":
            self._advance()
            right = self._primary()
            nxt = self._peek()
            if nxt.kind == "CMP":
                raise ConditionSyntaxError("不支持连续比较, 请用 and 连接, 例如 x > 1 and x < 2", nxt.pos)
            return Binary(tok.value, left, right, tok.pos)
        return left

    def _primary(self) -> Node:
        tok = self._peek()
        if tok.kind == "NUMBER" or tok.kind == "STRING" or tok.kind == "BOOL":
            self._advance()
            return Literal(tok.value, tok.pos)
        if tok.kind == "LPAREN":
            self._advance()
            node = self._or()
            self._expect("RPAREN", "右括号 )")
            return node
        if tok.kind == "IDENT":
            self._advance()
            if self._peek().kind == "LPAREN":
                self._advance()
                args: List[Node] = []
                if self._peek().kind != "RPAREN":
                    args.append(self._or())
                    while self._peek().kind == "COMMA":
                        self._advance()
                        args.append(self._or())
                self._expect("RPAREN", "右括号 )")
                return Call(tok.value, args, tok.pos)
            return Ident(tok.value, tok.pos)
        raise ConditionSyntaxError(f"此处不应出现 {tok.value!r}", tok.pos)


def parse(expression: str) -> Node:
    """把条件表达式字符串解析为 AST。空串视为恒真。"""

    if expression is None or not expression.strip():
        return Literal(True)
    return _Parser(expression).parse()


# ---------------------------------------------------------------------------
# 求值
# ---------------------------------------------------------------------------

# 求值上下文中任务状态的标准取值
QUESTION_STATES = ("available", "active", "completed", "failed", "locked")


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.lower() not in ("", "false", "0", "no")
    return bool(value)


def _compare(op: str, left: Any, right: Any, pos: int) -> bool:
    try:
        if op == "==":
            return left == right
        if op == "!=":
            return left != right
        if isinstance(left, bool) or isinstance(right, bool):
            raise ConditionEvalError("布尔值不能使用大小比较", pos)
        if isinstance(left, str) and isinstance(right, str):
            if op in (">", "<", ">=", "<="):
                raise ConditionEvalError("字符串不能使用大小比较", pos)
        if not isinstance(left, (int, float)) or not isinstance(right, (int, float)):
            raise ConditionEvalError(
                f"无法比较 {type(left).__name__} 与 {type(right).__name__}", pos
            )
        return {
            ">": left > right,
            "<": left < right,
            ">=": left >= right,
            "<=": left <= right,
        }[op]
    except TypeError as exc:  # pragma: no cover - 兜底
        raise ConditionEvalError(str(exc), pos) from exc


class _Evaluator:
    def __init__(self, context: Optional[Dict[str, Any]]) -> None:
        self.ctx = context or {}
        self.quest_states: Dict[str, str] = self.ctx.get("quest_states", {}) or {}
        self.flags: Dict[str, Any] = self.ctx.get("flags", {}) or {}
        self.variables: Dict[str, Any] = self.ctx.get("variables", {}) or {}
        self.functions: Dict[str, Callable[..., Any]] = self.ctx.get("functions", {}) or {}

    def eval(self, node: Node) -> Any:
        if isinstance(node, Literal):
            return node.value
        if isinstance(node, Ident):
            return _truthy(self.flags.get(node.name, False))
        if isinstance(node, Unary):
            if node.op != "not":  # pragma: no cover - 语法层已保证
                raise ConditionEvalError(f"未知一元运算符 {node.op}", node.pos)
            return not _truthy(self.eval(node.operand))
        if isinstance(node, Binary):
            if node.op == "and":
                return _truthy(self.eval(node.left)) and _truthy(self.eval(node.right))
            if node.op == "or":
                return _truthy(self.eval(node.left)) or _truthy(self.eval(node.right))
            return _compare(node.op, self.eval(node.left), self.eval(node.right), node.pos)
        if isinstance(node, Call):
            return self._call(node)
        raise ConditionEvalError(f"未知 AST 节点 {type(node).__name__}", getattr(node, "pos", -1))

    def _call(self, node: Call) -> Any:
        name = node.name.lower()
        args = [self.eval(a) for a in node.args]

        if name == "q_meet":
            self._check_arity(node, 1, 1)
            return self.quest_states.get(str(args[0])) == "completed"
        if name == "q_failed":
            self._check_arity(node, 1, 1)
            return self.quest_states.get(str(args[0])) == "failed"
        if name == "q_state":
            self._check_arity(node, 1, 1)
            return self.quest_states.get(str(args[0]), "locked")
        if name == "any_of":
            return any(self.quest_states.get(str(a)) == "completed" for a in args)
        if name == "all_of":
            if not args:
                return True
            return all(self.quest_states.get(str(a)) == "completed" for a in args)
        if name == "none_of":
            return all(
                self.quest_states.get(str(a)) not in ("completed", "failed") for a in args
            )
        if name == "flag":
            self._check_arity(node, 1, 1)
            return _truthy(self.flags.get(str(args[0]), False))
        if name == "var":
            self._check_arity(node, 1, 2)
            key = str(args[0])
            if key in self.variables:
                return self.variables[key]
            if len(args) == 2:
                return args[1]
            return 0
        if name in self.functions:
            return self.functions[node.name](*args)
        raise ConditionEvalError(f"未知函数 {node.name}()", node.pos)

    def _check_arity(self, node: Call, minimum: int, maximum: int) -> None:
        count = len(node.args)
        if count < minimum or count > maximum:
            if minimum == maximum:
                expect = f"恰好 {minimum} 个"
            else:
                expect = f"{minimum}~{maximum} 个"
            raise ConditionEvalError(
                f"函数 {node.name}() 需要{expect}参数, 实际得到 {count} 个", node.pos
            )


def evaluate(expression: str, context: Optional[Dict[str, Any]] = None) -> Any:
    """解析并求值表达式。context 结构见模块 docstring。"""

    return _Evaluator(context).eval(parse(expression))


def truthy_evaluate(expression: str, context: Optional[Dict[str, Any]] = None) -> bool:
    """求值并按 DSL 的真值规则转布尔。"""

    return _truthy(evaluate(expression, context))


# ---------------------------------------------------------------------------
# 静态检查 / 引用提取
# ---------------------------------------------------------------------------

_BUILTIN_FUNCTIONS = {
    "q_meet": (1, 1),
    "q_failed": (1, 1),
    "q_state": (1, 1),
    "any_of": (1, None),
    "all_of": (1, None),
    "none_of": (1, None),
    "flag": (1, 1),
    "var": (1, 2),
}

_QUESTION_FUNC_ARGS = {"q_meet", "q_failed", "q_state", "any_of", "all_of", "none_of"}


def _walk(node: Node):
    yield node
    if isinstance(node, Unary):
        yield from _walk(node.operand)
    elif isinstance(node, Binary):
        yield from _walk(node.left)
        yield from _walk(node.right)
    elif isinstance(node, Call):
        for arg in node.args:
            yield from _walk(arg)


def extract_references(expression: str) -> Dict[str, List[str]]:
    """提取表达式中静态引用的任务 id、flag 名与变量名。

    任务引用仅取函数字面量参数 (q_meet/any_of/... 里的字符串);
    动态拼接的参数无法静态提取, 由 lint_condition 的规则提示。
    """

    tree = parse(expression)
    quests: List[str] = []
    flags: List[str] = []
    variables: List[str] = []
    for node in _walk(tree):
        if isinstance(node, Call):
            name = node.name.lower()
            if name in _QUESTION_FUNC_ARGS:
                for arg in node.args:
                    if isinstance(arg, Literal) and isinstance(arg.value, str):
                        quests.append(arg.value)
            elif name == "flag":
                for arg in node.args:
                    if isinstance(arg, Literal) and isinstance(arg.value, str):
                        flags.append(arg.value)
            elif name == "var":
                if node.args and isinstance(node.args[0], Literal) and isinstance(
                    node.args[0].value, str
                ):
                    variables.append(node.args[0].value)
        elif isinstance(node, Ident):
            flags.append(node.name)
    return {
        "quests": sorted(set(quests)),
        "flags": sorted(set(flags)),
        "variables": sorted(set(variables)),
    }


def lint_condition(
    expression: str,
    known_quests: Optional[Sequence[str]] = None,
    known_flags: Optional[Sequence[str]] = None,
    known_variables: Optional[Sequence[str]] = None,
) -> List[str]:
    """静态检查表达式, 返回问题描述列表 (空列表表示通过)。

    检查项: 语法、未知函数、参数个数、任务/flag/变量引用是否存在、
    引用任务的参数必须是字符串字面量。
    """

    problems: List[str] = []
    try:
        tree = parse(expression)
    except ConditionError as exc:
        return [str(exc)]

    known_quests = set(known_quests or [])
    known_flags = set(known_flags or [])
    known_variables = set(known_variables or [])

    for node in _walk(tree):
        if not isinstance(node, Call):
            continue
        name = node.name.lower()
        if name in _BUILTIN_FUNCTIONS:
            minimum, maximum = _BUILTIN_FUNCTIONS[name]
            count = len(node.args)
            if count < minimum or (maximum is not None and count > maximum):
                if maximum is None:
                    problems.append(f"函数 {node.name}() 至少需要 {minimum} 个参数")
                else:
                    problems.append(
                        f"函数 {node.name}() 需要恰好 {minimum} 个参数, 实际 {count} 个"
                    )
            if name in _QUESTION_FUNC_ARGS:
                for arg in node.args:
                    if not (isinstance(arg, Literal) and isinstance(arg.value, str)):
                        problems.append(
                            f"函数 {node.name}() 的任务参数必须是字符串字面量, 否则无法静态检查引用"
                        )
                    elif known_quests and arg.value not in known_quests:
                        problems.append(f"引用了不存在的任务 {arg.value!r}")
            if name == "flag":
                for arg in node.args:
                    if isinstance(arg, Literal) and isinstance(arg.value, str):
                        if known_flags and arg.value not in known_flags:
                            problems.append(f"引用了未声明的 flag {arg.value!r}")
            if name == "var" and node.args:
                first = node.args[0]
                if isinstance(first, Literal) and isinstance(first.value, str):
                    if known_variables and first.value not in known_variables:
                        problems.append(f"引用了未声明的变量 {first.value!r}")
        elif name not in ("flag", "var"):
            # 允许引擎通过 functions 注入自定义函数, 这里仅作提示性检查
            problems.append(f"未知函数 {node.name}() (如为自定义注入函数请忽略)")
    return problems
