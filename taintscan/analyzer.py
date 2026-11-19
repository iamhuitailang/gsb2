"""AST-based, interprocedural taint analysis.

Nothing here imports or executes the analysed source: files are read as text
and parsed with :mod:`ast`.

Algorithm
---------
1. :class:`~taintscan.project.ProjectIndex` maps modules, functions, methods,
   classes and import aliases across the whole scan root.
2. A summary pass computes, per function, which *parameters* reach which sinks
   and which parameters/sources are returned.  Summaries are iterated to a
   fixed point, so a wrapper two calls deep is still summarised correctly.
3. A final pass seeds every function with real sources (``request.args`` ...)
   and instantiates callee summaries at call sites, producing findings with a
   traceable ``flow`` from source through functions to the sink.

Recursion terminates because hops are de-duplicated and paths are capped.
"""

from __future__ import annotations

import ast
import os
from dataclasses import dataclass, field
from typing import Iterable, Optional

from .discovery import discover_files
from .models import (
    PARAM_KIND,
    SOURCE_KIND,
    Finding,
    Hop,
    Origin,
    Taint,
    Warning,
    fingerprint,
    merge_taints,
)
from .parse_utils import ParsedFile, parse_file, snippet_for
from .project import ClassInfo, FunctionInfo, ModuleInfo, ProjectIndex
from .rules import (
    ALL_SINK_KINDS,
    LIST_FORM_COMMAND_SINKS,
    SINK_KEYWORD_NAMES,
    SINKS,
    SOURCE_CALLS,
    Sanitizer,
    Severity,
    SinkSpec,
    call_qualname,
    match_sanitizer,
    match_sink,
    match_source,
    rule_by_id,
    taint_args_for,
)

MAX_SUMMARY_ITERATIONS = 20

_TERMINATING_CALLS = frozenset(
    {"abort", "exit", "quit", "sys.exit", "os._exit", "self.fail"}
)
_SHELL_INTERPRETERS = frozenset(
    {"sh", "bash", "dash", "zsh", "ksh", "cmd", "powershell", "pwsh"}
)


# ---------------------------------------------------------------------------
# Summaries
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ParamSinkFlow:
    """Parameter ``param_index`` reaches a sink within this function."""

    param_index: int
    sink: str
    sink_kind: str
    rule_id: str
    severity: Severity
    file: str
    line: int
    column: int
    sink_code: str
    sink_function: str
    sanitized: frozenset[str] = frozenset()
    hops: tuple[Hop, ...] = ()


@dataclass(frozen=True)
class ParamReturnFlow:
    param_index: int
    sanitized: frozenset[str]
    hops: tuple[Hop, ...] = ()


@dataclass(frozen=True)
class SourceReturnFlow:
    origin: Origin
    sanitized: frozenset[str]
    hops: tuple[Hop, ...] = ()


@dataclass
class Summary:
    param_sinks: set[ParamSinkFlow] = field(default_factory=set)
    param_returns: set[ParamReturnFlow] = field(default_factory=set)
    source_returns: set[SourceReturnFlow] = field(default_factory=set)

    def merge(self, other: "Summary") -> bool:
        sizes = (
            len(self.param_sinks),
            len(self.param_returns),
            len(self.source_returns),
        )
        self.param_sinks |= other.param_sinks
        self.param_returns |= other.param_returns
        self.source_returns |= other.source_returns
        return sizes != (
            len(self.param_sinks),
            len(self.param_returns),
            len(self.source_returns),
        )


# ---------------------------------------------------------------------------
# Analysis frame for one function body
# ---------------------------------------------------------------------------


@dataclass
class Frame:
    unit: FunctionInfo
    module: ModuleInfo
    class_path: Optional[str] = None
    env: dict[str, frozenset[Taint]] = field(default_factory=dict)
    attrs: dict[str, frozenset[Taint]] = field(default_factory=dict)
    types: dict[str, str] = field(default_factory=dict)
    literals: dict[str, frozenset[str]] = field(default_factory=dict)
    imports: dict[str, str] = field(default_factory=dict)
    return_taints: set[Taint] = field(default_factory=set)
    param_sinks: set[ParamSinkFlow] = field(default_factory=set)
    param_returns: set[ParamReturnFlow] = field(default_factory=set)
    source_returns: set[SourceReturnFlow] = field(default_factory=set)
    raw_sinks: list["RawSink"] = field(default_factory=list)

    def snapshot(self) -> "Frame":
        clone = Frame(self.unit, self.module, self.class_path)
        clone.env = dict(self.env)
        clone.attrs = dict(self.attrs)
        clone.types = dict(self.types)
        clone.literals = dict(self.literals)
        clone.imports = dict(self.imports)
        return clone

    def absorb(self, other: "Frame", include_env: bool = True) -> None:
        if include_env:
            self.merge_env(other)
        self.merge_effects(other)

    def merge_env(self, other: "Frame") -> None:
        for name, taints in other.env.items():
            self.env[name] = self.env.get(name, frozenset()) | taints
        for name, taints in other.attrs.items():
            self.attrs[name] = self.attrs.get(name, frozenset()) | taints
        self.types.update(other.types)
        self.literals.update(other.literals)

    def replace_env(self, other: "Frame") -> None:
        """The other branch is the only one that continues; take its env."""

        self.env = dict(other.env)
        self.attrs = dict(other.attrs)
        self.types.update(other.types)
        self.literals.update(other.literals)

    def merge_effects(self, other: "Frame") -> None:
        """Merge findings/returns independent of the branch's env."""

        self.return_taints |= other.return_taints
        self.param_sinks |= other.param_sinks
        self.param_returns |= other.param_returns
        self.source_returns |= other.source_returns
        self.raw_sinks.extend(other.raw_sinks)

    def adopt(self, other: "Frame") -> None:
        """Take another branch's environment wholesale (it is the only path)."""

        self.replace_env(other)
        self.merge_effects(other)


@dataclass(frozen=True)
class SinkStep:
    label: str
    file: str
    line: int
    column: int
    code: str
    rule_id: str
    severity: Severity
    function: str

    def as_dict(self) -> dict:
        return {
            "kind": "sink",
            "label": self.label,
            "file": self.file,
            "line": self.line,
            "column": self.column,
            "function": self.function,
            "rule_id": self.rule_id,
        }


@dataclass(frozen=True)
class RawSink:
    taint: Taint
    step: SinkStep


class FunctionAnalyzer:
    """Analyse one function against a snapshot of callee summaries."""

    def __init__(
        self,
        index: ProjectIndex,
        summaries: dict[str, Summary],
        parsed: dict[str, ParsedFile],
        emit_findings: bool,
    ):
        self.index = index
        self.summaries = summaries
        self.parsed = parsed
        self.emit_findings = emit_findings

    # -- entry point ------------------------------------------------------

    def analyze(self, unit: FunctionInfo) -> tuple[list[Finding], Summary]:
        frame = Frame(unit, self.index.modules[unit.module], unit.class_path)
        if unit.kind in {"function", "method", "lambda"}:
            self._seed_params(frame, unit)

        expression: Optional[ast.AST] = None
        body: list[ast.stmt] = []
        if unit.kind == "module":
            body = self.index.modules[unit.module].parsed.tree.body
        elif unit.kind == "lambda":
            expression = unit.node.body  # type: ignore[attr-defined]
        else:
            body = unit.node.body  # type: ignore[attr-defined]

        for expr in self._definition_expressions(unit):
            self.eval_expr(expr, frame)
        for statement in body:
            self.visit_stmt(statement, frame)
        if expression is not None:
            frame.return_taints |= self.eval_expr(expression, frame)

        findings = self._materialise(frame) if self.emit_findings else []
        return findings, self._summarise(frame)

    def _seed_params(self, frame: Frame, unit: FunctionInfo) -> None:
        for param in unit.params:
            if param.index < unit.param_offset:
                continue
            origin = Origin(
                kind=PARAM_KIND,
                label=param.name,
                file=unit.file,
                line=unit.lineno,
                function=unit.display,
                param=param.name,
                param_index=param.index,
            )
            frame.env[param.name] = frozenset({Taint(origin)})

    @staticmethod
    def _definition_expressions(unit: FunctionInfo) -> Iterable[ast.expr]:
        node = unit.node
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return ()
        expressions: list[ast.expr] = list(node.decorator_list)
        args = node.args
        expressions.extend(args.defaults)
        expressions.extend(d for d in args.kw_defaults if d is not None)
        return expressions

    # -- summary / findings ----------------------------------------------

    @staticmethod
    def _summarise(frame: Frame) -> Summary:
        # Summaries are recomputed deterministically from the previous
        # snapshot, so recording them verbatim converges monotonically.
        summary = Summary(
            param_sinks=set(frame.param_sinks),
            param_returns=set(frame.param_returns),
            source_returns=set(frame.source_returns),
        )
        for taint in frame.return_taints:
            if taint.is_clean():
                continue
            if taint.origin.kind == PARAM_KIND:
                summary.param_returns.add(
                    ParamReturnFlow(
                        param_index=taint.origin.param_index or 0,
                        sanitized=taint.sanitized_for,
                        hops=taint.via,
                    )
                )
            else:
                summary.source_returns.add(
                    SourceReturnFlow(
                        origin=taint.origin,
                        sanitized=taint.sanitized_for,
                        hops=taint.via,
                    )
                )
        return summary

    def _materialise(self, frame: Frame) -> list[Finding]:
        findings: list[Finding] = []
        seen: set[str] = set()
        raw_sinks = sorted(
            frame.raw_sinks,
            key=lambda raw: (
                raw.step.file,
                raw.step.line,
                raw.step.column,
                raw.step.rule_id,
                _taint_sort_key(raw.taint),
            ),
        )
        for raw in raw_sinks:
            step = raw.step
            taint = raw.taint
            key = "\x1f".join(
                [
                    step.file,
                    str(step.line),
                    str(step.column),
                    step.rule_id,
                    taint.origin.signature(),
                    str(taint.origin.line),
                ]
            )
            if key in seen:
                continue
            seen.add(key)
            rule = rule_by_id(step.rule_id)
            functions = tuple(
                _dedupe(
                    [hop.function for hop in taint.via if hop.function]
                    + [step.function]
                )
            )
            fp = fingerprint(
                file=step.file,
                rule_id=step.rule_id,
                sink=step.label,
                sink_code=step.code,
                functions=functions,
                source_signature=taint.origin.signature(),
                source_code=taint.origin.code,
                source_file=taint.origin.file,
            )
            findings.append(
                Finding(
                    rule_id=step.rule_id,
                    rule_title=rule.title,
                    severity=step.severity,
                    message=rule.description,
                    advice=rule.advice,
                    file=step.file,
                    line=step.line,
                    column=step.column,
                    sink=step.label,
                    source=taint.origin.label,
                    source_file=taint.origin.file,
                    source_line=taint.origin.line,
                    flow=taint.flow(step.as_dict()),
                    fingerprint=fp,
                    flow_label=taint.flow_label(step.label),
                )
            )
        return findings

    # ------------------------------------------------------------------
    # Statements
    # ------------------------------------------------------------------

    def visit_stmts(self, statements: Iterable[ast.stmt], frame: Frame) -> None:
        for statement in statements:
            self.visit_stmt(statement, frame)

    def visit_stmt(self, statement: ast.stmt, frame: Frame) -> None:
        handler = getattr(self, "_visit_" + type(statement).__name__.lower(), None)
        if handler is not None:
            handler(statement, frame)
            return
        # Conservative fallback: evaluate expression children so a sink in an
        # unusual statement construct is still detected.
        for child in ast.iter_child_nodes(statement):
            if isinstance(child, ast.expr):
                self.eval_expr(child, frame)
            elif isinstance(child, ast.stmt):
                self.visit_stmt(child, frame)

    def _visit_assign(self, statement: ast.Assign, frame: Frame) -> None:
        value = self.eval_expr(statement.value, frame)
        for target in statement.targets:
            self._bind(target, value, frame)
            self._record_static(target, statement.value, frame)

    def _visit_annassign(self, statement: ast.AnnAssign, frame: Frame) -> None:
        if statement.value is None:
            return
        value = self.eval_expr(statement.value, frame)
        self._bind(statement.target, value, frame)
        self._record_static(statement.target, statement.value, frame)

    def _visit_augassign(self, statement: ast.AugAssign, frame: Frame) -> None:
        value = self.eval_expr(statement.value, frame)
        current = self.eval_expr(statement.target, frame)
        self._bind(
            statement.target, merge_taints(value, current), frame, merge=True
        )

    def _visit_expr(self, statement: ast.Expr, frame: Frame) -> None:
        self.eval_expr(statement.value, frame)

    def _visit_return(self, statement: ast.Return, frame: Frame) -> None:
        if statement.value is not None:
            frame.return_taints |= self.eval_expr(statement.value, frame)

    def _visit_raise(self, statement: ast.Raise, frame: Frame) -> None:
        if statement.exc is not None:
            self.eval_expr(statement.exc, frame)

    def _visit_if(self, statement: ast.If, frame: Frame) -> None:
        self.eval_expr(statement.test, frame)
        body_frame = frame.snapshot()
        else_frame = frame.snapshot()
        guard = self._recognise_guard(statement, frame)
        if guard is not None:
            expr, positive, kinds, label = guard
            if positive:
                # ``if x in ALLOWED: use(x)`` validates only the body.
                self._sanitize(expr, body_frame, kinds, label, statement)
            elif _block_terminates(statement.body):
                # ``if x not in ALLOWED: raise`` validates the fall-through.
                self._sanitize(expr, else_frame, kinds, label, statement)

        self.visit_stmts(statement.body, body_frame)
        self.visit_stmts(statement.orelse, else_frame)

        body_terminates = _block_terminates(statement.body)
        else_terminates = _block_terminates(statement.orelse)
        # Findings and return values from *both* branches always matter.
        frame.merge_effects(body_frame)
        frame.merge_effects(else_frame)
        # Only the surviving branch determines the post-state.  This is what
        # lets ``if x not in ALLOWED: raise`` (or ``is_relative_to``)
        # constrain ``x`` for subsequent statements.
        if body_terminates and not else_terminates:
            frame.replace_env(else_frame)
        elif else_terminates and not body_terminates:
            frame.replace_env(body_frame)
        elif not body_terminates and not else_terminates:
            frame.merge_env(body_frame)
            frame.merge_env(else_frame)

    def _visit_for(self, statement: ast.For, frame: Frame) -> None:
        iterable = self.eval_expr(statement.iter, frame)
        body_frame = frame.snapshot()
        self._bind(statement.target, iterable, body_frame)
        self.visit_stmts(statement.body, body_frame)
        self.visit_stmts(statement.orelse, body_frame)
        frame.absorb(body_frame)

    def _visit_asyncfor(self, statement: ast.AsyncFor, frame: Frame) -> None:
        self._visit_for(statement, frame)  # type: ignore[arg-type]

    def _visit_while(self, statement: ast.While, frame: Frame) -> None:
        self.eval_expr(statement.test, frame)
        body_frame = frame.snapshot()
        self.visit_stmts(statement.body, body_frame)
        self.visit_stmts(statement.orelse, body_frame)
        frame.absorb(body_frame)

    def _visit_with(self, statement: ast.With, frame: Frame) -> None:
        body_frame = frame.snapshot()
        for item in statement.items:
            value = self.eval_expr(item.context_expr, body_frame)
            if item.optional_vars is not None:
                self._bind(item.optional_vars, value, body_frame)
        self.visit_stmts(statement.body, body_frame)
        frame.absorb(body_frame)

    def _visit_asyncwith(self, statement: ast.AsyncWith, frame: Frame) -> None:
        self._visit_with(statement, frame)  # type: ignore[arg-type]

    def _visit_try(self, statement: ast.Try, frame: Frame) -> None:
        body_frame = frame.snapshot()
        self.visit_stmts(statement.body, body_frame)
        # A ``try`` body that always raises/returns contributes no env, but
        # its effects still count.
        keep_body_env = not _block_terminates(statement.body)
        self.visit_stmts(statement.orelse, body_frame)
        self.visit_stmts(statement.finalbody, body_frame)

        merged = frame.snapshot()
        merged.merge_effects(body_frame)
        if keep_body_env:
            merged.merge_env(body_frame)

        for handler in statement.handlers:
            # A handler receives no user-controlled payload; only its own
            # expressions can introduce sources.
            handler_frame = frame.snapshot()
            if handler.type is not None:
                self.eval_expr(handler.type, handler_frame)
            if handler.name:
                handler_frame.env.pop(handler.name, None)
            self.visit_stmts(handler.body, handler_frame)
            merged.merge_effects(handler_frame)
            merged.merge_env(handler_frame)

        frame.env = merged.env
        frame.attrs = merged.attrs
        frame.types.update(merged.types)
        frame.literals.update(merged.literals)
        frame.merge_effects(merged)

    # PEP 654 ``except*`` shares the ``try`` node shape.
    _visit_trystar = _visit_try  # type: ignore[assignment]

    def _visit_match(self, statement: ast.Match, frame: Frame) -> None:
        subject = self.eval_expr(statement.subject, frame)
        for case in statement.cases:
            case_frame = frame.snapshot()
            self._bind_pattern(case.pattern, subject, case_frame)
            if case.guard is not None:
                self.eval_expr(case.guard, case_frame)
            self.visit_stmts(case.body, case_frame)
            frame.absorb(case_frame)

    def _visit_functiondef(self, statement: ast.FunctionDef, frame: Frame) -> None:
        for expr in self._definition_expressions_for(statement):
            self.eval_expr(expr, frame)

    _visit_asyncfunctiondef = _visit_functiondef

    def _visit_classdef(self, statement: ast.ClassDef, frame: Frame) -> None:
        for expr in list(statement.decorator_list) + list(statement.bases):
            self.eval_expr(expr, frame)

    def _visit_import(self, statement: ast.Import, frame: Frame) -> None:
        for alias in statement.names:
            if alias.asname:
                frame.imports[alias.asname] = alias.name
            else:
                head = alias.name.split(".")[0]
                frame.imports[head] = head

    def _visit_importfrom(self, statement: ast.ImportFrom, frame: Frame) -> None:
        base = self._import_from_base(statement, frame)
        for alias in statement.names:
            if alias.name == "*":
                continue
            target = f"{base}.{alias.name}" if base else alias.name
            frame.imports[alias.asname or alias.name] = target

    def _visit_assert(self, statement: ast.Assert, frame: Frame) -> None:
        self.eval_expr(statement.test, frame)
        if statement.msg is not None:
            self.eval_expr(statement.msg, frame)

    @staticmethod
    def _definition_expressions_for(statement: ast.AST) -> Iterable[ast.expr]:
        expressions: list[ast.expr] = list(statement.decorator_list)  # type: ignore[attr-defined]
        args = statement.args  # type: ignore[attr-defined]
        expressions.extend(args.defaults)
        expressions.extend(d for d in args.kw_defaults if d is not None)
        return expressions

    def _import_from_base(self, statement: ast.ImportFrom, frame: Frame) -> str:
        if statement.level == 0:
            return statement.module or ""
        parts = frame.module.name.split(".")
        if not frame.module.is_package:
            parts = parts[:-1]
        if statement.level > 1:
            parts = parts[: max(len(parts) - (statement.level - 1), 0)]
        base = ".".join(parts)
        if statement.module:
            return f"{base}.{statement.module}" if base else statement.module
        return base

    def _bind_pattern(
        self, pattern: ast.pattern, taints: frozenset[Taint], frame: Frame
    ) -> None:
        if isinstance(pattern, ast.MatchAs):
            if pattern.name:
                self._bind_name(pattern.name, taints, frame, merge=True)
            if pattern.pattern is not None:
                self._bind_pattern(pattern.pattern, taints, frame)
        elif isinstance(pattern, ast.MatchStar):
            if pattern.name:
                self._bind_name(pattern.name, taints, frame, merge=True)
        elif isinstance(pattern, ast.MatchMapping):
            for name in pattern.rest or ():
                self._bind_name(name, taints, frame, merge=True)
            for sub in pattern.patterns:
                self._bind_pattern(sub, taints, frame)
        elif isinstance(pattern, (ast.MatchSequence, ast.MatchOr)):
            for sub in pattern.patterns:
                self._bind_pattern(sub, taints, frame)
        elif isinstance(pattern, ast.MatchClass):
            for sub in list(pattern.patterns) + list(pattern.kwd_patterns):
                self._bind_pattern(sub, taints, frame)

    # ------------------------------------------------------------------
    # Guards and allow-lists
    # ------------------------------------------------------------------

    def _recognise_guard(
        self, statement: ast.If, frame: Frame
    ) -> Optional[tuple[ast.expr, bool, frozenset[str], str]]:
        """Recognise validation patterns that neutralise taint.

        Returns ``(value_expr, positive, kinds, label)``.  ``positive`` means
        the If body is the trusted branch.  Two families are understood:

        * allow-list membership: ``if x in {"a", "b"}:`` and
          ``if x not in {"a", "b"}: raise``;
        * path containment: ``if not child.is_relative_to(root): raise``.
        """

        test = statement.test
        positive = True
        while isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not):
            positive = not positive
            test = test.operand

        if isinstance(test, ast.Call) and isinstance(test.func, ast.Attribute):
            if test.func.attr in {"is_relative_to", "is_relative"}:
                if not positive:
                    # ``if not child.is_relative_to(root): raise`` -> the
                    # fall-through value is constrained to the root.
                    return test.func.value, False, frozenset({"path"}), "path-containment"
                return None

        if not isinstance(test, ast.Compare) or len(test.ops) != 1:
            return None
        op = test.ops[0]
        # ``if root not in candidate.parents: raise`` is the Path-based
        # containment idiom; the surviving branch is inside ``root``.  The
        # value to constrain is the path variable itself (or the expression
        # that produced it).
        if (
            isinstance(op, ast.NotIn)
            and isinstance(test.comparators[0], ast.Attribute)
            and test.comparators[0].attr == "parents"
            and positive
        ):
            candidate = test.comparators[0].value
            if isinstance(candidate, ast.Name):
                return candidate, False, frozenset({"path"}), "path-containment"
            if isinstance(candidate, ast.Call) and isinstance(
                candidate.func, ast.Attribute
            ):
                return (
                    candidate.func.value,
                    False,
                    frozenset({"path"}),
                    "path-containment",
                )
            return candidate, False, frozenset({"path"}), "path-containment"
        if isinstance(op, ast.In):
            is_member = True
        elif isinstance(op, ast.NotIn):
            is_member = False
        else:
            return None
        if not isinstance(test.left, (ast.Name, ast.Attribute, ast.Subscript)):
            return None
        if self._constant_collection(test.comparators[0], frame) is None:
            return None
        return test.left, is_member == positive, ALL_SINK_KINDS, "allowlist"

    def _constant_collection(
        self, node: ast.expr, frame: Frame
    ) -> Optional[frozenset[str]]:
        collection = _literal_collection(node)
        if collection is not None:
            return collection
        if isinstance(node, ast.Name):
            if node.id in frame.literals:
                return frame.literals[node.id]
            return frame.module.literal_collections.get(node.id)
        return None

    def _sanitize(
        self,
        expr: ast.expr,
        frame: Frame,
        kinds: Iterable[str],
        label: str,
        at_node: ast.AST,
    ) -> None:
        kinds = frozenset(kinds)
        hop = Hop(
            kind="sanitize",
            label=label,
            file=frame.unit.file,
            line=getattr(at_node, "lineno", frame.unit.lineno),
            function=frame.unit.display,
        )
        taints = self.eval_expr(expr, frame)
        if not taints:
            return
        updated = {
            taint.sanitize(kinds).with_hop(hop)
            for taint in taints
            if not taint.is_clean()
        }
        self._set(expr, frozenset(t for t in updated if not t.is_clean()), frame)

    # ------------------------------------------------------------------
    # Binding
    # ------------------------------------------------------------------

    def _bind(
        self,
        target: ast.AST,
        taints: frozenset[Taint],
        frame: Frame,
        merge: bool = False,
    ) -> None:
        if isinstance(target, ast.Name):
            self._bind_name(target.id, taints, frame, merge=merge)
        elif isinstance(target, (ast.Tuple, ast.List)):
            for element in target.elts:
                self._bind(element, taints, frame, merge=merge)
        elif isinstance(target, ast.Starred):
            self._bind(target.value, taints, frame, merge=merge)
        elif isinstance(target, ast.Attribute):
            key = _key(target)
            if key is None:
                return
            if merge:
                frame.attrs[key] = frame.attrs.get(key, frozenset()) | taints
            elif taints:
                frame.attrs[key] = taints
            else:
                frame.attrs.pop(key, None)
        elif isinstance(target, ast.Subscript):
            if isinstance(target.value, ast.Name):
                # Index assignment can replace the element but not the whole
                # container; merging is the conservative choice.
                self._bind_name(target.value.id, taints, frame, merge=True)
            else:
                self._bind(target.value, taints, frame, merge=True)

    def _bind_name(
        self,
        name: str,
        taints: frozenset[Taint],
        frame: Frame,
        merge: bool = False,
    ) -> None:
        if merge:
            frame.env[name] = frame.env.get(name, frozenset()) | taints
        elif taints:
            frame.env[name] = taints
        else:
            # A plain assignment to a clean value clears earlier taint.
            frame.env.pop(name, None)

    def _set(self, target: ast.AST, taints: frozenset[Taint], frame: Frame) -> None:
        if isinstance(target, ast.Name):
            if taints:
                frame.env[target.id] = taints
            else:
                frame.env.pop(target.id, None)
        elif isinstance(target, ast.Attribute):
            key = _key(target)
            if key is None:
                return
            if taints:
                frame.attrs[key] = taints
            else:
                frame.attrs.pop(key, None)

    def _record_static(
        self, target: ast.AST, value: Optional[ast.expr], frame: Frame
    ) -> None:
        if not isinstance(target, ast.Name) or value is None:
            return
        collection = _literal_collection(value)
        if collection is not None:
            frame.literals[target.id] = collection
        if isinstance(value, ast.Call):
            resolved = self.resolve_callable(value.func, frame)
            if resolved is not None and resolved[0] == "class":
                frame.types[target.id] = resolved[1].path  # type: ignore[union-attr]

    # ------------------------------------------------------------------
    # Expressions
    # ------------------------------------------------------------------

    def eval_expr(self, node: Optional[ast.AST], frame: Frame) -> frozenset[Taint]:
        previous = getattr(self, "_frame", None)
        self._frame = frame
        try:
            return self._eval_expr(node, frame)
        finally:
            self._frame = previous

    def _eval_expr(self, node: Optional[ast.AST], frame: Frame) -> frozenset[Taint]:
        if node is None:
            return frozenset()
        if isinstance(node, ast.Constant):
            return frozenset()
        if isinstance(node, ast.Name):
            return frame.env.get(node.id, frozenset())
        if isinstance(node, ast.Attribute):
            return self._eval_attribute(node, frame)
        if isinstance(node, ast.Subscript):
            return self._eval_subscript(node, frame)
        if isinstance(node, ast.Call):
            return self._eval_call(node, frame)
        if isinstance(node, ast.BinOp):
            return merge_taints(
                self.eval_expr(node.left, frame), self.eval_expr(node.right, frame)
            )
        if isinstance(node, ast.BoolOp):
            return merge_taints(*(self.eval_expr(v, frame) for v in node.values))
        if isinstance(node, ast.Compare):
            return frozenset()
        if isinstance(node, ast.UnaryOp):
            if isinstance(node.op, ast.Not):
                return frozenset()
            return self.eval_expr(node.operand, frame)
        if isinstance(node, ast.IfExp):
            return merge_taints(
                self.eval_expr(node.body, frame), self.eval_expr(node.orelse, frame)
            )
        if isinstance(node, ast.JoinedStr):
            return merge_taints(*(self.eval_expr(v, frame) for v in node.values))
        if isinstance(node, ast.FormattedValue):
            return self.eval_expr(node.value, frame)
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            return merge_taints(*(self.eval_expr(e, frame) for e in node.elts))
        if isinstance(node, ast.Dict):
            groups = []
            for key, value in zip(node.keys, node.values):
                if key is not None:
                    groups.append(self.eval_expr(key, frame))
                groups.append(self.eval_expr(value, frame))
            return merge_taints(*groups)
        if isinstance(node, ast.Starred):
            return self.eval_expr(node.value, frame)
        if isinstance(node, ast.NamedExpr):
            taints = self.eval_expr(node.value, frame)
            self._bind(node.target, taints, frame)
            return taints
        if isinstance(node, ast.Await):
            return self.eval_expr(node.value, frame)
        if isinstance(node, ast.Lambda):
            return frozenset()
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp)):
            groups = [self.eval_expr(node.elt, frame)]
            for generator in node.generators:
                groups.append(self.eval_expr(generator.iter, frame))
                for condition in generator.ifs:
                    groups.append(self.eval_expr(condition, frame))
            return merge_taints(*groups)
        if isinstance(node, ast.DictComp):
            groups = [self.eval_expr(node.key, frame), self.eval_expr(node.value, frame)]
            for generator in node.generators:
                groups.append(self.eval_expr(generator.iter, frame))
                for condition in generator.ifs:
                    groups.append(self.eval_expr(condition, frame))
            return merge_taints(*groups)
        if isinstance(node, ast.Slice):
            return merge_taints(
                *(
                    self.eval_expr(part, frame)
                    for part in (node.lower, node.upper, node.step)
                    if part is not None
                )
            )
        if isinstance(node, (ast.Yield, ast.YieldFrom)):
            return self.eval_expr(node.value, frame)
        return merge_taints(
            *(
                self.eval_expr(child, frame)
                for child in ast.iter_child_nodes(node)
                if isinstance(child, ast.expr)
            )
        )

    def _eval_attribute(self, node: ast.Attribute, frame: Frame) -> frozenset[Taint]:
        matched = match_source(self._canonical(node, frame))
        if matched is not None:
            return frozenset({self._make_source(matched, node, frame)})
        key = _key(node)
        if key is not None and key in frame.attrs:
            return frame.attrs[key]
        receiver = self.eval_expr(node.value, frame)
        if receiver:
            return receiver
        if key is not None:
            return frame.env.get(key, frozenset())
        return frozenset()

    def _eval_subscript(self, node: ast.Subscript, frame: Frame) -> frozenset[Taint]:
        matched = match_source(self._canonical(node.value, frame))
        if matched is not None:
            return frozenset({self._make_source(matched, node.value, frame)})
        key = _key(node)
        if key is not None and key in frame.attrs:
            return frame.attrs[key]
        base = self.eval_expr(node.value, frame)
        index = self.eval_expr(node.slice, frame)
        if base:
            hop = Hop(
                kind="index",
                label="[]",
                file=frame.unit.file,
                line=getattr(node, "lineno", frame.unit.lineno),
                function=frame.unit.display,
            )
            base = frozenset(taint.with_hop(hop) for taint in base)
        return merge_taints(base, index)

    # ------------------------------------------------------------------
    # Calls
    # ------------------------------------------------------------------

    def _eval_call(self, node: ast.Call, frame: Frame) -> frozenset[Taint]:
        target = self.resolve_callable(node.func, frame)
        if target is not None:
            kind, payload = target
            if kind in {"function", "method"}:
                return self._call_function(node, payload, frame)  # type: ignore[arg-type]
            if kind == "class":
                return self._call_constructor(node, payload, frame)  # type: ignore[arg-type]

        canonical = self._canonical(node.func, frame)

        sanitizer = match_sanitizer(canonical)
        if sanitizer is not None:
            return self._apply_sanitizer(node, frame, sanitizer)

        matched_source = match_source(canonical)
        if matched_source is not None:
            label = (
                f"{matched_source}()"
                if canonical in SOURCE_CALLS
                else matched_source
            )
            return frozenset({self._make_source(label, node, frame)})

        sink = match_sink(canonical)
        if sink is None and isinstance(node.func, ast.Attribute):
            # Unknown receiver such as ``conn.cursor().execute(q)``: only the
            # unambiguous SQL cursor methods are recovered by name.
            if node.func.attr == "execute":
                sink = SINKS["cursor.execute"]
            elif node.func.attr == "executemany":
                sink = SINKS["cursor.executemany"]
        if sink is not None:
            return self._handle_sink(node, sink, frame)

        # Unknown callable: propagate taint from arguments, keywords and a
        # tainted receiver (``tainted.split(",")`` stays tainted).
        groups = [self.eval_expr(arg, frame) for arg in node.args]
        groups.extend(self.eval_expr(kw.value, frame) for kw in node.keywords)
        if isinstance(node.func, ast.Attribute):
            groups.append(self.eval_expr(node.func.value, frame))
        return merge_taints(*groups)

    def _call_constructor(
        self, node: ast.Call, klass: ClassInfo, frame: Frame
    ) -> frozenset[Taint]:
        init = klass.init
        if init is None:
            return merge_taints(*(self.eval_expr(arg, frame) for arg in node.args))
        return self._call_function(node, init, frame)

    def _call_function(
        self, node: ast.Call, function: FunctionInfo, frame: Frame
    ) -> frozenset[Taint]:
        summary = self.summaries.get(function.qualname)
        arguments = self._map_arguments(node, function, frame)
        if summary is None:
            # A local function we failed to summarise; be conservative.
            return merge_taints(*arguments.values())
        call_hop = Hop(
            kind="call",
            label=f"{function.display}()",
            file=frame.unit.file,
            line=getattr(node, "lineno", frame.unit.lineno),
            function=frame.unit.display,
        )
        result: set[Taint] = set()

        for flow in summary.param_sinks:
            for taint in _sorted_taints(arguments.get(flow.param_index, frozenset())):
                sanitized = taint.sanitized_for | flow.sanitized
                if flow.sink_kind in sanitized:
                    continue
                hops = _extend(taint.via, (call_hop,))
                hops = _extend(hops, flow.hops)
                if taint.origin.kind == PARAM_KIND:
                    frame.param_sinks.add(
                        ParamSinkFlow(
                            param_index=taint.origin.param_index or 0,
                            sink=flow.sink,
                            sink_kind=flow.sink_kind,
                            rule_id=flow.rule_id,
                            severity=flow.severity,
                            file=flow.file,
                            line=flow.line,
                            column=flow.column,
                            sink_code=flow.sink_code,
                            sink_function=flow.sink_function,
                            sanitized=sanitized,
                            hops=hops,
                        )
                    )
                else:
                    step = SinkStep(
                        label=flow.sink,
                        file=flow.file,
                        line=flow.line,
                        column=flow.column,
                        code=flow.sink_code,
                        rule_id=flow.rule_id,
                        severity=flow.severity,
                        function=flow.sink_function,
                    )
                    frame.raw_sinks.append(
                        RawSink(Taint(taint.origin, hops, sanitized), step)
                    )

        for flow in summary.param_returns:
            return_hop = _return_hop(function, node)
            for taint in _sorted_taints(arguments.get(flow.param_index, frozenset())):
                sanitized = taint.sanitized_for | flow.sanitized
                if ALL_SINK_KINDS <= sanitized:
                    continue
                result.add(
                    Taint(
                        taint.origin,
                        _extend(_extend(taint.via, (call_hop,)), flow.hops + (return_hop,)),
                        sanitized,
                    )
                )

        for flow in summary.source_returns:
            return_hop = _return_hop(function, node)
            if ALL_SINK_KINDS <= flow.sanitized:
                continue
            result.add(
                Taint(
                    flow.origin,
                    _extend(_extend(flow.hops, (call_hop,)), (return_hop,)),
                    flow.sanitized,
                )
            )
        return frozenset(result)
    def _map_arguments(
        self, node: ast.Call, function: FunctionInfo, frame: Frame
    ) -> dict[int, frozenset[Taint]]:
        mapping: dict[int, frozenset[Taint]] = {}
        positional = function.call_positional
        vararg = function.vararg_param
        kwarg = function.kwarg_param

        def add(index: int, taints: frozenset[Taint]) -> None:
            mapping[index] = mapping.get(index, frozenset()) | taints

        for index, arg in enumerate(node.args):
            if isinstance(arg, ast.Starred):
                taints = self.eval_expr(arg.value, frame)
                if taints:
                    for param in positional:
                        add(param.index, taints)
                    if vararg is not None:
                        add(vararg.index, taints)
                continue
            if index < len(positional):
                add(positional[index].index, self.eval_expr(arg, frame))
            elif vararg is not None:
                add(vararg.index, self.eval_expr(arg, frame))

        for keyword in node.keywords:
            taints = self.eval_expr(keyword.value, frame)
            if keyword.arg is None:
                if taints:
                    for param in function.params:
                        if param.vararg or param.kwarg:
                            continue
                        add(param.index, taints)
                    if kwarg is not None:
                        add(kwarg.index, taints)
                continue
            param = function.keyword_param(keyword.arg)
            if param is not None:
                add(param.index, taints)
            elif kwarg is not None:
                add(kwarg.index, taints)

        return {
            index: taints
            for index, taints in mapping.items()
            if index >= function.param_offset
        }

    def _apply_sanitizer(
        self, node: ast.Call, frame: Frame, sanitizer: Sanitizer
    ) -> frozenset[Taint]:
        merged = merge_taints(
            *(self.eval_expr(arg, frame) for arg in node.args),
            *(self.eval_expr(kw.value, frame) for kw in node.keywords),
        )
        if not merged:
            return frozenset()
        hop = Hop(
            kind="sanitize",
            label=sanitizer.qualname,
            file=frame.unit.file,
            line=getattr(node, "lineno", frame.unit.lineno),
            function=frame.unit.display,
        )
        updated = [taint.sanitize(sanitizer.kinds).with_hop(hop) for taint in merged]
        return frozenset(taint for taint in updated if not taint.is_clean())

    def _handle_sink(
        self, node: ast.Call, sink: SinkSpec, frame: Frame
    ) -> frozenset[Taint]:
        if sink.qualname == "yaml.load" and _uses_safe_yaml_loader(node, frame, self):
            # ``yaml.load(data, Loader=yaml.SafeLoader)`` constructs only
            # plain data, so it must not be reported.
            return merge_taints(*(self.eval_expr(arg, frame) for arg in node.args))
        candidates = self._sink_argument_taints(node, sink, frame)
        if candidates:
            sink_code = snippet_for(
                self.parsed.get(frame.unit.file), node, fallback=sink.qualname
            )
            step = SinkStep(
                label=sink.qualname,
                file=frame.unit.file,
                line=getattr(node, "lineno", 1),
                column=getattr(node, "col_offset", 0),
                code=sink_code,
                rule_id=sink.rule,
                severity=sink.severity,
                function=frame.unit.display,
            )
            for taint in _sorted_taints(candidates):
                if not taint.is_effective(sink.sink_kind):
                    continue
                if taint.origin.kind == PARAM_KIND:
                    frame.param_sinks.add(
                        ParamSinkFlow(
                            param_index=taint.origin.param_index or 0,
                            sink=sink.qualname,
                            sink_kind=sink.sink_kind,
                            rule_id=sink.rule,
                            severity=sink.severity,
                            file=step.file,
                            line=step.line,
                            column=step.column,
                            sink_code=sink_code,
                            sink_function=frame.unit.display,
                            sanitized=taint.sanitized_for,
                            hops=taint.via,
                        )
                    )
                else:
                    frame.raw_sinks.append(RawSink(taint, step))
        # A sink's result is not a trustworthy payload, but taint from its
        # arguments is not laundered either (``open(user_path).read()``).
        return merge_taints(*(self.eval_expr(arg, frame) for arg in node.args))

    def _sink_argument_taints(
        self, node: ast.Call, sink: SinkSpec, frame: Frame
    ) -> frozenset[Taint]:
        if sink.sink_kind == "command":
            return self._command_taints(node, sink, frame)
        groups: list[frozenset[Taint]] = []
        indexes = taint_args_for(sink)
        for index, arg in enumerate(node.args):
            if indexes is not None and index not in indexes:
                continue
            value = arg.value if isinstance(arg, ast.Starred) else arg
            groups.append(self.eval_expr(value, frame))
        allowed_keywords = SINK_KEYWORD_NAMES.get(sink.sink_kind, frozenset())
        for keyword in node.keywords:
            if keyword.arg is None or keyword.arg in allowed_keywords:
                groups.append(self.eval_expr(keyword.value, frame))
        return merge_taints(*groups)

    def _command_taints(
        self, node: ast.Call, sink: SinkSpec, frame: Frame
    ) -> frozenset[Taint]:
        first = _first_command_arg(node)
        if first is None:
            return frozenset()
        shell_enabled = _shell_enabled(node)
        list_form = isinstance(first, (ast.List, ast.Tuple))
        if list_form and not first.elts:
            return frozenset()

        if list_form and sink.qualname in LIST_FORM_COMMAND_SINKS and not shell_enabled:
            head = first.elts[0]
            # ``["bash", "-c", user_value]`` is still a shell invocation even
            # though shell=False; every argument after the interpreter counts.
            if _is_shell_interpreter(head):
                return merge_taints(
                    *(self.eval_expr(item, frame) for item in first.elts[1:])
                )
            # Otherwise argv[0] is the program itself and must be constant.
            return self.eval_expr(head, frame)
        if list_form:
            return merge_taints(*(self.eval_expr(item, frame) for item in first.elts))
        return self.eval_expr(first, frame)

    # ------------------------------------------------------------------
    # Name resolution
    # ------------------------------------------------------------------

    def _canonical(self, node: ast.AST, frame: Frame) -> Optional[str]:
        if isinstance(node, ast.Name):
            if node.id in frame.imports:
                return frame.imports[node.id]
            binding = frame.module.imports.get(node.id)
            if binding is not None:
                return binding.target
            return frame.module.namespace.get(node.id, node.id)
        if isinstance(node, ast.Attribute):
            base = self._canonical(node.value, frame)
            if base is None:
                return None
            return f"{base}.{node.attr}"
        return None

    def resolve_callable(
        self, func: ast.AST, frame: Frame
    ) -> Optional[tuple[str, object]]:
        if isinstance(func, ast.Name):
            path = self._canonical(func, frame)
            found = self._find_lexical(path, frame)
            if found is not None:
                if isinstance(found, ClassInfo):
                    return ("class", found)
                return ("function", found)
            return None
        if isinstance(func, ast.Attribute):
            receiver = self._receiver_class(func.value, frame)
            if receiver is not None:
                method = self.index.method_lookup(receiver, func.attr)
                if method is not None:
                    return ("method", method)
            path = self._canonical(func, frame)
            if path in self.index.methods_by_path:
                return ("method", self.index.methods_by_path[path])
            found = self._find_lexical(path, frame)
            if found is not None:
                if isinstance(found, ClassInfo):
                    return ("class", found)
                return ("function", found)
        return None

    def _find_lexical(
        self, path: Optional[str], frame: Frame
    ) -> Optional[object]:
        if not path:
            return None
        found = self.index.functions_by_path.get(path)
        if found is not None:
            return found
        klass = self.index.classes_by_path.get(path)
        if klass is not None:
            return klass
        # Nested definitions: walk outward from the current function path.
        if path in self.index.functions_by_path or path in self.index.classes_by_path:
            return None
        parts = frame.unit.path.split(".")
        for cut in range(len(parts) - 1, 0, -1):
            candidate = ".".join(parts[:cut] + [path])
            if candidate in self.index.functions_by_path:
                return self.index.functions_by_path[candidate]
            if candidate in self.index.classes_by_path:
                return self.index.classes_by_path[candidate]
        # Methods of the enclosing class referenced by bare name.
        if frame.class_path:
            method = self.index.method_lookup(frame.class_path, path)
            if method is not None:
                return method
        return None

    def _receiver_class(self, node: ast.expr, frame: Frame) -> Optional[str]:
        if isinstance(node, ast.Name):
            if node.id in {"self", "cls"} and frame.class_path:
                return frame.class_path
            if node.id in frame.types:
                return frame.types[node.id]
            path = self._canonical(node, frame)
            if path in self.index.classes_by_path:
                return path
            return None
        if isinstance(node, ast.Call):
            resolved = self.resolve_callable(node.func, frame)
            if resolved is not None and resolved[0] == "class":
                return resolved[1].path  # type: ignore[union-attr]
        return None

    def _make_source(self, label: str, node: ast.AST, frame: Frame) -> Taint:
        origin = Origin(
            kind=SOURCE_KIND,
            label=label,
            file=frame.unit.file,
            line=getattr(node, "lineno", frame.unit.lineno),
            function=frame.unit.display,
            code=snippet_for(self.parsed.get(frame.unit.file), node, fallback=label),
        )
        return Taint(origin)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _return_hop(function: FunctionInfo, node: ast.Call) -> Hop:
    return Hop(
        kind="return",
        label=f"{function.display} return",
        file=function.file,
        line=getattr(node, "lineno", function.lineno),
        function=function.display,
    )


def _extend(hops: tuple[Hop, ...], extra: Iterable[Hop]) -> tuple[Hop, ...]:
    result = list(hops)
    for hop in extra:
        if hop not in result:
            result.append(hop)
        if len(result) >= MAX_HOPS:
            break
    return tuple(result)


def _taint_sort_key(taint: Taint) -> tuple:
    """Stable ordering so reports do not depend on set hash order."""

    return (
        taint.origin.signature(),
        taint.origin.file,
        taint.origin.line,
        tuple((hop.kind, hop.label, hop.file, hop.line) for hop in taint.via),
        tuple(sorted(taint.sanitized_for)),
    )


def _sorted_taints(taints: Iterable[Taint]) -> list[Taint]:
    return sorted(taints, key=_taint_sort_key)


def _key(node: ast.AST) -> Optional[str]:
    try:
        return ast.unparse(node)
    except Exception:  # pragma: no cover - exotic nodes
        return None


def _literal_collection(node: ast.AST) -> Optional[frozenset[str]]:
    items: list[ast.AST] = []
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        items = list(node.elts)
    elif isinstance(node, ast.Dict):
        items = [key for key in node.keys if key is not None]
    else:
        return None
    values: set[str] = set()
    for item in items:
        if not isinstance(item, ast.Constant):
            return None
        values.add(str(item.value))
    return frozenset(values)


def _first_command_arg(node: ast.Call) -> Optional[ast.expr]:
    if node.args:
        return node.args[0]
    for keyword in node.keywords:
        if keyword.arg in {"args", "command", "cmd"}:
            return keyword.value
    return None


def _shell_enabled(node: ast.Call) -> bool:
    for keyword in node.keywords:
        if keyword.arg is None:
            return True
        if keyword.arg == "shell":
            if isinstance(keyword.value, ast.Constant):
                return bool(keyword.value.value)
            return True
    return False


def _is_shell_interpreter(node: ast.expr) -> bool:
    """``bash``/``sh`` as a literal, or a basename-style path to one."""

    value: Optional[str] = None
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        value = node.value
    elif isinstance(node, ast.Name):
        value = node.id
    if value is None:
        return False
    base = value.replace("\\", "/").rsplit("/", 1)[-1].lower()
    if base.endswith(".exe"):
        base = base[:-4]
    return base in _SHELL_INTERPRETERS


def _uses_safe_yaml_loader(
    node: ast.Call, frame: Frame, analyzer: "FunctionAnalyzer"
) -> bool:
    from .rules import SAFE_YAML_LOADERS

    for keyword in node.keywords:
        if keyword.arg == "Loader":
            target = keyword.value
            if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name):
                if target.value.id == "yaml":
                    return target.attr in {"SafeLoader", "CSafeLoader", "BaseLoader"}
                return False
            if isinstance(target, ast.Name):
                canonical = analyzer._canonical(target, frame)
                return canonical in SAFE_YAML_LOADERS
    return False


def _block_terminates(body: list[ast.stmt]) -> bool:
    if not body:
        return False
    last = body[-1]
    if isinstance(last, (ast.Raise, ast.Return, ast.Continue, ast.Break)):
        return True
    if isinstance(last, ast.Expr) and isinstance(last.value, ast.Call):
        if call_qualname(last.value.func) in _TERMINATING_CALLS:
            return True
    if isinstance(last, ast.If):
        return _block_terminates(last.body) and _block_terminates(last.orelse)
    return False


def _dedupe(items: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        if item and item not in seen:
            seen.add(item)
            result.append(item)
    return result


# ---------------------------------------------------------------------------
# Scanner
# ---------------------------------------------------------------------------


@dataclass
class ScanResult:
    root: str
    findings: list[Finding]
    warnings: list[Warning]
    files_scanned: int
    files_failed: int

    def to_dict(self) -> dict:
        return {
            "schema": "taintscan/report/1",
            "tool": "taintscan",
            "root": self.root,
            "summary": {
                "files_scanned": self.files_scanned,
                "files_failed": self.files_failed,
                "findings": len(self.findings),
                "warnings": len(self.warnings),
            },
            "findings": [finding.to_dict() for finding in self.findings],
            "warnings": [warning.to_dict() for warning in self.warnings],
        }


class Scanner:
    """Discover, parse and analyse Python files without executing them."""

    def __init__(self, root: str, excludes: Iterable[str] = ()):
        self.root = root
        self.excludes = tuple(excludes)

    def scan(self) -> ScanResult:
        root = os.path.abspath(self.root)
        files = discover_files(root, self.excludes)
        parsed_files: list[ParsedFile] = []
        warnings: list[Warning] = []
        failed = 0

        for item in files:
            parsed, warning = parse_file(item.path, item.relpath)
            if parsed is not None:
                parsed_files.append(parsed)
            if warning is not None:
                warnings.append(warning)
                failed += 1

        index = ProjectIndex.build(parsed_files)
        parsed_by_rel = {parsed.relpath: parsed for parsed in parsed_files}
        summaries: dict[str, Summary] = {
            unit.qualname: Summary() for unit in index.units
        }

        # Fixed point over summaries.  Every iteration re-analyses every unit
        # against the previous summary snapshot.
        for _ in range(MAX_SUMMARY_ITERATIONS):
            snapshot = summaries
            new_summaries: dict[str, Summary] = {}
            changed = False
            for unit in index.units:
                analyzer = FunctionAnalyzer(
                    index, snapshot, parsed_by_rel, emit_findings=False
                )
                _, summary = analyzer.analyze(unit)
                new_summaries[unit.qualname] = summary
                if snapshot.get(unit.qualname) != summary:
                    changed = True
            summaries = new_summaries
            if not changed:
                break

        # Final pass: emit findings, instantiating callee summaries.
        findings_by_key: dict[tuple, Finding] = {}
        for unit in index.units:
            analyzer = FunctionAnalyzer(
                index, summaries, parsed_by_rel, emit_findings=True
            )
            findings, _ = analyzer.analyze(unit)
            for finding in findings:
                findings_by_key.setdefault(
                    (finding.fingerprint, finding.file, finding.line, finding.rule_id),
                    finding,
                )

        findings = sorted(findings_by_key.values(), key=Finding.sort_key)
        warnings.sort(key=Warning.sort_key)
        return ScanResult(
            root=root,
            findings=findings,
            warnings=warnings,
            files_scanned=len(files) - failed,
            files_failed=failed,
        )
