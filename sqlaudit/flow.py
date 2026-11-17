"""基于 AST 的过程间污点流分析引擎。

分析方式：
1. 每个函数用"形参被污染"作为符号入口，计算它会把污染传到哪些
   返回值、self 字段以及函数内部的哪些数据库执行点；
2. 整个程序反复扫描（worklist 不动点），调用点用实参的真实污点
   替换形参符号，从而把跨函数、跨文件、跨方法（self.x）的路径
   逐跳拼接起来；
3. 全程只操作 AST 与标签集合，不执行被扫描代码。
"""

from __future__ import annotations

import ast
from dataclasses import dataclass, field
from typing import Optional

from .model import Finding, Hop, Origin, Severity, TaintLabel
from .registry import MODULE_LEVEL, FuncInfo, ModuleRegistry, RegistryBuilder
from .rules import call_has_params, extract_source, match_sink

# 安全阀：防止递归/循环导致路径或标签无限增长
_MAX_HOPS = 40
_MAX_LABELS_PER_SLOT = 64
_MAX_SWEEPS = 20

# 结果确定无污点的内置函数
_CLEANSING_BUILTINS = frozenset({
    "len", "isinstance", "issubclass", "type", "int", "float",
    "complex", "bool", "hash", "id",
})
# 字符串方法：按字符串污点分析规则处理（其余方法默认保守透传实参污点）
_PASSTHROUGH_STR_METHODS = frozenset({
    "strip", "lstrip", "rstrip", "upper", "lower", "title",
    "swapcase", "capitalize", "replace", "format", "format_map",
    "join", "split", "rsplit", "splitlines", "ljust", "rjust",
    "center", "zfill", "encode", "translate", "expandtabs",
})
_TAINTED_ITER_METHODS = frozenset({"__iter__", "__next__"})


def _code_of(node: ast.AST) -> str:
    try:
        return ast.unparse(node).strip()
    except Exception:  # pragma: no cover - 极端情况下 unparse 失败
        return type(node).__name__


@dataclass
class _FuncState:
    """单个函数在一轮扫描中的状态。"""

    fkey: tuple[str, str]
    info: Optional[FuncInfo]
    # 形参名 -> 形参符号标签（入口）
    entry_labels: dict[str, TaintLabel] = field(default_factory=dict)
    # 形参位置 -> 形参名
    arg_names: list[str] = field(default_factory=list)
    # 形参名 -> 位置下标（-1 表示仅关键字参数）
    arg_index: dict[str, int] = field(default_factory=dict)
    # return 语句导出的标签
    ret_labels: set[TaintLabel] = field(default_factory=set)
    # 函数内发现的、源头为形参的执行点（延迟到调用点具象化）
    # 元素：(sink_info, 形参名, 到达 sink 的标签, Call 节点, 是否参数化)
    pending_sinks: list[
        tuple[dict, str, TaintLabel, ast.Call, bool]
    ] = field(default_factory=list)


class FlowAnalyzer:
    def __init__(self, builder: RegistryBuilder):
        self.builder = builder
        self.registries: dict[str, ModuleRegistry] = builder.registries
        self.findings: list[Finding] = []
        # 全局变量污点：module_id -> {名字: 标签集合}
        self.globals: dict[str, dict[str, set[TaintLabel]]] = {
            mid: {} for mid in self.registries
        }
        # 实例字段污点（按类名汇总，self.x 风格）：类名 -> {字段: 标签}
        self.fields: dict[str, dict[str, set[TaintLabel]]] = {}
        # 字段写入记录：(类名, 字段) -> 最近一次写入所在的
        # (函数键, 形参名列表, 写入节点)，用于读取侧具象化形参符号
        self.field_writes: dict[
            tuple[str, str],
            list[tuple[tuple[str, str], list[str], ast.stmt]],
        ] = {}
        # 每个函数的状态
        self.states: dict[tuple[str, str], _FuncState] = {}
        # 去重：dedup_key -> 最短跳数
        self._finding_dedup: dict[tuple, int] = {}
        # 一轮扫描中是否发生过任何状态变化（不动点判定）
        self.changed = False
        self._init_states()

    # ------------------------------------------------------------------
    # 初始化
    # ------------------------------------------------------------------
    def _init_states(self) -> None:
        for mid, reg in self.registries.items():
            module_state = _FuncState(fkey=(mid, MODULE_LEVEL), info=None)
            self.states[(mid, MODULE_LEVEL)] = module_state
            for qualname, info in reg.functions.items():
                fkey = (mid, qualname)
                state = _FuncState(fkey=fkey, info=info)
                self._bind_entry_params(state, info.node)
                self.states[fkey] = state
                if info.class_name:
                    self.fields.setdefault(info.class_name, {})

    def _bind_entry_params(self, state: _FuncState,
                           node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        """为每个形参造一个"形参被污染"的符号标签。"""
        posonly = getattr(node.args, "posonlyargs", [])
        all_pos = posonly + node.args.args
        for idx, arg in enumerate(all_pos):
            self._add_entry_arg(state, arg.arg, idx)
        for arg in node.args.kwonlyargs:
            self._add_entry_arg(state, arg.arg, -1)
        if node.args.vararg:
            self._add_entry_arg(state, node.args.vararg.arg, -1)
        if node.args.kwarg:
            self._add_entry_arg(state, node.args.kwarg.arg, -1)

    def _add_entry_arg(self, state: _FuncState, name: str, idx: int) -> None:
        origin = Origin(
            file="<parameter>", line=0,
            source_kind=f"parameter:{name}", code=name,
        )
        label = TaintLabel(
            origin=origin,
            param_origin=(f"{state.fkey[0]}::{state.fkey[1]}", name, idx),
        )
        state.entry_labels[name] = label
        state.arg_names.append(name)
        state.arg_index[name] = idx

    # ------------------------------------------------------------------
    # 不动点扫描
    # ------------------------------------------------------------------
    def analyze(self) -> list[Finding]:
        for sweep in range(_MAX_SWEEPS):
            self.changed = False
            # 模块级先分析（全局变量可能带污点），再分析函数；
            # 顺序按键排序保证报告稳定。
            for fkey in sorted(self.states, key=lambda k: (k[0], k[1])):
                state = self.states[fkey]
                # 每轮用全新的局部作用域，局部变量不会跨函数/跨轮次残留；
                # 跨轮次需要保留的只有全局变量、self 字段、返回标签与延迟 sink。
                if state.info is None:
                    body = self.registries[fkey[0]].tree.body
                    self.changed |= self._analyze_body(state, body,
                                                       scope_stack=[{}])
                else:
                    self.changed |= self._analyze_body(
                        state, state.info.node.body, scope_stack=[{}]
                    )
            if not self.changed:
                break
        return sorted(self.findings, key=lambda f: f.sort_key())

    # ------------------------------------------------------------------
    # 语句处理
    # ------------------------------------------------------------------
    def _analyze_body(self, state: _FuncState, body: list[ast.stmt],
                      scope_stack: list[dict[str, set[TaintLabel]]]) -> bool:
        changed = False
        for stmt in body:
            changed |= self._stmt(state, stmt, scope_stack)
        return changed

    def _stmt(self, state: _FuncState, stmt: ast.stmt,
              scope_stack: list[dict[str, set[TaintLabel]]]) -> bool:
        changed = False

        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef,
                             ast.ClassDef)):
            # 嵌套定义由注册表统一分析，这里不展开
            return False

        if isinstance(stmt, ast.Assign):
            value_labels = self._eval(state, stmt.value, scope_stack)
            for target in stmt.targets:
                changed |= self._assign_target(state, target, value_labels,
                                               scope_stack)
            return changed

        if isinstance(stmt, ast.AnnAssign):
            if stmt.value is not None:
                labels = self._eval(state, stmt.value, scope_stack)
                changed |= self._assign_target(state, stmt.target, labels,
                                               scope_stack)
            return changed

        if isinstance(stmt, ast.AugAssign):
            # x += tainted 等价于 x = x + tainted
            old = self._read_target(state, stmt.target, scope_stack)
            new = self._eval(state, stmt.value, scope_stack)
            changed |= self._assign_target(
                state, stmt.target, old | new, scope_stack
            )
            return changed

        if isinstance(stmt, ast.Return):
            if stmt.value is not None:
                return_hop = Hop(
                    file=state.fkey[0],
                    line=stmt.lineno,
                    function=state.fkey[1],
                    code=_code_of(stmt.value),
                )
                for label in self._eval(state, stmt.value, scope_stack):
                    # 记录数据经过本函数 return 这一跳（形参直达也有迹可循）
                    out = label.extended(return_hop)
                    if out not in state.ret_labels:
                        state.ret_labels.add(out)
                        changed = True
                        self.changed = True
            return changed

        if isinstance(stmt, ast.If):
            self._eval(state, stmt.test, scope_stack)
            changed |= self._analyze_body(state, stmt.body, scope_stack)
            changed |= self._analyze_body(state, stmt.orelse, scope_stack)
            return changed

        if isinstance(stmt, (ast.For, ast.AsyncFor)):
            self._eval(state, stmt.iter, scope_stack)
            iter_labels = self._iter_taint(state, stmt.iter, scope_stack)
            changed |= self._assign_target(state, stmt.target, iter_labels,
                                           scope_stack)
            changed |= self._analyze_body(state, stmt.body, scope_stack)
            changed |= self._analyze_body(state, stmt.orelse, scope_stack)
            return changed

        if isinstance(stmt, ast.While):
            self._eval(state, stmt.test, scope_stack)
            changed |= self._analyze_body(state, stmt.body, scope_stack)
            changed |= self._analyze_body(state, stmt.orelse, scope_stack)
            return changed

        if isinstance(stmt, (ast.With, ast.AsyncWith)):
            for item in stmt.items:
                labels = self._eval(state, item.context_expr, scope_stack)
                if item.optional_vars is not None:
                    changed |= self._assign_target(state, item.optional_vars,
                                                   labels, scope_stack)
            changed |= self._analyze_body(state, stmt.body, scope_stack)
            return changed

        if isinstance(stmt, ast.Try):
            changed |= self._analyze_body(state, stmt.body, scope_stack)
            for handler in stmt.handlers:
                if handler.name:
                    # 异常对象不视为用户输入源：不注入污点
                    pass
                changed |= self._analyze_body(state, handler.body,
                                               scope_stack)
            changed |= self._analyze_body(state, stmt.orelse, scope_stack)
            changed |= self._analyze_body(state, stmt.finalbody, scope_stack)
            return changed

        if isinstance(stmt, (ast.Import, ast.ImportFrom, ast.Global,
                             ast.Nonlocal, ast.Pass, ast.Break,
                             ast.Continue, ast.Delete)):
            return False

        # match 语句（Python 3.10+）：主体表达式先求值，case 捕获变量
        # 保守视为承接主体污点，再分析各 case 体。
        match_stmt = getattr(ast, "Match", None)
        if match_stmt is not None and isinstance(stmt, match_stmt):
            subject_labels = self._eval(state, stmt.subject, scope_stack)
            for case in stmt.cases:
                self._bind_match_pattern(state, case.pattern,
                                         subject_labels, scope_stack)
                if case.guard is not None:
                    self._eval(state, case.guard, scope_stack)
                changed |= self._analyze_body(state, case.body, scope_stack)
            return changed

        if isinstance(stmt, ast.Raise):
            if stmt.exc is not None:
                self._eval(state, stmt.exc, scope_stack)
            return False

        if isinstance(stmt, ast.Assert):
            self._eval(state, stmt.test, scope_stack)
            if stmt.msg:
                self._eval(state, stmt.msg, scope_stack)
            return False

        # 表达式语句（含执行调用）、以及其他未逐一列举的语句：
        # 通用递归，保证所有子表达式里的调用都被检查到。
        for child in ast.iter_child_nodes(stmt):
            if isinstance(child, ast.expr):
                self._eval(state, child, scope_stack)
            elif isinstance(child, ast.stmt):
                changed |= self._stmt(state, child, scope_stack)
        return changed

    # ------------------------------------------------------------------
    # 赋值目标
    # ------------------------------------------------------------------
    def _assign_target(self, state: _FuncState, target: ast.AST,
                       labels: set[TaintLabel],
                       scope_stack: list[dict[str, set[TaintLabel]]]) -> bool:
        labels = self._cap(labels)
        changed = False

        if isinstance(target, ast.Name):
            # self 不允许重新绑定为污点变量
            if target.id == "self":
                return False
            if state.info is None:
                slot = self.globals[state.fkey[0]].setdefault(target.id, set())
            else:
                slot = scope_stack[-1].setdefault(target.id, set())
            for label in labels:
                if label not in slot:
                    slot.add(label)
                    changed = True
                    self.changed = True
            return changed

        if isinstance(target, ast.Attribute):
            if isinstance(target.value, ast.Name) and target.value.id == "self":
                class_name = state.info.class_name if state.info else None
                if class_name:
                    slot = self.fields[class_name].setdefault(target.attr, set())
                    for label in labels:
                        if label not in slot:
                            slot.add(label)
                            changed = True
                            self.changed = True
                    # 记录哪些形参参与了这次字段写入，供读取侧反向具象化
                    writer_params = sorted(
                        name for name in state.entry_labels
                        if any(
                            lab.param_origin is not None
                            and lab.param_origin[1] == name
                            for lab in labels
                        )
                    )
                    record = (state.fkey, writer_params)
                    writes = self.field_writes.setdefault(
                        (class_name, target.attr), []
                    )
                    if record not in writes:
                        writes.append(record)
                return changed
            # 其他对象属性：无对象模型，保守忽略，但求值左侧表达式
            self._eval(state, target.value, scope_stack)
            return False

        if isinstance(target, ast.Subscript):
            self._eval(state, target.value, scope_stack)
            self._eval(state, target.slice, scope_stack)
            return False

        if isinstance(target, (ast.Tuple, ast.List)):
            for elt in target.elts:
                if isinstance(elt, ast.Starred):
                    changed |= self._assign_target(state, elt.value, labels,
                                                   scope_stack)
                else:
                    changed |= self._assign_target(state, elt, labels,
                                                   scope_stack)
            return changed

        return False

    def _read_target(self, state: _FuncState, target: ast.AST,
                     scope_stack: list[dict[str, set[TaintLabel]]]
                     ) -> set[TaintLabel]:
        if isinstance(target, ast.Name):
            return self._lookup_name(state, target.id, scope_stack)
        if isinstance(target, ast.Attribute):
            return self._read_attribute(state, target, scope_stack)
        if isinstance(target, ast.Subscript):
            return self._eval(state, target, scope_stack)
        return set()

    # ------------------------------------------------------------------
    # 表达式求值：返回污点标签集合
    # ------------------------------------------------------------------
    def _eval(self, state: _FuncState, node: Optional[ast.AST],
              scope_stack: list[dict[str, set[TaintLabel]]]
              ) -> set[TaintLabel]:
        if node is None:
            return set()

        # 1) 直接是用户输入源
        source = extract_source(node)
        if source is not None:
            kind, code = source
            origin = Origin(
                file=state.fkey[0],
                line=getattr(node, "lineno", 0),
                source_kind=kind,
                code=code,
            )
            return {TaintLabel(origin=origin)}

        if isinstance(node, ast.Name):
            return set(self._lookup_name(state, node.id, scope_stack))

        if isinstance(node, ast.Constant):
            return set()

        if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
            return self._union_children(state, node.elts, scope_stack)

        if isinstance(node, ast.Dict):
            labels: set[TaintLabel] = set()
            for key, value in zip(node.keys, node.values):
                labels |= self._eval(state, key, scope_stack)
                labels |= self._eval(state, value, scope_stack)
            return labels

        if isinstance(node, ast.JoinedStr):
            # f-string：静态部分是常量，只收集插值表达式的污点
            labels = set()
            for value in node.values:
                if isinstance(value, ast.FormattedValue):
                    labels |= self._eval(state, value.value, scope_stack)
            return labels

        if isinstance(node, ast.FormattedValue):
            return self._eval(state, node.value, scope_stack)

        if isinstance(node, ast.BinOp):
            # 任意二元运算：操作数污点保守传播（字符串拼接是重点场景）
            return (self._eval(state, node.left, scope_stack)
                    | self._eval(state, node.right, scope_stack))

        if isinstance(node, ast.UnaryOp):
            return self._eval(state, node.operand, scope_stack)

        if isinstance(node, ast.BoolOp):
            labels = set()
            for value in node.values:
                labels |= self._eval(state, value, scope_stack)
            return labels

        if isinstance(node, ast.Compare):
            labels = self._eval(state, node.left, scope_stack)
            for comp in node.comparators:
                labels |= self._eval(state, comp, scope_stack)
            return labels

        if isinstance(node, ast.IfExp):
            self._eval(state, node.test, scope_stack)
            return (self._eval(state, node.body, scope_stack)
                    | self._eval(state, node.orelse, scope_stack))

        if isinstance(node, ast.Subscript):
            # 下标取值：容器与键的污点都可能影响结果，保守合并
            return (self._eval(state, node.value, scope_stack)
                    | self._eval_slice(state, node.slice, scope_stack))

        if isinstance(node, ast.Slice):
            return self._eval_slice(state, node, scope_stack)

        if isinstance(node, ast.Starred):
            return self._eval(state, node.value, scope_stack)

        if isinstance(node, ast.NamedExpr):  # 海象运算符 (x := expr)
            labels = self._eval(state, node.value, scope_stack)
            self._assign_target(state, node.target, labels, scope_stack)
            return labels

        if isinstance(node, ast.Attribute):
            return self._read_attribute(state, node, scope_stack)

        if isinstance(node, ast.Lambda):
            # 立即调用的 lambda 很少见；按普通表达式求一次值，
            # 形参没有实参绑定，不注入符号污点。
            return self._eval(state, node.body, scope_stack)

        if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp,
                             ast.DictComp)):
            return self._eval_comprehension(state, node, scope_stack)

        if isinstance(node, ast.Call):
            return self._eval_call(state, node, scope_stack)

        # 未识别的表达式：保守合并所有子表达式污点
        labels = set()
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.expr):
                labels |= self._eval(state, child, scope_stack)
        return labels

    def _eval_slice(self, state: _FuncState, sl: ast.AST,
                    scope_stack: list[dict[str, set[TaintLabel]]]
                    ) -> set[TaintLabel]:
        if isinstance(sl, ast.Slice):
            return (self._eval(state, sl.lower, scope_stack)
                    | self._eval(state, sl.upper, scope_stack)
                    | self._eval(state, sl.step, scope_stack))
        return self._eval(state, sl, scope_stack)

    def _union_children(self, state: _FuncState, nodes: list[ast.AST],
                        scope_stack: list[dict[str, set[TaintLabel]]]
                        ) -> set[TaintLabel]:
        labels = set()
        for child in nodes:
            labels |= self._eval(state, child, scope_stack)
        return labels

    def _bind_match_pattern(self, state: _FuncState, pattern: ast.AST,
                            subject_labels: set[TaintLabel],
                            scope_stack: list[dict[str, set[TaintLabel]]]) -> None:
        """把 match 模式里的捕获变量保守绑定为主体表达式的污点。"""
        match_as = getattr(ast, "MatchAs", None)
        match_mapping = getattr(ast, "MatchMapping", None)
        match_class = getattr(ast, "MatchClass", None)
        match_sequence = getattr(ast, "MatchSequence", None)
        if match_as is not None and isinstance(pattern, match_as):
            if pattern.pattern is not None:
                self._bind_match_pattern(state, pattern.pattern,
                                         subject_labels, scope_stack)
            if pattern.name is not None:
                self._assign_target(
                    state, ast.Name(id=pattern.name, ctx=ast.Store()),
                    subject_labels, scope_stack
                )
        elif match_mapping is not None and isinstance(pattern, match_mapping):
            for sub in pattern.patterns:
                self._bind_match_pattern(state, sub, subject_labels,
                                         scope_stack)
            for rest in pattern.keys:
                self._eval(state, rest, scope_stack)
        elif match_class is not None and isinstance(pattern, match_class):
            for sub in pattern.patterns:
                self._bind_match_pattern(state, sub, subject_labels,
                                         scope_stack)
            for kwd in pattern.kwd_patterns:
                self._bind_match_pattern(state, kwd, subject_labels,
                                         scope_stack)
        elif match_sequence is not None and isinstance(pattern, match_sequence):
            for sub in pattern.patterns:
                self._bind_match_pattern(state, sub, subject_labels,
                                         scope_stack)
        elif match_as is not None:
            # MatchOr / MatchValue / MatchSingleton：无新捕获变量，
            # 但 MatchOr 的子模式仍可能含捕获
            for child in ast.iter_child_nodes(pattern):
                if isinstance(child, ast.pattern):
                    self._bind_match_pattern(state, child, subject_labels,
                                             scope_stack)

    def _eval_comprehension(self, state: _FuncState, node: ast.AST,
                            scope_stack: list[dict[str, set[TaintLabel]]]
                            ) -> set[TaintLabel]:
        local_scope: dict[str, set[TaintLabel]] = {}
        scopes = scope_stack + [local_scope]
        for gen in node.generators:
            iter_labels = self._iter_taint(state, gen.iter, scope_stack)
            self._assign_target(state, gen.target, iter_labels, scopes)
            self._eval(state, gen.iter, scopes)
            for cond in gen.ifs:
                self._eval(state, cond, scopes)
        if isinstance(node, ast.DictComp):
            return (self._eval(state, node.key, scopes)
                    | self._eval(state, node.value, scopes))
        return self._eval(state, node.elt, scopes)

    def _iter_taint(self, state: _FuncState, node: ast.AST,
                    scope_stack: list[dict[str, set[TaintLabel]]]
                    ) -> set[TaintLabel]:
        # 迭代对象的污点保守传播给循环变量（dict/列表等统一处理）
        return self._eval(state, node, scope_stack)

    # ------------------------------------------------------------------
    # 名字与属性读取
    # ------------------------------------------------------------------
    def _lookup_name(self, state: _FuncState, name: str,
                     scope_stack: list[dict[str, set[TaintLabel]]]
                     ) -> set[TaintLabel]:
        # 形参符号标签
        if name in state.entry_labels:
            return {state.entry_labels[name]}
        # 局部作用域（内层优先）
        for scope in reversed(scope_stack):
            if name in scope:
                return set(scope[name])
        # 模块全局
        return set(self.globals[state.fkey[0]].get(name, set()))

    def _read_attribute(self, state: _FuncState, node: ast.Attribute,
                        scope_stack: list[dict[str, set[TaintLabel]]]
                        ) -> set[TaintLabel]:
        # self.field -> 类字段污点
        if isinstance(node.value, ast.Name) and node.value.id == "self":
            class_name = state.info.class_name if state.info else None
            if class_name and node.attr in self.fields.get(class_name, {}):
                labels = self.fields[class_name][node.attr]
                return self._concretize_field_labels(
                    class_name, node.attr, labels, state
                )
            return set()
        # 其他对象属性：无对象模型，不求值出污点（链上的调用由 Call 处理）
        return set()

    def _concretize_field_labels(self, class_name: str, field_name: str,
                                 labels: set[TaintLabel],
                                 reader_state: _FuncState
                                 ) -> set[TaintLabel]:
        """字段里若存的是形参符号标签，沿 setter 调用链反向具象化。

        例如：
            def set_filter(self, value): self.filter_value = value
            ...
            dao.set_filter(request.form['x'])   # 调用点实参可控
            def search(self): ... self.filter_value ...  # 读取侧
        读取时把 value 的符号标签替换成调用点实参标签，
        从而让源头显示为真实的 request 输入，而不是 parameter:value。
        """
        result: set[TaintLabel] = set()
        writes = self.field_writes.get((class_name, field_name), [])
        for label in labels:
            if label.origin.file != "<parameter>":
                result.add(label)
                continue
            param_name = label.param_origin[1] if label.param_origin \
                else label.origin.code
            resolved = False
            for writer_fkey, writer_params in writes:
                if param_name not in writer_params:
                    continue
                writer_state = self.states.get(writer_fkey)
                if writer_state is None:
                    continue
                # 找谁调用了这个 writer，并取对应实参
                for caller_fkey, caller_state in self.states.items():
                    if caller_state.info is None:
                        continue
                    for concrete, writer_call in self._find_call_args(
                        caller_state, writer_fkey, param_name
                    ):
                        callee_name = writer_fkey[1]
                        hop = Hop(
                            file=caller_state.fkey[0],
                            line=writer_call.lineno,
                            function=(f"{caller_state.fkey[1]} "
                                      f"-> {callee_name}"),
                            code=f"{_code_of(writer_call.func)}(...)",
                        )
                        merged_hops = concrete.hops
                        if hop not in merged_hops:
                            merged_hops = merged_hops + (hop,)
                        merged = TaintLabel(
                            origin=concrete.origin,
                            hops=merged_hops + label.hops,
                        )
                        if merged.depth <= _MAX_HOPS:
                            result.add(merged)
                        resolved = True
            if not resolved:
                # 找不到具象来源（例如库代码外部调用），保留符号标签，
                # 由 sink 侧的 pending 机制兜底
                result.add(label)
        return self._cap(result)

    def _find_call_args(self, caller_state: _FuncState,
                        callee_fkey: tuple[str, str], param_name: str
                        ) -> list[tuple[TaintLabel, ast.Call]]:
        """在调用方函数体里找对 callee 的调用，返回 (实参标签, 调用节点)。"""
        if caller_state.info is None:
            return []
        found: list[tuple[TaintLabel, ast.Call]] = []
        for call in (n for n in ast.walk(caller_state.info.node)
                     if isinstance(n, ast.Call)):
            resolved = self._resolve_callee(caller_state, call)
            if resolved is None or resolved[0] != callee_fkey:
                continue
            callee_state = resolved[1]
            idx = callee_state.arg_index.get(param_name, -2)
            # 方法的第一个形参是 self/cls，调用实参从位置 0 开始，
            # 因此要减去接收者占用的那个形参位置。
            receiver_offset = 1 if self._callee_has_receiver(
                callee_state) else 0
            adjusted = idx - receiver_offset
            if 0 <= adjusted < len(call.args):
                for lab in self._eval_in_caller(caller_state,
                                                call.args[adjusted]):
                    found.append((lab, call))
            for kw in call.keywords:
                if kw.arg == param_name:
                    for lab in self._eval_in_caller(caller_state, kw.value):
                        found.append((lab, call))
        return found

    @staticmethod
    def _callee_has_receiver(callee_state: _FuncState) -> bool:
        info = callee_state.info
        if info is None:
            return False
        args = info.node.args
        posonly = getattr(args, "posonlyargs", [])
        all_pos = posonly + args.args
        return bool(all_pos) and all_pos[0].arg in ("self", "cls")

    def _eval_in_caller(self, state: _FuncState, node: ast.AST
                        ) -> set[TaintLabel]:
        """在调用方完整上下文里求值实参。

        调用方的局部变量不在入口作用域中，因此重新按函数体跑一遍
        语句级分析来重建局部作用域（只收集到目标表达式所需的名字）。
        实现上复用常规分析：用一个全新局部作用域顺序执行函数体，
        边执行边记录，最后在该作用域上求值目标节点。
        """
        local_scope: dict[str, set[TaintLabel]] = {}
        scope_stack = [local_scope]
        if state.info is not None:
            for stmt in state.info.node.body:
                # 命中包含目标节点的语句后，语句内部会完成求值
                if self._stmt_contains(stmt, node):
                    self._stmt(state, stmt, scope_stack)
                    break
                self._stmt(state, stmt, scope_stack)
        return self._eval(state, node, scope_stack)

    @staticmethod
    def _stmt_contains(stmt: ast.stmt, target: ast.AST) -> bool:
        for child in ast.walk(stmt):
            if child is target:
                return True
        return False

    # ------------------------------------------------------------------
    # 调用求值（过程间分析的核心）
    # ------------------------------------------------------------------
    def _eval_call(self, state: _FuncState, call: ast.Call,
                   scope_stack: list[dict[str, set[TaintLabel]]]
                   ) -> set[TaintLabel]:
        # 1) 调用本身（或被调对象）就是输入源，例如 input()
        source = extract_source(call)
        if source is not None:
            kind, code = source
            return {TaintLabel(origin=Origin(
                file=state.fkey[0], line=call.lineno,
                source_kind=kind, code=code,
            ))}

        # 2) 求所有实参的污点
        arg_labels = [self._eval(state, a, scope_stack) for a in call.args]
        kw_labels = {kw.arg: self._eval(state, kw.value, scope_stack)
                     for kw in call.keywords if kw.arg is not None}
        # **kwargs 形式的关键字展开
        double_star = [self._eval(state, kw.value, scope_stack)
                       for kw in call.keywords if kw.arg is None]

        all_arg_labels: set[TaintLabel] = set()
        for labels in arg_labels:
            all_arg_labels |= labels
        for labels in kw_labels.values():
            all_arg_labels |= labels
        for labels in double_star:
            all_arg_labels |= labels

        # 3) 数据库执行点检查
        sink_info = match_sink(call)
        if sink_info is not None:
            self._check_sink(state, call, sink_info, arg_labels, kw_labels,
                             scope_stack)

        # 4) 解析被调函数，做过程间传播
        resolved = self._resolve_callee(state, call)

        # 5) 内置净化函数：结果无污点
        func_name = call.func.id if isinstance(call.func, ast.Name) else (
            call.func.attr if isinstance(call.func, ast.Attribute) else "")
        if func_name in _CLEANSING_BUILTINS:
            return set()

        if resolved is None:
            # 无法解析的调用：
            # - 字符串/已知透传方法：按实参污点透传（拼接、格式化等）
            # - 其他未知函数：保守透传，避免对封装函数漏报
            return self._unresolved_call_taint(state, call, all_arg_labels,
                                               scope_stack)

        callee_fkey, callee_state = resolved
        # 6) 用实参具象化被调函数内部的形参 sink
        self._materialize_pending_sinks(state, call, callee_state,
                                        arg_labels, kw_labels, scope_stack)
        # 7) 返回值污点：把形参符号标签替换为实参标签，并追加调用跳
        hop = self._hop(state, call)
        result: set[TaintLabel] = set()
        for label in callee_state.ret_labels:
            result |= self._substitute(label, callee_state, call,
                                       arg_labels, kw_labels, hop, scope_stack)
        return self._cap(result)

    def _check_sink(self, state: _FuncState, call: ast.Call,
                    sink_info: dict,
                    arg_labels: list[set[TaintLabel]],
                    kw_labels: dict[str, set[TaintLabel]],
                    scope_stack: list[dict[str, set[TaintLabel]]]) -> None:
        qidx = sink_info["query_index"]
        query_labels: set[TaintLabel] = set()
        if qidx < len(arg_labels):
            query_labels |= arg_labels[qidx]
        for kw in call.keywords:
            if kw.arg and kw.arg not in sink_info["param_keywords"]:
                # 以关键字形式传入的查询文本
                if kw.arg in ("sql", "query", "statement", "stmt", "q"):
                    query_labels |= kw_labels.get(kw.arg, set())

        has_params = call_has_params(call, sink_info)
        for label in query_labels:
            self._emit_from_label(state, call, sink_info, label, has_params,
                                  scope_stack)

    def _emit_from_label(self, state: _FuncState, call: ast.Call,
                         sink_info: dict, label: TaintLabel,
                         has_params: bool,
                         scope_stack: list[dict[str, set[TaintLabel]]]) -> None:
        """把一个到达 sink 的标签转成发现；本函数形参标签登记为延迟 sink。

        延迟的意义：函数单独分析时不知道实参是否真的可控，
        等调用点用具象污点替换形参符号后再发出发现。
        标签可能从被调函数的返回值"透传"进来（param_origin 指向被调
        函数），因此按形参名在当前函数签名里查找，而不是比较属主。
        """
        candidate_names: list[str] = []
        if label.param_origin is not None:
            candidate_names.append(label.param_origin[1])
        if label.origin.file == "<parameter>":
            candidate_names.append(label.origin.code)
        for name in candidate_names:
            if name in state.entry_labels:
                record = (sink_info, name, label, call, has_params)
                if record not in state.pending_sinks:
                    state.pending_sinks.append(record)
                    self.changed = True
                return
        self._emit_finding(state, call, sink_info, label, has_params)

    def _is_local_symbol(self, state: _FuncState, label: TaintLabel) -> bool:
        """标签是否仍是当前函数的形参符号（尚未被调用点具象化）。

        这类标签不能直接发发现，否则会产生 parameter:xxx 的伪源头，
        应登记为延迟 sink，等真实调用点实参替换后再报告。
        """
        if label.param_origin is not None:
            owner = label.param_origin[0]
            if owner == f"{state.fkey[0]}::{state.fkey[1]}":
                return True
        return label.origin.file == "<parameter>"

    def _emit_finding(self, state: _FuncState, call: ast.Call,
                      sink_info: dict, label: TaintLabel,
                      has_params: bool) -> None:
        if label.depth > _MAX_HOPS:
            return
        if self._is_local_symbol(state, label):
            name = (label.param_origin[1] if label.param_origin
                    else label.origin.code)
            if name in state.entry_labels:
                record = (sink_info, name, label, call, has_params)
                if record not in state.pending_sinks:
                    state.pending_sinks.append(record)
                    self.changed = True
            return
        if sink_info["heuristic"]:
            severity = Severity.LOW
            reason = ("数据经过名称疑似数据库执行的函数 %s()，"
                      "但其定义无法在项目内解析，需人工确认是否为查询执行点"
                      % sink_info["name"])
            rule_id = "SQLI-002"
        elif has_params:
            severity = Severity.MEDIUM
            reason = ("不可信输入被拼进查询文本后才传入 %s()；"
                      "即使同时提供了参数化实参，拼接部分仍可被注入"
                      % sink_info["name"])
            rule_id = "SQLI-001"
        else:
            severity = Severity.HIGH
            reason = ("不可信输入直接进入 %s() 的查询文本且未使用参数化绑定，"
                      "存在 SQL 注入风险" % sink_info["name"])
            rule_id = "SQLI-001"

        finding = Finding(
            rule_id=rule_id,
            severity=severity,
            file=state.fkey[0],
            line=call.lineno,
            sink_function=sink_info["name"],
            code=_code_of(call),
            origin=label.origin,
            hops=label.hops,
            reason=reason,
            has_params=has_params,
        )
        key = finding.dedup_key()
        existing = self._finding_dedup.get(key)
        if existing is not None:
            if label.depth < existing:
                # 同问题找到了更短路径：替换
                self.findings = [f for f in self.findings
                                 if f.dedup_key() != key]
                self._finding_dedup[key] = label.depth
                self.findings.append(finding)
            return
        self._finding_dedup[key] = label.depth
        self.findings.append(finding)

    def _materialize_pending_sinks(self, state: _FuncState, call: ast.Call,
                                   callee: _FuncState,
                                   arg_labels: list[set[TaintLabel]],
                                   kw_labels: dict[str, set[TaintLabel]],
                                   scope_stack: list[dict[str, set[TaintLabel]]]
                                   ) -> None:
        """调用点：把被调函数里"形参到达 sink"的记录用具象实参展开。"""
        hop = self._hop(state, call)
        for sink_info, param_name, sink_label, callee_call, has_params in \
                callee.pending_sinks:
            concrete = self._labels_for_param(callee, param_name, call,
                                              arg_labels, kw_labels)
            # 形参在被调函数内部走到 sink 所经过的传播跳
            inner_hops = sink_label.hops
            for label in concrete:
                base = label.extended(hop) if hop not in label.hops \
                    else label
                if inner_hops:
                    merged = TaintLabel(
                        origin=base.origin,
                        hops=base.hops + tuple(
                            h for h in inner_hops if h not in base.hops
                        ),
                    )
                else:
                    merged = base
                # 在被调函数位置发出发现：文件/行号取被调函数内的调用点
                self._emit_finding_at(state, callee, callee_call, sink_info,
                                      merged, has_params)

    def _emit_finding_at(self, caller_state: _FuncState,
                         callee_state: _FuncState, call: ast.Call,
                         sink_info: dict, label: TaintLabel,
                         has_params: bool) -> None:
        if label.depth > _MAX_HOPS:
            return
        # 仍是形参符号（例如递归调用链尚未完全具象化）时不发发现，
        # 避免出现 parameter:xxx 伪源头，等待后续轮次的真实实参
        if label.origin.file == "<parameter>":
            return
        if sink_info["heuristic"]:
            severity = Severity.LOW
            reason = ("数据经过名称疑似数据库执行的函数 %s()，"
                      "但其定义无法在项目内解析，需人工确认是否为查询执行点"
                      % sink_info["name"])
            rule_id = "SQLI-002"
        elif has_params:
            severity = Severity.MEDIUM
            reason = ("不可信输入经函数传递后被拼进查询文本，"
                      "%s() 虽带有参数化实参，拼接部分仍可被注入"
                      % sink_info["name"])
            rule_id = "SQLI-001"
        else:
            severity = Severity.HIGH
            reason = ("不可信输入经函数传递后进入 %s() 的查询文本，"
                      "未使用参数化绑定，存在 SQL 注入风险"
                      % sink_info["name"])
            rule_id = "SQLI-001"

        finding = Finding(
            rule_id=rule_id,
            severity=severity,
            file=callee_state.fkey[0],
            line=call.lineno,
            sink_function=sink_info["name"],
            code=_code_of(call),
            origin=label.origin,
            hops=label.hops,
            reason=reason,
            has_params=has_params,
        )
        key = finding.dedup_key()
        existing = self._finding_dedup.get(key)
        if existing is not None:
            if label.depth < existing:
                self.findings = [f for f in self.findings
                                 if f.dedup_key() != key]
                self._finding_dedup[key] = label.depth
                self.findings.append(finding)
            return
        self._finding_dedup[key] = label.depth
        self.findings.append(finding)

    def _labels_for_param(self, callee: _FuncState, param_name: str,
                          call: ast.Call,
                          arg_labels: list[set[TaintLabel]],
                          kw_labels: dict[str, set[TaintLabel]]
                          ) -> set[TaintLabel]:
        idx = callee.arg_index.get(param_name, -2)
        labels: set[TaintLabel] = set()
        if idx >= 0 and idx < len(arg_labels):
            labels |= arg_labels[idx]
        if param_name in kw_labels:
            labels |= kw_labels[param_name]
        # *args / **kwargs 形参：所有实参都可能流入
        info = callee.info
        if info is not None:
            node = info.node
            if node.args.vararg and param_name == node.args.vararg.arg:
                for labelset in arg_labels:
                    labels |= labelset
            if node.args.kwarg and param_name == node.args.kwarg.arg:
                for labelset in kw_labels.values():
                    labels |= labelset
        return labels

    def _substitute(self, label: TaintLabel, callee: _FuncState,
                    call: ast.Call,
                    arg_labels: list[set[TaintLabel]],
                    kw_labels: dict[str, set[TaintLabel]],
                    hop: Optional[Hop],
                    scope_stack: list[dict[str, set[TaintLabel]]]
                    ) -> set[TaintLabel]:
        """把返回标签里的形参符号替换成调用点实参标签。

        标签的 param_origin 可能指向调用链上更内层的函数（多层包装），
        因此：属主匹配当前被调函数就用具象实参替换；否则保留符号，
        交给更外层的调用点继续解析。
        """
        if label.param_origin is None:
            if hop is not None and hop not in label.hops:
                return {label.extended(hop)}
            return {label}

        owner_fkey, param_name, _ = label.param_origin
        if owner_fkey != f"{callee.fkey[0]}::{callee.fkey[1]}":
            # 内层函数的形参符号：原样向上传递，由外层调用点解析
            return {label}

        concrete = self._labels_for_param(callee, param_name, call,
                                          arg_labels, kw_labels)
        if not concrete:
            return set()
        result = set()
        inner_hops = label.hops
        for src in concrete:
            if src.origin.file == "<parameter>":
                # 实参本身仍是形参符号：继续携带符号，保留内层传播路径
                merged = TaintLabel(
                    origin=src.origin,
                    hops=src.hops + inner_hops,
                    param_origin=src.param_origin,
                )
            else:
                merged = TaintLabel(
                    origin=src.origin,
                    hops=src.hops
                    + ((hop,) if hop and hop not in src.hops else tuple())
                    + inner_hops,
                )
            if merged.depth <= _MAX_HOPS:
                result.add(merged)
        return result

    # ------------------------------------------------------------------
    # 被调函数解析
    # ------------------------------------------------------------------
    def _resolve_callee(self, state: _FuncState, call: ast.Call
                        ) -> Optional[tuple[tuple[str, str], _FuncState]]:
        func = call.func
        reg = self.registries[state.fkey[0]]

        # 裸函数名：本地函数 / from import
        if isinstance(func, ast.Name):
            name = func.id
            fkey = (state.fkey[0], name)
            if fkey in self.states and name in reg.functions:
                return fkey, self.states[fkey]
            if name in reg.from_imports:
                src_mod, orig_name = reg.from_imports[name]
                target = (src_mod, orig_name)
                if target in self.states:
                    return target, self.states[target]
            return None

        if not isinstance(func, ast.Attribute):
            return None

        # module.func(...) 形式
        if isinstance(func.value, ast.Name):
            owner = func.value.id
            if owner in reg.module_aliases:
                target = (reg.module_aliases[owner], func.attr)
                if target in self.states:
                    return target, self.states[target]
            # self.method(...) / cls.method(...)：同类方法
            if owner in ("self", "cls") and state.info is not None:
                class_name = state.info.class_name
                if class_name:
                    target = (state.fkey[0], f"{class_name}.{func.attr}")
                    if target in self.states:
                        return target, self.states[target]
            # 局部构造的对象变量（dao = UserDAO(...) 后调用 dao.method()）：
            # 落到下面的对象类型推断统一处理，这里不能提前返回。

        # obj.method(...)：尝试按类的字段初始化推断对象类型（new 出来的对象）
        obj_type = self._infer_object_type(state, func.value, [])
        if obj_type is not None:
            mod_id, class_name = obj_type
            # 方法在函数表里以 "类名.方法名" 的限定名登记
            target = (mod_id, f"{class_name}.{func.attr}")
            if target in self.states:
                return target, self.states[target]
        return None

    def _infer_object_type(self, state: _FuncState, node: ast.AST,
                           seen: list[str]
                           ) -> Optional[tuple[str, str]]:
        """非常轻量的对象类型推断：只识别 变量 = ClassName(...) 的情况。"""
        if not isinstance(node, ast.Name):
            return None
        name = node.id
        if name in seen:
            return None
        reg = self.registries[state.fkey[0]]
        # 在当前函数体里找对该变量的构造赋值
        if state.info is not None:
            for sub in ast.walk(state.info.node):
                if isinstance(sub, ast.Assign) and any(
                    isinstance(t, ast.Name) and t.id == name
                    for t in sub.targets
                ) and isinstance(sub.value, ast.Call):
                    ctor = sub.value.func
                    if isinstance(ctor, ast.Name) and ctor.id in reg.classes:
                        return (state.fkey[0], ctor.id)
                    if isinstance(ctor, ast.Name) and ctor.id in \
                            reg.from_imports:
                        src_mod, orig = reg.from_imports[ctor.id]
                        if (src_mod, orig) in {
                            (m, c) for m, r in self.registries.items()
                            for c in r.classes
                        }:
                            return (src_mod, orig)
        return None

    # ------------------------------------------------------------------
    # 无法解析的调用
    # ------------------------------------------------------------------
    def _unresolved_call_taint(self, state: _FuncState, call: ast.Call,
                               all_arg_labels: set[TaintLabel],
                               scope_stack: list[dict[str, set[TaintLabel]]]
                               ) -> set[TaintLabel]:
        func = call.func
        # 字符串方法：按方法语义处理
        if isinstance(func, ast.Attribute):
            method = func.attr
            if method in _PASSTHROUGH_STR_METHODS or \
                    method in _TAINTED_ITER_METHODS:
                labels = set(all_arg_labels) | self._eval(
                    state, func.value, scope_stack
                )
                # str.join：被拼接的可迭代对象污点也进入结果
                return self._cap(labels)
            # 其余未知方法：保守透传接收者与实参污点
            labels = all_arg_labels | self._eval(state, func.value,
                                                 scope_stack)
            return self._cap(labels)
        # 未知裸函数：保守透传实参污点（封装函数场景由过程间解析覆盖，
        # 解析不到时也不漏掉数据流）
        return self._cap(set(all_arg_labels))

    # ------------------------------------------------------------------
    # 辅助
    # ------------------------------------------------------------------
    def _hop(self, state: _FuncState, call: ast.Call) -> Hop:
        func_name = _code_of(call.func)
        # function 体现 "调用方 -> 被调" 的关系，跨文件时配合 file 字段
        return Hop(
            file=state.fkey[0],
            line=call.lineno,
            function=f"{state.fkey[1]} -> {func_name}",
            code=f"{func_name}(...)",
        )

    def _cap(self, labels: set[TaintLabel]) -> set[TaintLabel]:
        if len(labels) <= _MAX_LABELS_PER_SLOT:
            return labels
        # 优先保留短路径，避免标签膨胀
        return set(sorted(labels, key=lambda l: (l.depth, l.origin.file,
                                                 l.origin.line))
                   [:_MAX_LABELS_PER_SLOT])
