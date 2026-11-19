"""Project-wide symbol index built from parsed modules (no code execution)."""

from __future__ import annotations

import ast
from dataclasses import dataclass, field
from typing import Iterable, Optional

from .parse_utils import ParsedFile


@dataclass(frozen=True)
class Param:
    name: str
    index: int
    keyword_only: bool = False
    vararg: bool = False
    kwarg: bool = False


@dataclass
class FunctionInfo:
    qualname: str  # unique key: "<module>:<display>"
    display: str  # e.g. "make_query" or "Handler.run"
    path: str  # canonical dotted path, e.g. "pkg.mod.make_query"
    node: ast.AST  # FunctionDef / AsyncFunctionDef / Lambda / Module
    module: str
    file: str
    lineno: int
    params: list[Param] = field(default_factory=list)
    param_offset: int = 0  # 1 for methods with an implicit receiver
    class_path: Optional[str] = None
    kind: str = "function"  # function | method | lambda | module
    children: dict[str, list["FunctionInfo"]] = field(default_factory=dict)
    is_staticmethod: bool = False

    @property
    def call_positional(self) -> list[Param]:
        """Positional params accepting caller arguments (receiver removed)."""

        positional = [p for p in self.params if not p.keyword_only and not p.vararg and not p.kwarg]
        return positional[self.param_offset :]

    def keyword_param(self, name: str) -> Optional[Param]:
        for param in self.params:
            if param.name == name and not param.vararg and not param.kwarg:
                return param
        return None

    @property
    def vararg_param(self) -> Optional[Param]:
        for param in self.params:
            if param.vararg:
                return param
        return None

    @property
    def kwarg_param(self) -> Optional[Param]:
        for param in self.params:
            if param.kwarg:
                return param
        return None


@dataclass
class ClassInfo:
    path: str
    name: str
    module: str
    node: ast.ClassDef
    methods: dict[str, FunctionInfo] = field(default_factory=dict)
    base_names: list[ast.expr] = field(default_factory=list)
    base_paths: list[str] = field(default_factory=list)

    @property
    def init(self) -> Optional[FunctionInfo]:
        return self.methods.get("__init__")


@dataclass
class ImportBinding:
    target: str  # canonical dotted path
    kind: str  # "module" or "symbol"


@dataclass
class ModuleInfo:
    name: str
    relpath: str
    parsed: ParsedFile
    is_package: bool = False
    functions: dict[str, FunctionInfo] = field(default_factory=dict)
    classes: dict[str, ClassInfo] = field(default_factory=dict)
    imports: dict[str, ImportBinding] = field(default_factory=dict)
    namespace: dict[str, str] = field(default_factory=dict)
    literal_collections: dict[str, frozenset[str]] = field(default_factory=dict)
    unit: Optional[FunctionInfo] = None


def module_name_for(relpath: str) -> tuple[str, bool]:
    """Map a repository-relative path to a dotted module name."""

    if relpath.endswith(".py"):
        relpath = relpath[:-3]
    parts = relpath.split("/")
    is_package = bool(parts) and parts[-1] == "__init__"
    if is_package:
        parts = parts[:-1]
    return ".".join(parts) or "__root__", is_package


def _decorator_name(node: ast.AST) -> Optional[str]:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _params(node: ast.arguments) -> list[Param]:
    params: list[Param] = []
    index = 0
    for arg in list(node.posonlyargs) + list(node.args):
        params.append(Param(arg.arg, index))
        index += 1
    if node.vararg is not None:
        params.append(Param(node.vararg.arg, index, vararg=True))
        index += 1
    for arg in node.kwonlyargs:
        params.append(Param(arg.arg, index, keyword_only=True))
        index += 1
    if node.kwarg is not None:
        params.append(Param(node.kwarg.arg, index, kwarg=True))
    return params


class _Collector:
    """Collect functions/classes, including definitions nested in blocks."""

    def __init__(self, module: ModuleInfo):
        self.module = module

    def collect(self) -> None:
        self._statements(
            self.module.parsed.tree.body,
            parent=None,
            klass=None,
            parent_path=self.module.name,
            class_path=None,
        )

    def _statements(
        self,
        statements: Iterable[ast.stmt],
        parent: Optional[FunctionInfo],
        klass: Optional[ClassInfo],
        parent_path: str,
        class_path: Optional[str],
    ) -> None:
        for statement in statements:
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._function(statement, parent, klass, parent_path, class_path)
                continue
            if isinstance(statement, ast.ClassDef):
                self._class(statement, parent, parent_path, class_path)
                continue
            if isinstance(statement, (ast.Assign, ast.AnnAssign)):
                self._assigned_lambda(
                    statement, parent, klass, parent_path, class_path
                )
            # Recurse into compound statement bodies (if/for/with/try/match)
            # without entering nested function bodies, which are registered
            # by ``_function`` itself.
            for field in ("body", "orelse", "finalbody"):
                value = getattr(statement, field, None)
                if (
                    isinstance(value, list)
                    and value
                    and isinstance(value[0], ast.stmt)
                ):
                    self._statements(value, parent, klass, parent_path, class_path)
            for handler in getattr(statement, "handlers", ()) or ():
                self._statements(
                    handler.body, parent, klass, parent_path, class_path
                )
            for case in getattr(statement, "cases", ()) or ():
                self._statements(
                    case.body, parent, klass, parent_path, class_path
                )

    def _function(
        self,
        node: ast.AST,
        parent: Optional[FunctionInfo],
        klass: Optional[ClassInfo],
        parent_path: str,
        class_path: Optional[str],
    ) -> None:
        name = node.name  # type: ignore[attr-defined]
        decorators = {_decorator_name(d) for d in node.decorator_list}  # type: ignore[attr-defined]
        if klass is not None:
            display = f"{klass.name}.{name}"
        elif parent is not None:
            display = f"{parent.display}.{name}"
        else:
            display = name
        path = f"{parent_path}.{name}"
        offset = 0
        kind = "function"
        if klass is not None:
            kind = "method"
            if "staticmethod" not in decorators:
                offset = 1
        info = FunctionInfo(
            qualname=f"{self.module.name}:{display}",
            display=display,
            path=path,
            node=node,
            module=self.module.name,
            file=self.module.relpath,
            lineno=getattr(node, "lineno", 1),
            params=_params(node.args),  # type: ignore[attr-defined]
            param_offset=offset,
            class_path=class_path,
            kind=kind,
            is_staticmethod="staticmethod" in decorators,
        )
        if klass is not None:
            klass.methods.setdefault(name, info)
            self.module.namespace.setdefault(name, info.path)
        elif parent is not None:
            parent.children.setdefault(name, []).append(info)
            self.module.namespace.setdefault(name, info.path)
        else:
            self.module.functions.setdefault(name, info)
            self.module.namespace[name] = info.path
        self._statements(
            node.body, info, None, path, class_path  # type: ignore[attr-defined]
        )

    def _class(
        self,
        node: ast.ClassDef,
        parent: Optional[FunctionInfo],
        parent_path: str,
        class_path: Optional[str],
    ) -> None:
        path = f"{parent_path}.{node.name}"
        info = ClassInfo(
            path=path,
            name=node.name,
            module=self.module.name,
            node=node,
            base_names=list(node.bases),
        )
        if parent is None:
            self.module.classes.setdefault(node.name, info)
            self.module.namespace[node.name] = path
        self._statements(node.body, parent, info, path, path)

    def _assigned_lambda(
        self,
        statement: ast.Assign | ast.AnnAssign,
        parent: Optional[FunctionInfo],
        klass: Optional[ClassInfo],
        parent_path: str,
        class_path: Optional[str],
    ) -> None:
        value = statement.value
        if not isinstance(value, ast.Lambda):
            return
        targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
        name = next(
            (target.id for target in targets if isinstance(target, ast.Name)),
            f"<lambda>@{getattr(statement, 'lineno', 0)}",
        )
        display = f"{parent.display}.{name}" if parent else name
        path = f"{parent_path}.{name}"
        info = FunctionInfo(
            qualname=f"{self.module.name}:{display}",
            display=display,
            path=path,
            node=value,
            module=self.module.name,
            file=self.module.relpath,
            lineno=getattr(value, "lineno", 1),
            params=_params(value.args),
            param_offset=0,
            class_path=class_path,
            kind="lambda",
        )
        if parent is not None:
            parent.children.setdefault(name, []).append(info)
        else:
            self.module.functions.setdefault(name, info)
            self.module.namespace[name] = path


class ProjectIndex:
    def __init__(self) -> None:
        self.modules: dict[str, ModuleInfo] = {}
        self.functions_by_path: dict[str, FunctionInfo] = {}
        self.methods_by_path: dict[str, FunctionInfo] = {}
        self.classes_by_path: dict[str, ClassInfo] = {}
        self.by_qualname: dict[str, FunctionInfo] = {}
        self.units: list[FunctionInfo] = []

    @classmethod
    def build(cls, parsed_files: Iterable[ParsedFile]) -> "ProjectIndex":
        index = cls()
        for parsed in parsed_files:
            name, is_package = module_name_for(parsed.relpath)
            if name in index.modules:
                suffix = 2
                while f"{name}#{suffix}" in index.modules:
                    suffix += 1
                name = f"{name}#{suffix}"
            index.modules[name] = ModuleInfo(
                name=name,
                relpath=parsed.relpath,
                parsed=parsed,
                is_package=is_package,
            )

        for module in index.modules.values():
            _Collector(module).collect()
            module.literal_collections = _module_literal_collections(module.parsed.tree)

        for module in index.modules.values():
            _collect_imports(module)
            for name, binding in module.imports.items():
                module.namespace.setdefault(name, binding.target)

        for module in index.modules.values():
            for function in module.functions.values():
                index._register_function(function)
            for klass in module.classes.values():
                index._register_class(klass)
            module.unit = FunctionInfo(
                qualname=f"{module.name}:<module>",
                display="<module>",
                path=module.name,
                node=module.parsed.tree,
                module=module.name,
                file=module.relpath,
                lineno=1,
                kind="module",
            )
            index.by_qualname[module.unit.qualname] = module.unit
            index.units.append(module.unit)

        _resolve_class_bases(index)
        index.units.sort(key=lambda unit: unit.qualname)
        return index

    def _register_function(self, function: FunctionInfo) -> None:
        self.functions_by_path.setdefault(function.path, function)
        if function.kind == "method":
            self.methods_by_path.setdefault(function.path, function)
        self.by_qualname.setdefault(function.qualname, function)
        self.units.append(function)
        for children in function.children.values():
            for child in children:
                self._register_function(child)

    def _register_class(self, klass: ClassInfo) -> None:
        self.classes_by_path[klass.path] = klass
        for method in klass.methods.values():
            # Registering through ``_register_function`` also picks up nested
            # functions defined inside the method.
            self._register_function(method)

    def canonical(self, module: str, node: ast.AST) -> Optional[str]:
        """Resolve a dotted expression to a canonical name using imports."""

        if isinstance(node, ast.Name):
            info = self.modules.get(module)
            if info is not None:
                binding = info.imports.get(node.id)
                if binding is not None:
                    return binding.target
                target = info.namespace.get(node.id)
                if target is not None:
                    return target
            return node.id
        if isinstance(node, ast.Attribute):
            base = self.canonical(module, node.value)
            if base is None:
                return None
            return f"{base}.{node.attr}"
        return None

    def find_function(self, path: str) -> Optional[FunctionInfo]:
        return self.functions_by_path.get(path) or self.methods_by_path.get(path)

    def find_class(self, path: str) -> Optional[ClassInfo]:
        return self.classes_by_path.get(path)

    def method_lookup(
        self, class_path: str, method: str, _seen: Optional[set[str]] = None
    ) -> Optional[FunctionInfo]:
        seen = _seen if _seen is not None else set()
        if class_path in seen:
            return None
        seen.add(class_path)
        klass = self.classes_by_path.get(class_path)
        if klass is None:
            return None
        found = klass.methods.get(method)
        if found is not None:
            return found
        for base in klass.base_paths:
            found = self.method_lookup(base, method, seen)
            if found is not None:
                return found
        return None


def _module_literal_collections(tree: ast.Module) -> dict[str, frozenset[str]]:
    """Module-level ``NAME = {constant, ...}`` collections (allow-lists)."""

    result: dict[str, frozenset[str]] = {}
    for statement in tree.body:
        if not isinstance(statement, ast.Assign) or len(statement.targets) != 1:
            continue
        target = statement.targets[0]
        if not isinstance(target, ast.Name):
            continue
        values = _constant_collection(statement.value)
        if values is not None:
            result[target.id] = values
    return result


def _constant_collection(node: ast.AST) -> Optional[frozenset[str]]:
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


def _collect_imports(module: ModuleInfo) -> None:
    for statement in module.parsed.tree.body:
        if isinstance(statement, ast.Import):
            for alias in statement.names:
                if alias.asname:
                    module.imports[alias.asname] = ImportBinding(alias.name, "module")
                else:
                    head = alias.name.split(".")[0]
                    module.imports[head] = ImportBinding(head, "module")
        elif isinstance(statement, ast.ImportFrom):
            base = _resolve_from_module(
                module.name, module.is_package, statement.level, statement.module
            )
            for alias in statement.names:
                if alias.name == "*":
                    continue
                target = f"{base}.{alias.name}" if base else alias.name
                module.imports[alias.asname or alias.name] = ImportBinding(
                    target, "symbol"
                )


def _resolve_from_module(
    module: str, is_package: bool, level: int, target: Optional[str]
) -> str:
    if level == 0:
        return target or ""
    parts = module.split(".") if module else []
    if not is_package:
        parts = parts[:-1]
    if level > 1:
        parts = parts[: max(len(parts) - (level - 1), 0)]
    base = ".".join(parts)
    if target:
        return f"{base}.{target}" if base else target
    return base


def _resolve_class_bases(index: ProjectIndex) -> None:
    for klass in index.classes_by_path.values():
        for base in klass.base_names:
            path = index.canonical(klass.module, base)
            if path and path in index.classes_by_path:
                klass.base_paths.append(path)
