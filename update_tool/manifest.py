"""更新包清单（manifest）的构建与校验。

清单绑定：产品、更新通道、版本、最低工具版本，以及每个文件的
相对路径与 SHA-256 摘要。校验时拒绝：缺项、重复路径、路径规范化
后冲突、非法路径（绝对路径 / 越界 ..）。
"""
from __future__ import annotations

import json
import re

from .errors import ManifestError

VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

REQUIRED_FIELDS = ("product", "channel", "version", "min_tool_version", "files")


def version_tuple(s: str) -> tuple:
    if not isinstance(s, str) or not VERSION_RE.match(s):
        raise ManifestError(f"非法版本号: {s!r}（需要 X.Y.Z 数字形式）")
    return tuple(int(x) for x in s.split("."))


def check_name(value, what: str) -> str:
    """产品名 / 通道名会用作目录名，必须安全。"""
    if not isinstance(value, str) or not NAME_RE.match(value) or value in (".", ".."):
        raise ManifestError(f"非法{what}: {value!r}")
    return value


def normalize_rel_path(path) -> str:
    """把清单/归档中的相对路径规范化；任何越界或歧义都直接拒绝。"""
    if not isinstance(path, str) or not path:
        raise ManifestError("路径为空或不是字符串")
    if "\x00" in path:
        raise ManifestError(f"路径含 NUL 字符: {path!r}")
    if "\\" in path:
        raise ManifestError(f"路径含反斜杠（有歧义）: {path!r}")
    if path.startswith("/") or re.match(r"^[A-Za-z]:", path):
        raise ManifestError(f"不允许绝对路径: {path!r}")
    parts = []
    for seg in path.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            raise ManifestError(f"路径越出目标目录: {path!r}")
        parts.append(seg)
    if not parts:
        raise ManifestError(f"路径规范化后为空: {path!r}")
    return "/".join(parts)


def validate(manifest) -> list:
    """校验清单，返回规范化后的文件列表 [{"path","sha256","size"}]。

    任何缺项、重复路径、规范化冲突都会抛出 ManifestError。
    """
    errors = []
    if not isinstance(manifest, dict):
        raise ManifestError("清单不是 JSON 对象")
    for field in REQUIRED_FIELDS:
        if field not in manifest:
            errors.append(f"缺少字段: {field}")
    if errors:
        raise ManifestError("; ".join(errors))

    for field, what in (("product", "产品名"), ("channel", "通道名")):
        try:
            check_name(manifest[field], what)
        except ManifestError as e:
            errors.append(str(e))
    for field in ("version", "min_tool_version"):
        try:
            version_tuple(manifest[field])
        except ManifestError as e:
            errors.append(str(e))

    files = manifest["files"]
    norm_files = []
    if not isinstance(files, list) or not files:
        errors.append("files 必须是非空列表")
    else:
        seen = {}
        for i, entry in enumerate(files):
            if not isinstance(entry, dict):
                errors.append(f"files[{i}] 不是对象")
                continue
            raw_path = entry.get("path")
            try:
                norm = normalize_rel_path(raw_path)
            except ManifestError as e:
                errors.append(f"files[{i}]: {e}")
                continue
            if norm in seen:
                errors.append(
                    f"路径规范化后冲突: {seen[norm]!r} 与 {raw_path!r} -> {norm!r}"
                )
                continue
            seen[norm] = raw_path
            sha = entry.get("sha256")
            if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
                errors.append(f"files[{i}] ({norm}): sha256 必须是 64 位小写十六进制")
                continue
            size = entry.get("size")
            if not isinstance(size, int) or isinstance(size, bool) or size < 0:
                errors.append(f"files[{i}] ({norm}): size 必须是非负整数")
                continue
            norm_files.append({"path": norm, "sha256": sha, "size": size})
    if errors:
        raise ManifestError("; ".join(errors))
    return norm_files


def load_and_validate(manifest_bytes: bytes):
    """解析 JSON 并校验，返回 (manifest_dict, 规范化文件列表)。"""
    try:
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise ManifestError(f"清单不是合法 JSON: {e}")
    return manifest, validate(manifest)


def build_manifest(product, channel, version, min_tool_version, files) -> dict:
    manifest = {
        "product": product,
        "channel": channel,
        "version": version,
        "min_tool_version": min_tool_version,
        "files": files,
    }
    validate(manifest)  # 打包时也过一遍同样的校验
    return manifest
