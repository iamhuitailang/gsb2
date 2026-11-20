"""基于 AST 的污点分析核心。

分析方式：
- 模块级代码按语句顺序分析；
- 每个函数先做"汇总分析"（参数用符号标记，得出返回值依赖哪些参数），
  再按调用点的实际污点做"上下文分析"（报告函数内部的发现）；
- 未被调用的函数也会以无污点参数分析一遍，覆盖函数内部的污染源；
- 递归通过进行中集合截断，未知外部调用保守地标记为"不确定"。
"""
from __future__ import annotations

import ast
import re
from dataclasses import dataclass

from .model import EMPTY, Finding, ScopeVal, Step, Taint
from .patterns import (PROPAGATING_CALLS, PROPAGATING_METHODS, REQUEST_ATTRS,
                       SANITIZERS, SINK_METHODS, SOURCE_ATTRS, SOURCE_CALLS)
from .rules import RULES

MAX_PATH_STEPS = 12
# 查询文本中的参数占位符（? / %s / %(name)s / :name / $1）
PLACEHOLDER_RE = re.compile(r"\?|%s|%\([^)]+\)s|:[a-zA-Z_]\w*|\$\d+")


def dotted_name(node):
    """把 Name/Attribute 链还原成点分名字，如 os.environ、self.request.GET。"""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    if not parts:
        return None
    return ".".join(reversed(parts))


def is_request_source(dotted):
    """判断点分名字是否是 Web 请求参数（request.args / self.request.GET 等）。"""
    parts = dotted.split(".")
    for i in range(len(parts) - 1):
        if parts[i] in ("request", "req") and parts[i + 1] in REQUEST_ATTRS:
            return True
    return False


def contains_placeholder(expr):
    """查询表达式（含其静态字符串部分）中是否出现数据库参数占位符。

    注意 % 格式化左侧的 %s 是字符串格式化占位符，不是数据库参数占位符，
    需要排除。
    """
    found = False

    def visit(node):
        nonlocal found
        if found or node is None:
            return
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mod):
            visit(node.right)
            return
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if PLACEHOLDER_RE.search(node.value):
                found = True
            return
        for child in ast.iter_child_nodes(node):
            visit(child)

    visit(expr)
    return found


@dataclass
class FuncInfo:
    qname: str
    file: str
    node: ast.AST  # FunctionDef / AsyncFunctionDef
    params: list


class _Registrar(ast.NodeVisitor):
    """登记文件中的所有函数定义（含嵌套函数、方法）。"""

    def __init__(self, analyzer, relpath):
        self.a = analyzer
        self.file = relpath
        self.stack = []

    def visit_ClassDef(self, node):
        self.stack.append(node.name)
        self.generic_visit(node)
        self.stack.pop()

    def visit_FunctionDef(self, node):
        self._register(node)

    def visit_AsyncFunctionDef(self, node):
        self._register(node)

    def _register(self, node):
        qname = f"{self.file}:{'.'.join(self.stack + [node.name])}"
        args = node.args
        params = ([a.arg for a in getattr(args, "posonlyargs", [])]
                  + [a.arg for a in args.args]
                  + [a.arg for a in args.kwonlyargs])
        info = FuncInfo(qname, self.file, node, params)
        self.a.functions[qname] = info
        self.a.short_names.setdefault(node.name, []).append(qname)
        self.stack.append(node.name)
        for child in node.body:
            self.visit(child)
        self.stack.pop()


class Analyzer:
    """跨文件的分析状态：函数表、汇总缓存、发现与错误。"""

    def __init__(self):
        self.findings = []
        self.errors = []
        self.functions = {}        # qname -> FuncInfo
        self.short_names = {}      # 短名 -> [qname]
        self.trees = {}            # relpath -> AST
        self.file_lines = {}       # relpath -> [源代码行]
        self.module_scopes = {}    # relpath -> 模块级作用域
        self.summaries = {}        # qname -> 返回值污点（含符号参数依赖）
        self._summary_busy = set()
        self._context_results = {}  # (qname, 污点参数集合) -> 返回值污点
        self._context_busy = set()
        self._seen_findings = set()

    def add_file(self, relpath, text):
        """解析并登记一个文件；解析失败记入 errors，不当作安全跳过。"""
        try:
            tree = ast.parse(text, filename=relpath)
        except (SyntaxError, ValueError) as exc:
            self.errors.append({"file": relpath, "error": f"无法解析: {exc}"})
            return
        self.trees[relpath] = tree
        self.file_lines[relpath] = text.splitlines()
        _Registrar(self, relpath).visit(tree)

    def analyze(self):
        """全部文件登记完成后统一分析。"""
        for relpath, tree in self.trees.items():
            fa = FunctionAnalyzer(self, relpath, func=None)
            # 先挂上模块作用域（原地更新），让分析期间的函数调用能看到全局量
            self.module_scopes[relpath] = fa.scope
            fa.visit(tree)
        # 未被调用的函数也用无污点参数分析一遍，覆盖函数内部的污染源
        for qname, info in list(self.functions.items()):
            self.run_context(info, {})

    def get_summary(self, info):
        """函数的返回值污点汇总：steps 为内部污染源，param_deps 为参数依赖。"""
        if info.qname in self.summaries:
            return self.summaries[info.qname]
        if info.qname in self._summary_busy:
            return EMPTY  # 递归截断
        self._summary_busy.add(info.qname)
        try:
            fa = FunctionAnalyzer(self, info.file, func=info, summary_mode=True)
            fa.visit(info.node)
            taint = fa.return_taint or EMPTY
        finally:
            self._summary_busy.discard(info.qname)
        self.summaries[info.qname] = taint
        return taint

    def run_context(self, info, tainted_params):
        """以给定的污点参数分析函数体，报告其中的发现，返回返回值污点。"""
        key = (info.qname, frozenset(tainted_params))
        if key in self._context_results:
            return self._context_results[key]
        if key in self._context_busy:
            return None  # 递归截断
        self._context_busy.add(key)
        try:
            fa = FunctionAnalyzer(self, info.file, func=info,
                                  param_taints=tainted_params)
            fa.visit(info.node)
            result = fa.return_taint
        finally:
            self._context_busy.discard(key)
        self._context_results[key] = result
        return result

    def report_finding(self, rule, file, line, snippet, path):
        # 同一处问题（同规则、同文件、同行）只报一次，
        # 不会因为中间经过多个变量而重复报一串
        key = (rule, file, line)
        if key in self._seen_findings:
            return
        self._seen_findings.add(key)
        meta = RULES[rule]
        self.findings.append(Finding(
            rule=rule,
            severity=meta["severity"],
            confidence=meta["confidence"],
            file=file,
            line=line,
            snippet=snippet,
            message=meta["message"],
            path=path[-MAX_PATH_STEPS:],
        ))


class FunctionAnalyzer(ast.NodeVisitor):
    """单函数（或模块级）的按序污点分析。"""

    def __init__(self, analyzer, relpath, func=None, param_taints=None,
                 summary_mode=False):
        self.a = analyzer
        self.file = relpath
        self.func = func
        self.summary_mode = summary_mode
        self.scope = {}
        self.global_names = set()
        self.return_taint = None
        if func is not None:
            for i, name in enumerate(func.params):
                if param_taints and i in param_taints:
                    self.scope[name] = ScopeVal(param_taints[i], None)
                elif summary_mode:
                    self.scope[name] = ScopeVal(
                        Taint(param_deps={(func.qname, i)}), None)

    # ---------- 作用域 ----------

    def lookup(self, name):
        if name in self.scope:
            return self.scope[name]
        if self.func is not None:
            module_scope = self.a.module_scopes.get(self.file, {})
            if name in module_scope:
                return module_scope[name]
        return None

    @staticmethod
    def _merge_vals(vals):
        vals = [v for v in vals if v is not None]
        if not vals:
            return None
        tainted = [v for v in vals if v.taint.tainted]
        if not tainted:
            return vals[0]
        t = tainted[0].taint
        for v in tainted[1:]:
            t = t.merge(v.taint)
        if len(tainted) != len(vals):
            # 只有部分路径被污染：证据不足，标为不确定
            t = t.uncertain()
        return ScopeVal(t, tainted[0].expr)

    def merge_scopes(self, *scopes):
        merged = {}
        names = set()
        for sc in scopes:
            names.update(sc)
        for name in names:
            v = self._merge_vals([sc.get(name) for sc in scopes])
            if v is not None:
                merged[name] = v
        return merged

    # ---------- 语句 ----------

    def _func_def(self, node):
        if self.func is not None and node is self.func.node:
            for st in node.body:
                self.visit(st)
            return
        # 嵌套函数按需单独分析，这里只评估装饰器和默认参数
        for dec in node.decorator_list:
            self.taint_of(dec)
        defaults = list(node.args.defaults) + [d for d in node.args.kw_defaults if d]
        for d in defaults:
            self.taint_of(d)

    visit_FunctionDef = _func_def
    visit_AsyncFunctionDef = _func_def

    def visit_ClassDef(self, node):
        for dec in node.decorator_list:
            self.taint_of(dec)
        for base in node.bases:
            self.taint_of(base)
        # 类体（方法）按需分析

    def visit_Assign(self, node):
        t = self.taint_of(node.value)
        for target in node.targets:
            self.assign(target, t, node.value, node.lineno)

    def visit_AnnAssign(self, node):
        if node.value is not None:
            self.assign(node.target, self.taint_of(node.value), node.value,
                        node.lineno)

    def visit_AugAssign(self, node):
        t = self.taint_of(node.value)
        if isinstance(node.target, ast.Name):
            old = self.lookup(node.target.id)
            base = old.taint if old else EMPTY
            self.scope[node.target.id] = ScopeVal(base.merge(t), node.value)

    def assign(self, target, taint, expr, line):
        if isinstance(target, ast.Name):
            if taint.tainted:
                taint = taint.add_step(f"赋值给变量 '{target.id}'", self.file, line)
            sv = ScopeVal(taint, expr)
            if self.func is not None and target.id in self.global_names:
                self.a.module_scopes.setdefault(self.file, {})[target.id] = sv
            else:
                self.scope[target.id] = sv
        elif isinstance(target, ast.Starred):
            self.assign(target.value, taint, expr, line)
        elif isinstance(target, (ast.Tuple, ast.List)):
            if (isinstance(expr, (ast.Tuple, ast.List))
                    and len(expr.elts) == len(target.elts)):
                for t_elt, v_elt in zip(target.elts, expr.elts):
                    self.assign(t_elt, self.taint_of(v_elt), v_elt, line)
            else:
                for elt in target.elts:
                    self.assign(elt, taint, None, line)
        elif isinstance(target, ast.Subscript):
            # 容器被写入污点数据：整个容器视为被污染
            base = target.value
            while isinstance(base, ast.Subscript):
                base = base.value
            if isinstance(base, ast.Name):
                old = self.lookup(base.id)
                merged = (old.taint if old else EMPTY).merge(taint)
                self.scope[base.id] = ScopeVal(merged, old.expr if old else None)
        elif isinstance(target, ast.Attribute):
            dotted = dotted_name(target)
            if dotted:
                old = self.scope.get(dotted)
                merged = (old.taint if old else EMPTY).merge(taint)
                self.scope[dotted] = ScopeVal(merged, expr)

    def visit_Expr(self, node):
        self.taint_of(node.value)

    def visit_If(self, node):
        self.taint_of(node.test)
        saved = self.scope
        self.scope = dict(saved)
        for st in node.body:
            self.visit(st)
        body_scope = self.scope
        self.scope = dict(saved)
        for st in node.orelse:
            self.visit(st)
        self.scope = self.merge_scopes(body_scope, self.scope)

    def visit_For(self, node):
        iter_taint = self.taint_of(node.iter)
        saved = self.scope
        self.scope = dict(saved)
        self.assign(node.target, iter_taint, None, node.lineno)
        # 近似迭代两轮，让循环内污点达到稳定
        for _ in range(2):
            for st in node.body:
                self.visit(st)
        self.scope = self.merge_scopes(saved, self.scope)

    def visit_While(self, node):
        self.taint_of(node.test)
        saved = self.scope
        self.scope = dict(saved)
        for _ in range(2):
            for st in node.body:
                self.visit(st)
        self.scope = self.merge_scopes(saved, self.scope)

    def visit_Try(self, node):
        saved = self.scope
        self.scope = dict(saved)
        for st in node.body:
            self.visit(st)
        branches = [self.scope]
        for handler in node.handlers:
            self.scope = dict(saved)
            if handler.type:
                self.taint_of(handler.type)
            for st in handler.body:
                self.visit(st)
            branches.append(self.scope)
        self.scope = self.merge_scopes(*branches)
        for st in node.orelse:
            self.visit(st)
        for st in node.finalbody:
            self.visit(st)

    def visit_With(self, node):
        for item in node.items:
            t = self.taint_of(item.context_expr)
            if item.optional_vars is not None:
                self.assign(item.optional_vars, t, item.context_expr, node.lineno)
        for st in node.body:
            self.visit(st)

    def visit_Return(self, node):
        t = self.taint_of(node.value) if node.value is not None else EMPTY
        self.return_taint = t if self.return_taint is None \
            else self.return_taint.merge(t)

    def visit_Delete(self, node):
        for t in node.targets:
            if isinstance(t, ast.Name):
                self.scope.pop(t.id, None)

    def visit_Global(self, node):
        self.global_names.update(node.names)

    def visit_Assert(self, node):
        self.taint_of(node.test)
        if node.msg:
            self.taint_of(node.msg)

    def visit_Raise(self, node):
        if node.exc:
            self.taint_of(node.exc)

    # ---------- 表达式 ----------

    def taint_of(self, node):
        if node is None or isinstance(node, ast.Constant):
            return EMPTY
        if isinstance(node, ast.Name):
            sv = self.lookup(node.id)
            return sv.taint if sv else EMPTY
        if isinstance(node, ast.Attribute):
            dotted = dotted_name(node)
            if dotted:
                if dotted in SOURCE_ATTRS:
                    return Taint(steps=[Step(
                        f"外部输入来源: {SOURCE_ATTRS[dotted]}",
                        self.file, node.lineno)])
                if is_request_source(dotted):
                    return Taint(steps=[Step(
                        f"外部输入来源: Web 请求参数 {dotted}",
                        self.file, node.lineno)])
                sv = self.scope.get(dotted)
                if sv is not None:
                    return sv.taint
            return self.taint_of(node.value)
        if isinstance(node, ast.Subscript):
            return self.taint_of(node.value)
        if isinstance(node, ast.Starred):
            return self.taint_of(node.value)
        if isinstance(node, ast.Await):
            return self.taint_of(node.value)
        if isinstance(node, ast.UnaryOp):
            return self.taint_of(node.operand)
        if isinstance(node, ast.BinOp):
            t = self.taint_of(node.left).merge(self.taint_of(node.right))
            if t.tainted:
                if isinstance(node.op, ast.Add):
                    t = t.add_step("字符串拼接", self.file, node.lineno)
                elif isinstance(node.op, ast.Mod):
                    t = t.add_step("% 格式化", self.file, node.lineno)
            return t
        if isinstance(node, ast.JoinedStr):
            t = EMPTY
            for v in node.values:
                if isinstance(v, ast.FormattedValue):
                    t = t.merge(self.taint_of(v.value))
            if t.tainted:
                t = t.add_step("f-string 插值", self.file, node.lineno)
            return t
        if isinstance(node, ast.Call):
            return self.call_taint(node)
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            t = EMPTY
            for elt in node.elts:
                t = t.merge(self.taint_of(elt))
            return t
        if isinstance(node, ast.Dict):
            t = EMPTY
            for k in node.keys:
                if k is not None:
                    t = t.merge(self.taint_of(k))
            for v in node.values:
                t = t.merge(self.taint_of(v))
            return t
        if isinstance(node, ast.IfExp):
            body = self.taint_of(node.body)
            orelse = self.taint_of(node.orelse)
            t = body.merge(orelse)
            if body.tainted != orelse.tainted:
                t = t.uncertain()
            return t
        if isinstance(node, ast.BoolOp):
            t = EMPTY
            for v in node.values:
                t = t.merge(self.taint_of(v))
            return t
        if isinstance(node, ast.Compare):
            t = self.taint_of(node.left)
            for c in node.comparators:
                t = t.merge(self.taint_of(c))
            return t
        return EMPTY

    def call_taint(self, node):
        dotted = dotted_name(node.func)
        method = dotted.split(".")[-1] if dotted else ""
        arg_taints = [self.taint_of(a) for a in node.args]
        kw_taints = {}
        for kw in node.keywords:
            if kw.arg:
                kw_taints[kw.arg] = self.taint_of(kw.value)
            else:
                self.taint_of(kw.value)

        # 汇聚点：数据库查询执行
        if method in SINK_METHODS:
            self.check_sink(node, dotted or method, arg_taints)
            return EMPTY

        # 污染源
        if dotted in SOURCE_CALLS:
            return Taint(steps=[Step(
                f"外部输入来源: {SOURCE_CALLS[dotted]}", self.file, node.lineno)])
        if dotted and is_request_source(dotted):
            return Taint(steps=[Step(
                f"外部输入来源: Web 请求参数 {dotted}()", self.file, node.lineno)])

        # 净化：int()/float() 等转换后不再构成注入风险
        if dotted in SANITIZERS:
            return EMPTY

        # 确定性传播的调用/方法（str()、.format()、.join() 等）
        if dotted in PROPAGATING_CALLS or (
                method in PROPAGATING_METHODS
                and isinstance(node.func, ast.Attribute)):
            t = EMPTY
            if isinstance(node.func, ast.Attribute):
                t = t.merge(self.taint_of(node.func.value))
            for at in arg_taints:
                t = t.merge(at)
            for kt in kw_taints.values():
                t = t.merge(kt)
            if t.tainted and method in ("format", "join"):
                t = t.add_step(f"字符串方法 {method}()", self.file, node.lineno)
            return t

        # 项目内自定义函数：汇总 + 上下文分析
        infos = self.lookup_functions(dotted)
        if infos:
            result = EMPTY
            for info in infos:
                summary = self.a.get_summary(info)
                # 被调函数内部的污染源直接进入返回值
                internal = Taint(steps=summary.steps)
                if internal.tainted:
                    internal = internal.add_step(
                        f"从函数 {info.node.name}() 返回",
                        self.file, node.lineno)
                result = result.merge(internal)
                mapping = self.map_args(info, node, arg_taints, kw_taints)
                tainted_params = {}
                for i, t in mapping.items():
                    if t.tainted:
                        pname = (info.params[i] if i < len(info.params)
                                 else f"arg{i}")
                        tainted_params[i] = t.add_step(
                            f"作为参数 '{pname}' 传入函数 {info.node.name}()",
                            self.file, node.lineno)
                if tainted_params:
                    rt = self.a.run_context(info, tainted_params)
                    if rt is not None:
                        result = result.merge(rt)
                for (q, i) in summary.param_deps:
                    if q == info.qname and i in mapping and mapping[i].tainted:
                        result = result.merge(mapping[i].add_step(
                            f"从函数 {info.node.name}() 返回",
                            self.file, node.lineno))
            return result

        # 未知外部调用：保守地传播污点，但标为不确定
        t = EMPTY
        for at in arg_taints:
            t = t.merge(at)
        for kt in kw_taints.values():
            t = t.merge(kt)
        if t.tainted:
            t = t.add_step(
                f"经过无法分析的调用 {dotted or '<动态调用>'}()，无法确认结果",
                self.file, node.lineno).uncertain()
        return t

    def lookup_functions(self, dotted):
        if not dotted:
            return []
        short = dotted.split(".")[-1]
        return [self.a.functions[q]
                for q in self.a.short_names.get(short, [])]

    @staticmethod
    def map_args(info, node, arg_taints, kw_taints):
        """把调用实参映射到被调函数的参数下标。"""
        offset = 1 if (isinstance(node.func, ast.Attribute)
                       and info.params
                       and info.params[0] in ("self", "cls")) else 0
        mapping = {}
        for i, t in enumerate(arg_taints):
            pidx = i + offset
            if pidx < len(info.params):
                mapping[pidx] = t
        for name, t in kw_taints.items():
            if name in info.params:
                mapping[info.params.index(name)] = t
        return mapping

    # ---------- 汇聚点检查 ----------

    def resolve_expr(self, node, depth=0):
        """沿变量名回溯定义它的表达式，用于分析查询的构造方式。"""
        if depth > 3:
            return node
        if isinstance(node, ast.Name):
            sv = self.lookup(node.id)
            if sv is not None and sv.expr is not None:
                return self.resolve_expr(sv.expr, depth + 1)
        return node

    def check_sink(self, node, dotted, arg_taints):
        if not node.args:
            return
        taint = arg_taints[0]
        if not taint.tainted:
            # 污点数据只作为查询参数（第二及以后的位置参数）传入是安全写法
            return
        expr = self.resolve_expr(node.args[0])
        placeholders = contains_placeholder(expr)
        if not taint.certain:
            rule = "SQLI003"
        elif placeholders:
            rule = "SQLI002"
        else:
            rule = "SQLI001"
        lines = self.a.file_lines.get(self.file, [])
        snippet = (lines[node.lineno - 1].strip()
                   if 0 < node.lineno <= len(lines) else "")
        path = list(taint.steps) + [
            Step(f"到达数据库执行 {dotted}()", self.file, node.lineno)]
        self.a.report_finding(rule, self.file, node.lineno, snippet, path)
