"""文件系统相关的安全工具：文件名消毒、随机隔离目录、安全删除。

上传文件名永远不会直接拼到服务器路径里：服务端使用 uuid 作为存储名，
原始文件名仅作为元数据保存在数据库中（并做了头/尾控制字符清理）。
"""
from __future__ import annotations

import os
import re
import shutil
import uuid
from pathlib import Path

from . import config

# 文件名里只保留常见安全字符，其余替换为下划线
_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")
# 防止 "." / ".." / 隐藏文件之类的退化情况
_RESERVED = {"", ".", ".."}


def sanitize_filename(name: str) -> str:
    """把用户提供的文件名清理成可安全展示/下载的名称。

    注意：该结果只用于展示和 Content-Disposition，不用于拼存储路径。
    """
    name = os.path.basename(name or "").strip()
    # 去掉控制字符与路径分隔符残留
    name = "".join(ch for ch in name if ch.isprintable() and ch not in "/\\")
    name = _SAFE_NAME_RE.sub("_", name)
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    stem = re.sub(r"_+", "_", stem).strip("._") or "file"
    ext = re.sub(r"_+", "_", ext).strip("._")
    name = f"{stem}.{ext}" if ext else stem
    # 限制总长度，给扩展名和前缀留余地
    if len(name) > 180:
        stem, dot, ext = name.rpartition(".")
        if dot:
            name = stem[: 180 - len(ext) - 1] + "." + ext
        else:
            name = name[:180]
    if name in _RESERVED:
        name = "file"
    return name


def safe_extension(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    return ext if ext in config.ALLOWED_EXTENSIONS else ""


def new_id() -> str:
    return uuid.uuid4().hex


def ensure_dirs() -> None:
    for d in (config.DATA_DIR, config.UPLOAD_DIR, config.OUTPUT_DIR, config.TEMP_DIR):
        d.mkdir(parents=True, exist_ok=True)


def upload_path(store_name: str) -> Path:
    """根据数据库里的存储名定位上传文件，禁止路径逃逸。"""
    base = config.UPLOAD_DIR.resolve()
    p = (base / store_name).resolve()
    if p.parent != base:
        raise ValueError("invalid upload path")
    return p


def output_path(store_name: str) -> Path:
    base = config.OUTPUT_DIR.resolve()
    p = (base / store_name).resolve()
    if p.parent != base:
        raise ValueError("invalid output path")
    return p


def temp_dir(task_id: str) -> Path:
    """每个任务一个独立临时目录，互不干扰。"""
    if not re.fullmatch(r"[0-9a-f]{32}", task_id):
        raise ValueError("invalid task id")
    p = (config.TEMP_DIR / task_id).resolve()
    if p.parent != config.TEMP_DIR.resolve():
        raise ValueError("invalid temp path")
    return p


def remove_path(path: Path) -> None:
    """删除文件或目录，不存在时静默。仅允许操作 data 目录内的目标。"""
    root = config.DATA_DIR.resolve()
    try:
        target = path.resolve()
        target.relative_to(root)
    except (ValueError, OSError):
        raise ValueError(f"refuse to remove path outside data dir: {path}")
    if not target.exists():
        return
    if target.is_dir():
        shutil.rmtree(target, ignore_errors=True)
    else:
        target.unlink(missing_ok=True)
