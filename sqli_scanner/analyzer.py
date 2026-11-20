"""基于 AST 的污点分析引擎。

分析方式：
* 每个 Python 文件独立解析，不 import、不执行被扫描代码；
* 在每个函数作用域内模拟赋值、字符串拼接、f-string、% 格式化、下标/属性传递；
* 同一文件内的本地函数调用会做简单的过程间分析（带递归深度与环保护）；
* 无法解析的调用链不会被当成确定漏洞，而是标记为待复核（review）。
"""

from __future__ import annotations

import ast
from collections import defaultdict
from typing import Dict, List, Optional, Sequence, Set, Tuple

from . import sources as src_rules
from .model import (
    Finding,
    RULE_TAINTED_SQL,
    RULE_UNCONFIRMED_SQL,
    SEVERITY_REVIEW,
    SEVERITY_VULNERABILITY,
    Taint,
    TaintOrigin,
    TraceStep,
)

MAX_CALL_DEPTH = 8


def _segment(source: str, node: ast.AST) -> str:
    text = ast.get_source_segment(source, node)
    if text is None:
        return ""
    return " ".join(text.split())


def merge_taints(taints: Sequence[Taint]) -> Optional[Taint]:
    """合并多个污点：来源与传播路径取并集。"""
    valid = [t for t in taints if t is not None]
    if not valid:
        return None
    origins: List[TaintOrigin] = []
    seen_origins = set()
    steps: List[TraceStep] = []
    seen_steps = set()
    unknown = False
    for taint in valid:
        unknown = unknown or taint.unknown
        for origin in taint.origins:
            key = (origin.kind, origin.name, origin.path, origin.lineno)
            if key not in seen_origins:
                seen_origins.add(key)
                origins.append(origin)
        for step in taint.steps:
            key = (step.lineno, step.kind, step.detail, step.code)
            if key not in seen_steps:
                seen_steps.add(key)
                steps.append(step)
    if not origins and not unknown:
        return None
    return Taint(origins=origins, steps=steps, unknown=unknown)


class ModuleAnalyzer:
    """解析并分析单个 Python 文件。"""

    def __init__(
        self,
        path: str,
        source: str,
        extra_sources: Optional[Set[str]] = None,
        assume_params_tainted: bool = False,
    ) -> None:
        self.path = path
        self.source = source
        self.extra_sources = extra_sources or set()
        self.assume_params_tainted = assume_params_tainted
        self.tree = ast.parse(source, filename=path)
        # 函数名 -> 该文件内的所有定义（用于过程间解析）
        self.function_defs: Dict[str, List[ast.FunctionDef]] = defaultdict(list)
        for node in ast.walk(self.tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.function_defs[node.name].append(node)
        self.findings: List[Finding] = []
        self._seen_ids: Set[str] = set()

    def analyze(self) -> List[Finding]:
        top = BodyAnalyzer(
            module=self,
            parent=None,
            func_node=None,
            bound_params={},
            depth=0,
            active_funcs=(),
        )
        top.visit(self.tree)
        return self.findings

    def add_finding(self, finding: Finding) -> None:
        finding.compute_fingerprint()
        if finding.finding_id not in self._seen_ids:
            self._seen_ids.add(finding.finding_id)
            self.findings.append(finding)

    def resolve_function(self, name: str, lineno: int) -> Optional[ast.FunctionDef]:
        """按名字解析本文件内的函数定义，优先取调用点之前最近定义的。"""
        defs = self.function_defs.get(name)
        if not defs:
            return None
        visible = [d for d in defs if d.lineno <= lineno]
        if visible:
            return visible[-1]
        return defs[0]


class BodyAnalyzer(ast.NodeVisitor):
    """对一个作用域（模块或函数体）做污点模拟。"""

    def __init__(
        self,
        module: ModuleAnalyzer,
        parent: Optional["BodyAnalyzer"],
        func_node: Optional[ast.FunctionDef],
        bound_params: Dict[str, Taint],
        depth: int,
        active_funcs: Tuple[str, ...],
    ) -> None:
        self.module = module
        self.parent = parent
        self.func_node = func_node
        self.env: Dict[str, Taint] = dict(bound_params)
        # 静态可解析的属性/下标赋值：key -> Taint
        self.attr_store: Dict[str, Taint] = {}
        self.sub_store: Dict[str, Taint] = {}
        self.depth = depth
        self.active_funcs = active_funcs
        self.return_taints: List[Taint] = []

        # 可选：把函数参数整体视为不可信输入（覆盖 web 框架参数注入场景）
        if (
            module.assume_params_tainted
            and func_node is not None
            and not bound_params  # 只在真实入口函数上生效，递归调用带参时不重复标记
        ):
            origin_line = func_node.lineno
            for arg in func_node.args.posonlyargs + func_node.args.args + func_node.args.kwonlyargs:
                if arg.arg == "self":
                    continue
                origin = TaintOrigin(
                    kind="unknown",
                    name=f"param:{arg.arg}",
                    path=module.path,
                    lineno=arg.lineno,
                    col=arg.col_offset,
                )
                self.env[arg.arg] = Taint(
                    origins=[origin],
                    unknown=True,
                    steps=[
                        TraceStep(
                            lineno=arg.lineno,
                            kind="source",
                            detail=f"参数 {arg.arg} 按不可信输入处理（--assume-params-tainted）",
                            code=arg.arg,
                        )
                    ],
                )

    # ------------------------------------------------------------------ 工具

    def _step(self, node: ast.AST, kind: str, detail: str) -> TraceStep:
        return TraceStep(
            lineno=getattr(node, "lineno", 0),
            kind=kind,
            detail=detail,
            code=_segment(self.module.source, node),
        )

    def _origin(self, node: ast.AST, kind: str, name: str) -> TaintOrigin:
        return TaintOrigin(
            kind=kind,
            name=name,
            path=self.module.path,
            lineno=getattr(node, "lineno", 0),
            col=getattr(node, "col_offset", 0),
        )

    def _with_step(self, taint: Taint, node: ast.AST, kind: str, detail: str) -> Taint:
        result = taint.clone()
        result.steps.append(self._step(node, kind, detail))
        return result

    def lookup_name(self, name: str) -> Optional[Taint]:
        analyzer: Optional[BodyAnalyzer] = self
        while analyzer is not None:
            if name in analyzer.env:
                return analyzer.env[name]
            analyzer = analyzer.parent
        return None

    def _store_key_attr(self, node: ast.Attribute) -> Optional[str]:
        chain = src_rules.attr_chain(node)
        if chain is not None:
            return "attr:" + ".".join(chain)
        return None

    def _store_key_subscript(self, node: ast.Subscript) -> Optional[str]:
        chain = src_rules.attr_chain(node.value)
        base = ".".join(chain) if chain is not None else (
            node.value.id if isinstance(node.value, ast.Name) else None
        )
        if base is None:
            return None
        key = self._const_value(node.slice)
        if key is None:
            return None
        return f"sub:{base}[{key!r}]"

    @staticmethod
    def _const_value(node: ast.AST):
        # 下标在 3.9 之后直接是表达式，老版本包了 ast.Index
        if hasattr(ast, "Index") and isinstance(node, ast.Index):  # pragma: no cover
            node = node.value
        if isinstance(node, ast.Constant):
            return node.value
        return None

    # ------------------------------------------------------------ 语句访问

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        if self.func_node is None:
            # 模块顶层函数：作为分析入口，用独立作用域分析函数体
            entry = BodyAnalyzer(
                module=self.module,
                parent=self,
                func_node=node,
                bound_params={},
                depth=0,
                active_funcs=(node.name,),
            )
            for stmt in node.body:
                entry.visit(stmt)
        # 函数内部的嵌套定义只在被调用时分析，这里不递归进入

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        return

    def visit_Assign(self, node: ast.Assign) -> None:
        taint = self.eval_taint(node.value)
        if taint is not None:
            taint = self._with_step(taint, node, "assign", "赋值语句携带污点")
            for target in node.targets:
                self._bind(target, taint)
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if node.value is not None:
            taint = self.eval_taint(node.value)
            if taint is not None:
                self._bind(
                    node.target,
                    self._with_step(taint, node, "assign", "赋值语句携带污点"),
                )
        self.generic_visit(node)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        taint = self.eval_taint(node.value)
        existing = self.eval_taint(node.target)
        merged = merge_taints([t for t in (taint, existing) if t is not None])
        if merged is not None:
            self._bind(
                node.target,
                self._with_step(merged, node, "assign", "增量赋值携带污点"),
            )
        self.generic_visit(node)

    def visit_Return(self, node: ast.Return) -> None:
        if node.value is not None:
            taint = self.eval_taint(node.value)
            if taint is not None:
                self.return_taints.append(taint)
        self.generic_visit(node)

    def visit_For(self, node: ast.For) -> None:
        iter_taint = self.eval_taint(node.iter)
        if iter_taint is not None:
            self._bind(
                node.target,
                self._with_step(iter_taint, node, "assign", "for 循环变量携带污点"),
            )
        for stmt in node.body + node.orelse:
            self.visit(stmt)

    visit_AsyncFor = visit_For

    def visit_Expr(self, node: ast.Expr) -> None:
        # 裸表达式语句（例如单独成行的 cursor.execute(sql)）
        self.eval_taint(node.value)
        self.generic_visit(node)

    def _bind(self, target: ast.AST, taint: Taint) -> None:
        if isinstance(target, ast.Name):
            self.env[target.id] = taint
        elif isinstance(target, (ast.Tuple, ast.List)):
            for elt in target.elts:
                if isinstance(elt, ast.Starred):
                    self._bind(elt.value, taint)
                else:
                    self._bind(elt, taint)
        elif isinstance(target, ast.Attribute):
            key = self._store_key_attr(target)
            if key is not None:
                self.attr_store[key] = taint
        elif isinstance(target, ast.Subscript):
            key = self._store_key_subscript(target)
            if key is not None:
                self.sub_store[key] = taint

    # ------------------------------------------------------------ 污点求值

    def eval_taint(self, node: Optional[ast.AST], depth: Optional[int] = None) -> Optional[Taint]:
        if node is None:
            return None
        depth = self.depth if depth is None else depth
        method = "_eval_" + type(node).__name__
        handler = getattr(self, method, None)
        if handler is None:
            # 不认识的语法结构：保守地不传播
            return None
        return handler(node, depth)

    def _eval_Name(self, node: ast.Name, depth: int) -> Optional[Taint]:
        return self.lookup_name(node.id)

    def _eval_Constant(self, node: ast.Constant, depth: int) -> Optional[Taint]:
        return None

    def _eval_Attribute(self, node: ast.Attribute, depth: int) -> Optional[Taint]:
        source_name = src_rules.match_attr_source(node)
        if source_name is not None:
            origin = self._origin(node, "source", source_name)
            return Taint(
                origins=[origin],
                steps=[self._step(node, "source", f"读取外部输入 {source_name}")],
            )
        key = self._store_key_attr(node)
        if key is not None and key in self.attr_store:
            return self.attr_store[key]
        return None

    def _eval_Subscript(self, node: ast.Subscript, depth: int) -> Optional[Taint]:
        source_name = src_rules.match_subscript_source(node)
        if source_name is not None:
            origin = self._origin(node, "source", source_name)
            return Taint(
                origins=[origin],
                steps=[self._step(node, "source", f"读取外部输入 {source_name}")],
            )
        key = self._store_key_subscript(node)
        if key is not None and key in self.sub_store:
            return self.sub_store[key]
        return None

    def _eval_BinOp(self, node: ast.BinOp, depth: int) -> Optional[Taint]:
        left = self.eval_taint(node.left, depth)
        right = self.eval_taint(node.right, depth)
        merged = merge_taints([t for t in (left, right) if t is not None])
        if merged is None:
            return None
        if isinstance(node.op, ast.Mod):
            kind, detail = "percent-format", "% 格式化拼接"
        elif isinstance(node.op, ast.Add):
            kind, detail = "concat", "字符串拼接"
        else:
            kind, detail = "binop", f"运算符 {type(node.op).__name__} 组合"
        return self._with_step(merged, node, kind, detail)

    def _eval_JoinedStr(self, node: ast.JoinedStr, depth: int) -> Optional[Taint]:
        parts = [
            self.eval_taint(value, depth)
            for value in node.values
            if isinstance(value, ast.FormattedValue)
        ]
        merged = merge_taints([t for t in parts if t is not None])
        if merged is None:
            return None
        return self._with_step(merged, node, "fstring", "f-string 插值拼接")

    def _eval_FormattedValue(self, node: ast.FormattedValue, depth: int) -> Optional[Taint]:
        return self.eval_taint(node.value, depth)

    def _eval_BoolOp(self, node: ast.BoolOp, depth: int) -> Optional[Taint]:
        return merge_taints(
            [t for t in (self.eval_taint(v, depth) for v in node.values) if t is not None]
        )

    def _eval_IfExp(self, node: ast.IfExp, depth: int) -> Optional[Taint]:
        return merge_taints(
            [
                t
                for t in (
                    self.eval_taint(node.body, depth),
                    self.eval_taint(node.orelse, depth),
                )
                if t is not None
            ]
        )

    def _eval_UnaryOp(self, node: ast.UnaryOp, depth: int) -> Optional[Taint]:
        return self.eval_taint(node.operand, depth)

    def _eval_Compare(self, node: ast.Compare, depth: int) -> Optional[Taint]:
        taints = [self.eval_taint(node.left, depth)]
        taints.extend(self.eval_taint(c, depth) for c in node.comparators)
        return merge_taints([t for t in taints if t is not None])

    def _eval_Starred(self, node: ast.Starred, depth: int) -> Optional[Taint]:
        return self.eval_taint(node.value, depth)

    def _eval_List(self, node: ast.List, depth: int) -> Optional[Taint]:
        return self._eval_sequence(node.elts, depth)

    def _eval_Tuple(self, node: ast.Tuple, depth: int) -> Optional[Taint]:
        return self._eval_sequence(node.elts, depth)

    def _eval_Set(self, node: ast.Set, depth: int) -> Optional[Taint]:
        return self._eval_sequence(node.elts, depth)

    def _eval_Dict(self, node: ast.Dict, depth: int) -> Optional[Taint]:
        taints = [self.eval_taint(v, depth) for v in node.values if v is not None]
        taints += [self.eval_taint(k, depth) for k in node.keys if k is not None]
        return merge_taints([t for t in taints if t is not None])

    def _eval_sequence(self, elts: List[ast.AST], depth: int) -> Optional[Taint]:
        return merge_taints(
            [t for t in (self.eval_taint(e, depth) for e in elts) if t is not None]
        )

    def _eval_NamedExpr(self, node: ast.NamedExpr, depth: int) -> Optional[Taint]:
        taint = self.eval_taint(node.value, depth)
        if taint is not None:
            self._bind(node.target, taint)
        return taint

    def _eval_Lambda(self, node: ast.Lambda, depth: int) -> Optional[Taint]:
        # lambda 参数视为干净，只分析其函数体
        child = BodyAnalyzer(
            module=self.module,
            parent=self,
            func_node=None,
            bound_params={},
            depth=depth,
            active_funcs=self.active_funcs,
        )
        return child.eval_taint(node.body, depth)

    def _eval_Await(self, node: ast.Await, depth: int) -> Optional[Taint]:
        return self.eval_taint(node.value, depth)

    def _eval_Yield(self, node: ast.Yield, depth: int) -> Optional[Taint]:
        return self.eval_taint(node.value, depth) if node.value else None

    def _eval_GeneratorExp(self, node, depth):
        return self._eval_comprehension(node, depth)

    _eval_ListComp = _eval_GeneratorExp
    _eval_SetComp = _eval_GeneratorExp
    _eval_DictComp = _eval_GeneratorExp

    def _eval_comprehension(self, node, depth: int) -> Optional[Taint]:
        taints = []
        for generator in node.generators:
            taints.append(self.eval_taint(generator.iter, depth))
            taints.extend(self.eval_taint(cond, depth) for cond in generator.ifs)
        if isinstance(node, ast.DictComp):
            taints.append(self.eval_taint(node.key, depth))
            taints.append(self.eval_taint(node.value, depth))
        else:
            taints.append(self.eval_taint(node.elt, depth))
        return merge_taints([t for t in taints if t is not None])

    # ------------------------------------------------------------ 调用处理

    def _eval_Call(self, node: ast.Call, depth: int) -> Optional[Taint]:
        # 1) 外部输入读取
        source_name = src_rules.match_call_source(node, self.module.extra_sources)
        if source_name is not None:
            origin = self._origin(node, "source", source_name)
            return Taint(
                origins=[origin],
                steps=[self._step(node, "source", f"读取外部输入 {source_name}")],
            )

        # 2) SQL 执行点
        sink_name = src_rules.match_sql_sink(node)
        if sink_name is not None:
            self._handle_sink(node, sink_name)
            return None

        arg_taints = [self.eval_taint(a, depth) for a in node.args]
        kw_taints = [self.eval_taint(k.value, depth) for k in node.keywords]
        receiver_taint = (
            self.eval_taint(node.func.value, depth)
            if isinstance(node.func, ast.Attribute)
            else None
        )
        input_taints = [
            t for t in arg_taints + kw_taints + [receiver_taint] if t is not None
        ]

        # 3) 本文件内的本地函数：过程间分析
        local_name = None
        if isinstance(node.func, ast.Name):
            local_name = node.func.id
        elif isinstance(node.func, ast.Attribute):
            local_name = node.func.attr
        if local_name is not None:
            func_node = self.module.resolve_function(local_name, node.lineno)
            if func_node is not None:
                return self._call_local_function(
                    node, func_node, local_name, input_taints, depth
                )

        # 4) 内置/标准库里语义明确的字符串函数：按透传处理
        builtin_key = self._builtin_key(node.func)
        if builtin_key in src_rules.PASSTHROW_BUILTINS:
            merged = merge_taints(input_taints)
            if merged is None:
                return None
            if builtin_key == "str.format":
                detail = "str.format() 格式化拼接"
                kind = "format"
            elif builtin_key == "str.join":
                detail = "str.join() 拼接"
                kind = "concat"
            else:
                detail = f"经过内置函数 {builtin_key}，污点保留"
                kind = "call"
            return self._with_step(merged, node, kind, detail)

        # 5) SQLAlchemy text() 这类查询构造器：污点继续向外传播，交给真正的执行点
        if builtin_key == "text":
            merged = merge_taints(input_taints)
            if merged is None:
                return None
            return self._with_step(
                merged, node, "call", "text() 构造查询，污点继续传播"
            )

        # 6) 无法确认的复杂调用：保留已有来源，叠加 unknown 标记，
        #    这样 sink 处会降为待复核，但维护者仍能看到最初的外部输入
        if input_taints:
            dotted = src_rules.dotted_name(node.func) or "unknown-call"
            origin = self._origin(node, "unknown", f"unresolved:{dotted}")
            merged = merge_taints(input_taints)
            merged.origins.append(origin)
            merged.unknown = True
            merged.steps.append(
                self._step(node, "call", f"无法确认的调用 {dotted}，污点来源存疑")
            )
            return merged
        return None

    @staticmethod
    def _builtin_key(func: ast.AST) -> Optional[str]:
        if isinstance(func, ast.Name):
            return func.id
        if isinstance(func, ast.Attribute):
            # "...".format(...) 这类字面量方法调用
            if isinstance(func.value, ast.Constant):
                return "str." + func.attr
        chain = src_rules.attr_chain(func)
        if chain is not None and len(chain) >= 2:
            # str.join / x.join 都按 str.join 处理
            return "str." + chain[-1]
        return None

    def _call_local_function(
        self,
        node: ast.Call,
        func_node: ast.FunctionDef,
        name: str,
        input_taints: List[Taint],
        depth: int,
    ) -> Optional[Taint]:
        if depth >= MAX_CALL_DEPTH or name in self.active_funcs:
            # 递归过深或成环：无法继续确认整条链路，降级为待复核。
            # 保留已有来源，但 unknown=True 会让 sink 判定降为 review。
            if input_taints:
                merged = merge_taints(input_taints)
                origin = self._origin(node, "unknown", f"unresolved:{name}")
                merged.origins.append(origin)
                merged.unknown = True
                merged.steps.append(
                    self._step(node, "call", f"调用 {name} 过深/成环，无法继续分析")
                )
                return merged
            return None

        bound: Dict[str, Taint] = {}
        positional = func_node.args.posonlyargs + func_node.args.args
        all_taints = [t for t in (self.eval_taint(a, depth) for a in node.args) if t is not None]
        for index, arg in enumerate(positional):
            if index < len(node.args):
                taint = self.eval_taint(node.args[index], depth)
                if taint is not None:
                    bound[arg.arg] = taint
            # 缺省参数按干净处理
        # 关键字参数
        param_names = {a.arg for a in positional} | {
            a.arg for a in func_node.args.kwonlyargs
        }
        for keyword in node.keywords:
            if keyword.arg is None:
                continue  # **kwargs 展开：难以静态对应，忽略其映射
            taint = self.eval_taint(keyword.value, depth)
            if taint is not None and keyword.arg in param_names:
                bound[keyword.arg] = taint
        # *args / **kwargs 无法精确映射：把合并污点挂到剩余形参上
        has_star = any(isinstance(a, ast.Starred) for a in node.args)
        if has_star:
            merged = merge_taints(all_taints)
            if merged is not None:
                for arg in positional:
                    bound.setdefault(arg.arg, merged)

        child = BodyAnalyzer(
            module=self.module,
            parent=self,
            func_node=func_node,
            bound_params=bound,
            depth=depth + 1,
            active_funcs=self.active_funcs + (name,),
        )
        for stmt in func_node.body:
            child.visit(stmt)

        result = merge_taints(child.return_taints)
        if result is None:
            return None
        return self._with_step(
            result,
            node,
            "call",
            f"经本地函数 {name} 传递，返回值携带污点",
        )

    # ------------------------------------------------------------ sink 判定

    def _handle_sink(self, node: ast.Call, sink_name: str) -> None:
        if not node.args:
            return
        query_node = node.args[0]
        query_taint = self.eval_taint(query_node)

        # 参数绑定位置/关键字上的污点不算注入
        binding_taints = [self.eval_taint(a) for a in node.args[1:]]
        for keyword in node.keywords:
            if src_rules.is_binding_keyword(keyword) or keyword.arg is None:
                binding_taints.append(self.eval_taint(keyword.value))
        binding_taints = [t for t in binding_taints if t is not None]

        if query_taint is None:
            # 查询字符串是静态的；即使绑定参数带污点也是安全写法
            return

        has_binding = bool(binding_taints) or any(
            (src_rules.is_binding_keyword(k) and k.arg is not None)
            for k in node.keywords
        ) or len(node.args) > 1

        # 链路上任何一段无法确认（unknown），整体都不能算确定漏洞
        only_unknown = query_taint.unknown
        severity = SEVERITY_REVIEW if only_unknown else SEVERITY_VULNERABILITY
        rule = RULE_UNCONFIRMED_SQL if only_unknown else RULE_TAINTED_SQL

        if only_unknown:
            reason = (
                f"查询字符串经过无法确认的调用链进入 {sink_name}()，"
                "无法判定是否为外部输入，需要人工复核"
            )
        elif has_binding:
            reason = (
                f"虽然使用了参数绑定，但查询字符串本身在 {sink_name}() 之前已被外部输入拼接，"
                "绑定无法消除查询结构被篡改的风险"
            )
        else:
            reason = f"外部输入经动态拼接进入 {sink_name}() 的查询字符串，存在 SQL 注入风险"

        # 来源信息：优先取确认的外部输入来源；
        # 只有整条链路都无法确认时才使用 unknown 来源
        confirmed = [o for o in query_taint.origins if o.kind == "source"]
        if confirmed:
            origin = confirmed[0]
        elif query_taint.origins:
            origin = query_taint.origins[0]
        else:  # 理论上不会发生
            origin = self._origin(query_node, "unknown", "unknown")

        trace = list(query_taint.steps)
        trace.append(
            self._step(node, "sink", f"污点进入 SQL 执行点 {sink_name}()")
        )
        # 去掉完全重复的路径步骤，保持顺序
        deduped: List[TraceStep] = []
        seen = set()
        for step in trace:
            key = (step.lineno, step.kind, step.detail, step.code)
            if key not in seen:
                seen.add(key)
                deduped.append(step)

        finding = Finding(
            path=self.module.path,
            rule=rule,
            severity=severity,
            source_kind=origin.kind,
            source_name=origin.name,
            source_lineno=origin.lineno,
            sink_name=sink_name,
            sink_lineno=node.lineno,
            reason=reason,
            trace=deduped,
        )
        self.module.add_finding(finding)
