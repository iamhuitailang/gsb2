"""加载工作流文件：YAML 解析并记录每个映射/键的行号，收集待扫描文件。"""
from __future__ import annotations

import os

import yaml

from .model import FileError

LINE = "__line__"
KEY_LINES = "__key_lines__"
_META_KEYS = (LINE, KEY_LINES)

_YAML_SUFFIXES = (".yml", ".yaml")


class _LineLoader(yaml.SafeLoader):
    """在解析结果中为每个映射附加行号信息。"""


def _construct_mapping(loader, node, deep=False):
    loader.flatten_mapping(node)
    mapping = yaml.SafeLoader.construct_mapping(loader, node, deep=True)
    key_lines = {}
    for key_node, value_node in node.value:
        if isinstance(key_node, yaml.nodes.ScalarNode):
            key_lines[str(key_node.value)] = value_node.start_mark.line + 1
    mapping[LINE] = node.start_mark.line + 1
    mapping[KEY_LINES] = key_lines
    return mapping


_LineLoader.add_constructor("tag:yaml.org,2002:map", _construct_mapping)


def load_file(path):
    """读取并解析文件，返回 (data, text, error)。error 非空表示失败。"""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError as exc:
        return None, None, f"文件不可读: {exc.strerror or exc}"
    except UnicodeDecodeError:
        return None, None, "文件不是有效的 UTF-8 文本"
    try:
        data = yaml.load(text, Loader=_LineLoader)
    except yaml.YAMLError as exc:
        detail = str(exc).replace("\n", " ")
        return None, text, f"YAML 解析失败: {detail[:200]}"
    return data, text, None


def is_workflow(data) -> bool:
    """判断解析结果是否像是一个工作流（顶层含 on 和 jobs）。"""
    if not isinstance(data, dict):
        return False
    return wf_get(data, "on") is not None and isinstance(data.get("jobs"), dict)


def real_items(mapping):
    """遍历解析出的映射，跳过内部附加的行号键。"""
    for key, value in mapping.items():
        if key not in _META_KEYS:
            yield key, value


def line_of(node, key=None) -> int:
    """取映射（或其某个键）在源文件中的行号，取不到返回 0。"""
    if isinstance(node, dict):
        if key is not None:
            key_lines = node.get(KEY_LINES)
            if isinstance(key_lines, dict) and key in key_lines:
                return key_lines[key]
        line = node.get(LINE)
        if isinstance(line, int):
            return line
    return 0


def wf_get(mapping, key, default=None):
    """读取工作流字段；兼容 YAML 1.1 把 on: 解析成布尔 True 的情况。"""
    if not isinstance(mapping, dict):
        return default
    if key in mapping:
        return mapping[key]
    if key == "on":
        for k in mapping:
            if k is True:
                return mapping[k]
    return default


def collect_files(paths):
    """根据命令行参数收集文件，返回 (explicit, discovered, errors)。

    explicit：命令行直接指定的文件（严格检查）；
    discovered：目录递归匹配到的 *.yml/*.yaml（非工作流的会被跳过）。
    """
    explicit, discovered, errors = [], [], []
    for raw in paths:
        if not os.path.exists(raw):
            errors.append(FileError(raw, "路径不存在"))
        elif os.path.isfile(raw):
            explicit.append(raw)
        elif os.path.isdir(raw):
            for root, dirs, names in os.walk(raw):
                dirs[:] = sorted(d for d in dirs if d != ".git")
                for name in sorted(names):
                    if name.endswith(_YAML_SUFFIXES):
                        discovered.append(os.path.join(root, name))
        else:
            errors.append(FileError(raw, "路径类型不支持（既不是文件也不是目录）"))
    explicit_set = set(explicit)
    discovered = [p for p in discovered if p not in explicit_set]
    return sorted(explicit), sorted(discovered), errors
