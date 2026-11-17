"""模块注册表：解析所有 Python 文件的 AST，收集函数、类与导入关系。

这一层只做语法层面的信息收集，不做任何污点判断；
所有文件都通过 ast.parse 静态解析，绝不 import / exec 被扫描代码。
"""

from __future__ import annotations

import ast
import os
from dataclasses import dataclass, field
from typing import Optional

from .model import AnalysisError

MODULE_LEVEL = "<module>"


@dataclass
class FuncInfo:
    node: ast.FunctionDef | ast.AsyncFunctionDef
    qualname: str          # 模块内限定名，例如 UserDAO.find
    class_name: Optional[str]
    fkey: tuple[str, str]  # (module_id, qualname)


@dataclass
class ModuleRegistry:
    module_id: str
    path: str
    tree: ast.Module
    # 限定名 -> FuncInfo
    functions: dict[str, FuncInfo] = field(default_factory=dict)
    # 类名 -> 其方法的限定名集合
    classes: dict[str, set[str]] = field(default_factory=dict)
    # import 进来的名字 -> 来源模块的 module_id（能解析到时）
    imports: dict[str, str] = field(default_factory=dict)
    # import 进来的模块别名 -> module_id
    module_aliases: dict[str, str] = field(default_factory=dict)
    # from x import y 形式中，y 可能是函数：别名 -> (module_id, 原名)
    from_imports: dict[str, tuple[str, str]] = field(default_factory=dict)


def _module_id_for(path: str, root: str) -> str:
    """用相对路径（去掉 .py 后缀）作为稳定的模块标识。"""
    rel = os.path.relpath(path, root)
    if rel.endswith(".py"):
        rel = rel[:-3]
    return rel.replace(os.sep, "/")


class RegistryBuilder:
    def __init__(self, root: str, files: list[str]):
        self.root = root
        self.files = files
        self.registries: dict[str, ModuleRegistry] = {}
        # 模块的 dotted 名（pkg.dao）-> module_id（pkg/dao），用于 import 解析
        self._dotted_to_id: dict[str, str] = {}
        self.errors: list[AnalysisError] = []

    def build(self) -> None:
        for path in sorted(self.files):
            self._parse_one(path)
        self._resolve_imports()

    def _parse_one(self, path: str) -> None:
        module_id = _module_id_for(path, self.root)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                source = fh.read()
            tree = ast.parse(source, filename=path)
        except SyntaxError as exc:
            self.errors.append(AnalysisError(
                file=module_id,
                line=exc.lineno or 0,
                error_type="SyntaxError",
                message=exc.msg,
            ))
            return
        except OSError as exc:
            self.errors.append(AnalysisError(
                file=module_id, line=0,
                error_type=type(exc).__name__, message=str(exc),
            ))
            return

        reg = ModuleRegistry(module_id=module_id, path=path, tree=tree)
        dotted = module_id.replace("/", ".")
        self._dotted_to_id[dotted] = module_id
        # 包的 __init__.py 同时以包名登记
        if dotted.endswith(".__init__"):
            self._dotted_to_id[dotted[: -len(".__init__")]] = module_id

        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._register_func(reg, node, class_name=None, prefix="")
            elif isinstance(node, ast.ClassDef):
                self._register_class(reg, node)
        self.registries[module_id] = reg

    def _register_func(self, reg: ModuleRegistry,
                       node: ast.FunctionDef | ast.AsyncFunctionDef,
                       class_name: Optional[str], prefix: str) -> None:
        qualname = f"{prefix}{node.name}"
        info = FuncInfo(
            node=node, qualname=qualname, class_name=class_name,
            fkey=(reg.module_id, qualname),
        )
        reg.functions[qualname] = info
        # 嵌套函数也登记在同一个函数表里，限定名体现嵌套关系
        for child in node.body:
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._register_func(reg, child, class_name,
                                    prefix=qualname + ".")

    def _register_class(self, reg: ModuleRegistry, node: ast.ClassDef) -> None:
        methods: set[str] = set()
        for child in node.body:
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                qualname = f"{node.name}.{child.name}"
                self._register_func(reg, child, class_name=node.name,
                                    prefix=node.name + ".")
                methods.add(qualname)
        reg.classes[node.name] = methods

    def _resolve_imports(self) -> None:
        for reg in self.registries.values():
            for node in ast.walk(reg.tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        target = self._dotted_to_id.get(alias.name)
                        if target is None:
                            continue
                        bound = alias.asname or alias.name.split(".")[0]
                        reg.module_aliases[bound] = target
                elif isinstance(node, ast.ImportFrom):
                    target_mod = self._resolve_from_module(reg.module_id, node)
                    if target_mod is None:
                        continue
                    for alias in node.names:
                        if alias.name == "*":
                            continue
                        bound = alias.asname or alias.name
                        reg.from_imports[bound] = (target_mod, alias.name)
                        # 被导入的名字本身也可能是子模块
                        dotted_target = target_mod.replace("/", ".")
                        sub_mod = self._dotted_to_id.get(
                            dotted_target + "." + alias.name
                        )
                        if sub_mod:
                            reg.module_aliases[bound] = sub_mod

    def _resolve_from_module(self, current_module: str,
                             node: ast.ImportFrom) -> Optional[str]:
        """解析 from ... import 的来源模块，支持相对导入（level > 0）。"""
        if node.level == 0:
            return self._dotted_to_id.get(node.module or "")

        # 相对导入：按当前模块的包层级向上回退 level 层
        parts = current_module.split("/")
        # 模块自身占一层；包内模块 from . import x 时 level=1
        base = parts[: len(parts) - node.level]
        if node.module:
            base.extend(node.module.split("."))
        return self._dotted_to_id.get(".".join(base))
