"""AST 污点分析引擎。

工作方式：
1. 只调用 ``ast.parse`` 把源码当数据解析，不 import、不 exec、不 compile 待检代码。
2. 为每个模块内函数建立上下文不敏感的摘要：参数先按“可能带污点”播种，
   再按语句顺序模拟赋值/拼接/格式化/参数传递，得到函数内部风险和返回值污点。
3. 函数调用点用摘要做参数流替换，让真实来源能跨函数继续传播；
   解析不了的调用一律降级为 POSSIBLE（可能风险），绝不伪装成确定结论。
"""

from __future__ import annotations

import ast
from collections import OrderedDict

from .models import (
    FileError,
    FileResult,
    Finding,
    Origin,
    SafeCall,
    STATE_POSSIBLE,
    STATE_TAINTED,
    Taint,
    TaintFlow,
    merge_taints,
)
from .rules import (
    DECISION_BASIS,
    SANITIZER_BY_ID,
    match_sanitizer,
    match_sink,
    match_source,
)

_PARAM_PREFIX = "param:"
_MAX_CALL_DEPTH = 20


class ModuleAnalyzer:
    def __init__(self, tree: ast.AST, display_name: str):
        self.tree = tree
        self.display_name = display_name
        # 模块内全部函数（含方法、嵌套函数），按名字索引；重名时先出现者生效
        self.func_index: dict[str, ast.FunctionDef] = {}
        self._collect_functions(tree)
        # 函数摘要缓存：函数名 -> 返回值污点（None 表示干净/无返回）
        self._summary_cache: dict[str, Taint | None] = {}
        self._findings: list[Finding] = []
        self._safe_calls: list[SafeCall] = []
        self._finding_keys: set[tuple] = set()
        self._safe_keys: set[tuple] = set()
        # 同一 sink 调用只做一次判定（嵌套实参已在外层调用前求值并产生过发现）
        self._checked_sinks: set[int] = set()

    # ------------------------------------------------------------ 入口

    def analyze(self) -> FileResult:
        result = FileResult(file=self.display_name)
        # 先按模块级语句顺序分析（视图函数等在遍历到 def 时惰性建立摘要，
        # 模块级调用在同一个模块环境中传播），再兜底分析未被触及的函数，
        # 保证“被框架直接调用、模块级没有调用点”的入口函数也能覆盖。
        module_env: dict[str, Taint | None] = {}
        for stmt in getattr(self.tree, "body", []):
            self._walk_stmt(stmt, module_env)
        for name, func in list(self.func_index.items()):
            if name not in self._summary_cache:
                self._analyze_function(func, frozenset())
        result.findings = self._merge_findings()
        result.safe_calls = self._merge_safe_calls()
        return result

    def _collect_functions(self, tree: ast.AST) -> None:
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                # 重名（别名/覆盖）只保留第一个，保证结果确定；该限制写入 README
                self.func_index.setdefault(node.name, node)

    # ------------------------------------------------------------ 函数摘要

    def _seed_params(self, func: ast.FunctionDef) -> dict[str, Taint | None]:
        env: dict[str, Taint | None] = {}
        args = func.args
        all_args = list(args.posonlyargs) + list(args.args) + list(args.kwonlyargs)
        for arg in all_args:
            env[arg.arg] = self._param_taint(arg.arg, func.lineno)
        if args.vararg:
            env[args.vararg.arg] = self._param_taint(args.vararg.arg, func.lineno)
        if args.kwarg:
            env[args.kwarg.arg] = self._param_taint(args.kwarg.arg, func.lineno)
        return env

    def _param_taint(self, name: str, line: int) -> Taint:
        origin = Origin(
            kind=_PARAM_PREFIX + name,
            label=f"函数参数 {name}（外部传入，来源不确定）",
            line=line,
        )
        return Taint(STATE_POSSIBLE, (TaintFlow(origin),))

    def _analyze_function(self, func: ast.FunctionDef, stack: frozenset) -> Taint | None:
        if func.name in self._summary_cache:
            return self._summary_cache[func.name]
        if func.name in stack or len(stack) >= _MAX_CALL_DEPTH:
            # 递归/过深调用无法在上下文不敏感摘要中稳定展开，按不可解析处理
            return None
        env = self._seed_params(func)
        return_taint: Taint | None = None
        for stmt in func.body:
            ret = self._walk_stmt(stmt, env, stack | {func.name})
            if ret is not None:
                return_taint = merge_taints(return_taint, ret)
        self._summary_cache[func.name] = return_taint
        return return_taint

    # ------------------------------------------------------------ 语句遍历

    def _walk_stmt(
        self,
        stmt: ast.AST,
        env: dict[str, Taint | None],
        stack: frozenset = frozenset(),
    ) -> Taint | None:
        """返回语句中的 return 污点（仅函数体内有意义）。"""
        method = "_stmt_" + type(stmt).__name__
        handler = getattr(self, method, None)
        if handler is None:
            return None
        return handler(stmt, env, stack)

    def _stmt_FunctionDef(self, stmt, env, stack):
        # 已在函数索引中，按需惰性分析；此处不内联展开
        if stmt.name not in self._summary_cache and stmt.name in self.func_index:
            self._analyze_function(stmt, stack)
        return None

    _stmt_AsyncFunctionDef = _stmt_FunctionDef

    def _stmt_ClassDef(self, stmt, env, stack):
        # 方法与嵌套函数已在函数索引中，由 analyze() 统一分析；
        # 类变量赋值语句不模拟（已知局限，见 README）
        return None

    def _stmt_Assign(self, stmt, env, stack):
        value_taint = self._eval(stmt.value, env, stack)
        for target in stmt.targets:
            self._store(target, value_taint, env, "变量赋值")
        return None

    def _stmt_AnnAssign(self, stmt, env, stack):
        if stmt.value is not None:
            value_taint = self._eval(stmt.value, env, stack)
            self._store(stmt.target, value_taint, env, "变量赋值")
        return None

    def _stmt_AugAssign(self, stmt, env, stack):
        right = self._eval(stmt.value, env, stack)
        left = env.get(stmt.target.id) if isinstance(stmt.target, ast.Name) else None
        merged = merge_taints(left, right)
        if merged is not None:
            merged = merged.with_step("增强赋值（+= 等）")
        if isinstance(stmt.target, ast.Name):
            self._store(stmt.target, merged, env, "增强赋值")
        # 其他增强赋值目标（属性/下标）不建模，局限见 README
        return None

    def _stmt_Expr(self, stmt, env, stack):
        self._eval(stmt.value, env, stack)
        return None

    def _stmt_Return(self, stmt, env, stack):
        if stmt.value is None:
            return None
        return self._eval(stmt.value, env, stack)

    def _stmt_If(self, stmt, env, stack):
        self._eval(stmt.test, env, stack)
        left = dict(env)
        right = dict(env)
        left_ret = self._walk_body(stmt.body, left, stack)
        right_ret = self._walk_body(stmt.orelse, right, stack)
        self._merge_branch(env, left, right)
        return merge_taints(left_ret, right_ret)

    def _stmt_For(self, stmt, env, stack):
        iter_taint = self._eval(stmt.iter, env, stack)
        loop_env = dict(env)
        element = iter_taint.with_step("for 循环逐项取值") if iter_taint else None
        self._store(stmt.target, element, loop_env, "循环变量")
        ret = self._walk_body(stmt.body, loop_env, stack)
        if stmt.orelse:
            ret = merge_taints(ret, self._walk_body(stmt.orelse, loop_env, stack))
        self._merge_branch(env, loop_env, {})
        return ret

    _stmt_AsyncFor = _stmt_For

    def _stmt_While(self, stmt, env, stack):
        self._eval(stmt.test, env, stack)
        body_env = dict(env)
        ret = self._walk_body(stmt.body, body_env, stack)  # 循环体只展开一次
        if stmt.orelse:
            ret = merge_taints(ret, self._walk_body(stmt.orelse, body_env, stack))
        self._merge_branch(env, body_env, {})
        return ret

    def _stmt_With(self, stmt, env, stack):
        for item in stmt.items:
            self._eval(item.context_expr, env, stack)
            if item.optional_vars is not None:
                self._store(item.optional_vars, None, env, "上下文管理器")
        return self._walk_body(stmt.body, env, stack)

    _stmt_AsyncWith = _stmt_With

    def _stmt_Try(self, stmt, env, stack):
        body_env = dict(env)
        ret = self._walk_body(stmt.body, body_env, stack)
        handler_env = dict(env)
        for handler in stmt.handlers:
            if handler.name:
                handler_env[handler.name] = None
            self._eval(handler.type, handler_env, stack) if handler.type else None
            ret = merge_taints(ret, self._walk_body(handler.body, handler_env, stack))
        if stmt.orelse:
            ret = merge_taints(ret, self._walk_body(stmt.orelse, body_env, stack))
        final_env = dict(env)
        ret = merge_taints(ret, self._walk_body(stmt.finalbody, final_env, stack))
        self._merge_branch(env, body_env, handler_env)
        return ret

    def _stmt_Raise(self, stmt, env, stack):
        if stmt.exc is not None:
            self._eval(stmt.exc, env, stack)
        return None

    def _stmt_Assert(self, stmt, env, stack):
        self._eval(stmt.test, env, stack)
        if stmt.msg is not None:
            self._eval(stmt.msg, env, stack)
        return None

    def _walk_body(self, body, env, stack) -> Taint | None:
        ret: Taint | None = None
        for stmt in body:
            r = self._walk_stmt(stmt, env, stack)
            if r is not None:
                ret = merge_taints(ret, r)
        return ret

    def _merge_branch(self, env: dict, left: dict, right: dict) -> None:
        for key in set(left) | set(right):
            env[key] = merge_taints(left.get(key), right.get(key))

    def _store(self, target: ast.AST, taint: Taint | None, env: dict, step: str) -> None:
        if isinstance(target, ast.Name):
            env[target.id] = taint.with_step(step) if taint else None
        elif isinstance(target, (ast.Tuple, ast.List)):
            for elt in target.elts:
                self._store(elt, taint, env, "序列解包赋值")
        elif isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name):
            # 容器写元素：保守地让容器本身保留污点
            base = merge_taints(env.get(target.value.id), taint)
            env[target.value.id] = base.with_step("写入字典/列表元素") if base else None
        elif isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name):
            base = merge_taints(env.get(target.value.id), taint)
            env[target.value.id] = base.with_step("写入对象属性") if base else None
        # 其他形态（复杂下标目标）不建模，README 已声明局限

    # ------------------------------------------------------------ 表达式求值

    def _eval(self, node: ast.AST | None, env: dict, stack: frozenset) -> Taint | None:
        if node is None:
            return None
        method = "_eval_" + type(node).__name__
        handler = getattr(self, method, None)
        if handler is None:
            return None  # 未建模的表达式形态按干净处理，局限写入 README
        return handler(node, env, stack)

    def _eval_Constant(self, node, env, stack):
        return None

    def _eval_Name(self, node, env, stack):
        return env.get(node.id)

    def _eval_JoinedStr(self, node, env, stack):
        # 保留每条流的 sanitizer_rule：已被 shlex.quote 处理的值再做 f-string
        # 格式化，安全引用语义不应被抹掉
        flows: list[TaintFlow] = []
        possible = False
        for v in node.values:
            if not isinstance(v, ast.FormattedValue):
                continue
            t = self._eval(v.value, env, stack)
            if t is None:
                continue
            possible = possible or t.state == STATE_POSSIBLE
            flows.extend(f.with_step("f-string 格式化") for f in t.flows)
        if not flows:
            return None
        return Taint(STATE_POSSIBLE if possible else STATE_TAINTED, tuple(flows))

    def _eval_FormattedValue(self, node, env, stack):
        return self._eval(node.value, env, stack)

    def _eval_BinOp(self, node, env, stack):
        left = self._eval(node.left, env, stack)
        right = self._eval(node.right, env, stack)
        merged = merge_taints(left, right)
        if merged is None:
            return None
        if isinstance(node.op, ast.Add):
            return merged.with_step("字符串拼接（+）")
        if isinstance(node.op, ast.Mod):
            return merged.with_step("格式化字符串（%）")
        if isinstance(node.op, ast.Mult):
            return merged.with_step("字符串重复（*）")
        return merged

    def _eval_UnaryOp(self, node, env, stack):
        return self._eval(node.operand, env, stack)

    def _eval_BoolOp(self, node, env, stack):
        return merge_taints(*(self._eval(v, env, stack) for v in node.values))

    def _eval_Compare(self, node, env, stack):
        parts = [node.left] + [c for c in node.comparators]
        return merge_taints(*(self._eval(p, env, stack) for p in parts))

    def _eval_IfExp(self, node, env, stack):
        self._eval(node.test, env, stack)
        return merge_taints(
            self._eval(node.body, env, stack),
            self._eval(node.orelse, env, stack),
        )

    def _eval_List(self, node, env, stack):
        return merge_taints(*(self._eval(e, env, stack) for e in node.elts))

    _eval_Tuple = _eval_List
    _eval_Set = _eval_List

    def _eval_Dict(self, node, env, stack):
        keys = merge_taints(*(self._eval(k, env, stack) for k in node.keys if k))
        values = merge_taints(*(self._eval(v, env, stack) for v in node.values))
        return merge_taints(keys, values)

    def _eval_Subscript(self, node, env, stack):
        base = self._eval(node.value, env, stack)
        self._eval(node.slice, env, stack)
        return base.with_step("下标取值") if base else None

    def _eval_Slice(self, node, env, stack):
        return merge_taints(
            self._eval(node.lower, env, stack),
            self._eval(node.upper, env, stack),
            self._eval(node.step, env, stack),
        )

    def _eval_Attribute(self, node, env, stack):
        base = self._eval(node.value, env, stack)
        return base.with_step(f"属性访问（.{node.attr}）") if base else None

    def _eval_Starred(self, node, env, stack):
        return self._eval(node.value, env, stack)

    def _eval_NamedExpr(self, node, env, stack):
        taint = self._eval(node.value, env, stack)
        self._store(node.target, taint, env, "海象运算符赋值")
        return taint

    def _eval_Await(self, node, env, stack):
        return self._eval(node.value, env, stack)

    def _eval_Yield(self, node, env, stack):
        return self._eval(node.value, env, stack) if node.value else None

    _eval_YieldFrom = _eval_Await

    def _eval_Lambda(self, node, env, stack):
        return None  # lambda 体不展开，局限写入 README

    def _eval_ListComp(self, node, env, stack):
        return self._eval_comprehension(node.elt, node.generators, env, stack)

    _eval_SetComp = _eval_ListComp
    _eval_GeneratorExp = _eval_ListComp

    def _eval_DictComp(self, node, env, stack):
        child = dict(env)
        for gen in node.generators:
            iter_taint = self._eval(gen.iter, child, stack)
            self._store(gen.target, iter_taint, child, "推导式迭代变量")
            for cond in gen.ifs:
                self._eval(cond, child, stack)
        return merge_taints(
            self._eval(node.key, child, stack),
            self._eval(node.value, child, stack),
        )

    def _eval_comprehension(self, elt, generators, env, stack) -> Taint | None:
        child = dict(env)
        for gen in generators:
            iter_taint = self._eval(gen.iter, child, stack)
            self._store(gen.target, iter_taint, child, "推导式迭代变量")
            for cond in gen.ifs:
                self._eval(cond, child, stack)
        taint = self._eval(elt, child, stack)
        return taint.with_step("列表/生成器推导式") if taint else None

    # ------------------------------------------------------------ 调用表达式

    def _eval_Call(self, node: ast.Call, env, stack) -> Taint | None:
        # 先求值函数表达式本身：覆盖 os.popen(cmd).read() 这类链式调用，
        # 接收者中的 sink/来源不会因为外层调用没有位置参数而被漏掉
        self._eval(node.func, env, stack)
        # 再求值全部实参，保证嵌套在参数里的危险调用、参数携带的污点都能被发现
        arg_taints = [self._eval(a, env, stack) for a in node.args]
        for kw in node.keywords:
            arg_taints.append(self._eval(kw.value, env, stack))
        args_taint = merge_taints(*arg_taints)

        # 1) 不可信输入来源（input()/request 取值）
        source = match_source(node)
        if source is not None:
            origin = Origin(source.kind, source.label, node.lineno)
            return Taint.from_origin(origin, f"读取不可信输入：{source.label}")

        # 2) 命令执行位置（在安全处理之前判断，避免把 sink 误当净化函数）
        sink = match_sink(node)
        if sink is not None:
            if id(node) not in self._checked_sinks:
                self._checked_sinks.add(id(node))
                self._check_sink(sink, node, env, stack)
            # sink 的返回值仍可被外层链式调用（如 os.popen(cmd).read()）继续使用，
            # 因此把命令参数的污点传播出去；不会再次产生发现（有 _checked_sinks 守卫）
            return args_taint

        # 3) 安全引用 / 数值转换
        sanitizer = match_sanitizer(node)
        if sanitizer is not None:
            if args_taint is None:
                return None
            return args_taint.with_step(f"安全处理：{sanitizer.label}").with_sanitizer(sanitizer.rule_id)

        # 4) 模块内可解析的函数：用摘要做参数流替换
        local_name = self._local_func_name(node)
        if local_name is not None:
            return self._eval_local_call(local_name, node, env, stack, args_taint)

        # 5) 无法解析的外部函数/方法：污点不切断，降级为可能风险
        if args_taint is None:
            return None
        label = self._call_label(node)
        return args_taint.downgraded().with_step(f"传入无法解析的函数 {label}（按可能风险处理）")

    def _local_func_name(self, node: ast.Call) -> str | None:
        if isinstance(node.func, ast.Name) and node.func.id in self.func_index:
            return node.func.id
        if isinstance(node.func, ast.Attribute) and node.func.attr in self.func_index:
            return node.func.attr
        return None

    def _call_label(self, node: ast.Call) -> str:
        if isinstance(node.func, ast.Name):
            return node.func.id + "()"
        if isinstance(node.func, ast.Attribute):
            return node.func.attr + "()"
        return "调用"

    def _eval_local_call(self, name, node, env, stack, args_taint) -> Taint | None:
        func = self.func_index[name]
        summary = self._analyze_function(func, stack)
        if summary is None:
            # 递归等场景：保守传播实参污点并降级
            if args_taint is None:
                return None
            return args_taint.downgraded().with_step(f"传入递归/未展开函数 {name}()（按可能风险处理）")

        arg_map = self._argument_map(func, node, env, stack)
        new_flows: list[TaintFlow] = []
        for flow in summary.flows:
            if flow.origin.kind.startswith(_PARAM_PREFIX):
                pname = flow.origin.kind[len(_PARAM_PREFIX):]
                replacement = arg_map.get(pname)
                if replacement is None:
                    continue  # 该参数位置传入的是常量/干净值，参数流消失
                for rf in replacement.flows:
                    steps = rf.steps + (f"作为参数传入 {name}()",) + flow.steps
                    rule = flow.sanitizer_rule or rf.sanitizer_rule
                    new_flows.append(TaintFlow(rf.origin, steps, rule))
            else:
                new_flows.append(flow)
        if not new_flows:
            return None
        # 数据跨越了函数边界：上下文不敏感摘要无法逐次调用确认，统一保守标为可能风险
        return Taint(STATE_POSSIBLE, tuple(new_flows)).with_step(f"使用 {name}() 的返回值")

    def _argument_map(self, func, node, env, stack) -> dict[str, Taint | None]:
        result: dict[str, Taint | None] = {}
        args = func.args
        names = [a.arg for a in args.posonlyargs] + [a.arg for a in args.args]
        for i, name in enumerate(names):
            if i < len(node.args):
                result[name] = self._eval(node.args[i], env, stack)
            else:
                result[name] = None
        # 关键字参数
        kwonly_names = {a.arg for a in args.kwonlyargs}
        for kw in node.keywords:
            if kw.arg is None:
                continue  # **kwargs 展开不建模
            result[kw.arg] = self._eval(kw.value, env, stack)
        # 多余位置参数并入 *args
        extra = [self._eval(a, env, stack) for a in node.args[len(names):]]
        if args.vararg:
            result[args.vararg.arg] = merge_taints(*extra)
        for kw_name in kwonly_names:
            result.setdefault(kw_name, None)
        return result

    # ------------------------------------------------------------ 危险调用判定

    def _command_node(self, call: ast.Call) -> ast.AST | None:
        if call.args:
            return call.args[0]
        for kw in call.keywords:
            if kw.arg in ("args", "cmd"):
                return kw.value
        return None

    def _check_sink(self, sink, node: ast.Call, env, stack) -> None:
        cmd_node = self._command_node(node)
        if cmd_node is None:
            self._add_safe(sink, node, DECISION_BASIS["D205"], "D205", "未提供命令参数")
            return
        cmd_taint = self._eval(cmd_node, env, stack)

        if sink.shell_true:
            self._check_shell_string(sink, node, cmd_node, cmd_taint)
        else:
            self._check_argv(sink, node, cmd_node, cmd_taint)

    def _check_shell_string(self, sink, node, cmd_node, cmd_taint) -> None:
        if cmd_taint is None:
            self._add_safe(sink, node, DECISION_BASIS["D205"], "D205", "命令只由字面量常量构成，未发现不可信数据流入")
            return
        unsafe = tuple(f for f in cmd_taint.flows if f.sanitizer_rule is None)
        safe = tuple(f for f in cmd_taint.flows if f.sanitizer_rule is not None)
        is_list = isinstance(cmd_node, (ast.List, ast.Tuple))
        if is_list:
            # shell=True 却给了列表：subprocess 会拼成字符串，仍是 shell 注入面
            if unsafe:
                self._emit_finding(sink, node, unsafe, cmd_taint.state, "D204",
                                   "shell=True 且参数数组会被拼接为 shell 字符串")
            else:
                self._add_safe(sink, node, DECISION_BASIS["D202"], "D202",
                               "数组元素均经过安全引用后再交给 shell=True")
            return
        if not unsafe:
            reason = f"不可信数据均经过 {self._sanitizer_names(safe)} 引用后才进入 shell 字符串"
            self._add_safe(sink, node, DECISION_BASIS["D202"], "D202", reason)
            return
        self._emit_finding(sink, node, unsafe, cmd_taint.state, "D201", None)

    def _check_argv(self, sink, node, cmd_node, cmd_taint) -> None:
        if isinstance(cmd_node, (ast.List, ast.Tuple)):
            if cmd_taint is None:
                self._add_safe(sink, node, DECISION_BASIS["D205"], "D205",
                               "参数数组只由字面量常量构成")
                return
            labels = ", ".join(OrderedDict.fromkeys(
                f.origin.label for f in cmd_taint.flows
            ))
            self._add_safe(
                sink, node, DECISION_BASIS["D203"], "D203",
                f"参数数组不经 shell 解释，带污点的元素（{labels}）只作为单个 argv 参数",
            )
            return
        # 动态 argv（变量/调用返回的列表）：不因含用户输入就报注入
        if cmd_taint is None:
            self._add_safe(sink, node, DECISION_BASIS["D205"], "D205",
                           "未发现不可信数据流入参数数组")
        else:
            self._add_safe(
                sink, node, DECISION_BASIS["D203"], "D203",
                "shell=False 且命令以参数形式传入，工具未发现 shell 注入面；"
                "若运行时该变量被改成字符串需人工确认",
            )

    def _sanitizer_names(self, flows) -> str:
        names = []
        for f in flows:
            rule = SANITIZER_BY_ID.get(f.sanitizer_rule)
            if rule is not None and rule.label not in names:
                names.append(rule.label)
        return "、".join(names)

    # ------------------------------------------------------------ 发现/安全记录

    def _emit_finding(self, sink, node, flows, state, decision_id, extra_note) -> None:
        severity = "high" if state == STATE_TAINTED else "medium"
        certainty = "确定" if state == STATE_TAINTED else "可能"
        origins: list[Origin] = []
        for f in flows:
            if f.origin not in origins:
                origins.append(f.origin)
        source_labels = list(OrderedDict.fromkeys(o.label for o in origins))
        source_lines = list(OrderedDict.fromkeys(o.line for o in origins))
        paths = []
        for f in flows:
            chain = [f"{f.origin.label}（第 {f.origin.line} 行）"] + list(f.steps) + [
                f"{sink.call_label}（第 {node.lineno} 行）"
            ]
            if chain not in paths:
                paths.append(chain)
        first = flows[0]
        propagation = f"{first.origin.label}（第 {first.origin.line} 行）"
        if first.steps:
            propagation += " → " + " → ".join(first.steps)
        propagation += f" → {sink.call_label}（第 {node.lineno} 行）"
        if extra_note:
            propagation += f"；{extra_note}"
        basis = sink.rule.basis + " 判定依据：" + DECISION_BASIS[decision_id]
        rule_id = f"{sink.rule.rule_id}/{decision_id}"
        finding = Finding(
            rule_id=rule_id,
            file=self.display_name,
            line=node.lineno,
            severity=severity,
            certainty=certainty,
            source_labels=source_labels,
            source_lines=source_lines,
            sink_label=sink.call_label,
            sink_rule=sink.rule.rule_id,
            sink_kind=sink.rule.kind,
            propagation=propagation,
            paths=paths,
            rule_basis=basis,
        )
        key = (finding.file, finding.line, finding.sink_rule)
        if key in self._finding_keys:
            # 同一调用点同一 sink 规则只保留一条，合并来源与路径
            for existing in self._findings:
                if (existing.file, existing.line, existing.sink_rule) == key:
                    self._merge_into(existing, finding)
                    break
            return
        self._finding_keys.add(key)
        self._findings.append(finding)

    def _merge_into(self, a: Finding, b: Finding) -> None:
        if b.severity == "high":
            a.severity = "high"
            a.certainty = "确定"
        for label in b.source_labels:
            if label not in a.source_labels:
                a.source_labels.append(label)
        for line in b.source_lines:
            if line not in a.source_lines:
                a.source_lines.append(line)
        for path in b.paths:
            if path not in a.paths:
                a.paths.append(path)

    def _add_safe(self, sink, node, basis_text, decision_id, reason) -> None:
        key = (self.display_name, node.lineno, sink.rule.rule_id, decision_id)
        if key in self._safe_keys:
            return
        self._safe_keys.add(key)
        self._safe_calls.append(
            SafeCall(
                file=self.display_name,
                line=node.lineno,
                sink_label=sink.call_label,
                sink_rule=sink.rule.rule_id,
                reason=reason,
                rule_id=f"{sink.rule.rule_id}/{decision_id}",
            )
        )

    def _merge_findings(self) -> list[Finding]:
        # 稳定排序：文件、行号、规则、来源标签
        return sorted(
            self._findings,
            key=lambda f: (f.file, f.line, f.sink_rule, "|".join(f.source_labels)),
        )

    def _merge_safe_calls(self) -> list[SafeCall]:
        return sorted(self._safe_calls, key=lambda s: (s.file, s.line, s.rule_id))


# ---------------------------------------------------------------- 模块级便捷函数

def analyze_source(source: str, display_name: str) -> FileResult:
    """解析并分析单个源码文本。语法错误转成 FileError，不抛出。"""
    result = FileResult(file=display_name)
    try:
        tree = ast.parse(source, filename=display_name)
    except SyntaxError as exc:
        result.errors.append(
            FileError(
                file=display_name,
                line=exc.lineno or 0,
                kind="syntax",
                message=f"语法错误：{exc.msg}（偏移 {exc.offset or '-'}）",
            )
        )
        return result
    except ValueError as exc:
        result.errors.append(
            FileError(file=display_name, line=0, kind="syntax", message=f"源码包含非法字节：{exc}")
        )
        return result
    try:
        return ModuleAnalyzer(tree, display_name).analyze()
    except Exception as exc:  # 单文件分析失败不影响其他文件
        result.errors.append(
            FileError(file=display_name, line=0, kind="analysis", message=f"分析器内部失败：{type(exc).__name__}: {exc}")
        )
        return result
