"""归档安全检查与安全解包。

规则：
- 归档内只允许 manifest.json、manifest.sig 和 payload/ 下的普通文件；
- 拒绝绝对路径、.. 越界、反斜杠、符号链接/硬链接/设备文件等；
- 拒绝规范化后重名的条目；
- 限制文件数量、单文件大小和总解包体积；
- 解包不使用 tarfile.extractall，逐个校验后手工写盘，并做
  realpath 包含检查，保证内容只落在目标目录内。
"""
from __future__ import annotations

import os
import shutil
import tarfile

from .errors import ArchiveError
from .manifest import normalize_rel_path

MAX_FILES = 10000
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MAX_FILE_BYTES = 256 * 1024 * 1024
MAX_MANIFEST_BYTES = 1024 * 1024

PAYLOAD_PREFIX = "payload/"


def _normalize_member_name(name: str) -> str:
    try:
        return normalize_rel_path(name)
    except Exception as e:
        raise ArchiveError(f"归档条目 {name!r} 不安全: {e}")


def read_archive(pkg_path):
    """第一遍扫描：校验结构，返回 (manifest_bytes, sig_bytes, payload_members)。

    payload_members: [(相对负载路径, 大小, 归档内原始名字)]，尚未写盘。
    """
    manifest_bytes = None
    sig_bytes = None
    payload = []
    seen = set()
    file_count = 0
    total_bytes = 0
    try:
        tf = tarfile.open(pkg_path, "r:*")
    except (tarfile.TarError, OSError) as e:
        raise ArchiveError(f"无法读取归档: {e}")
    with tf:
        for member in tf:
            norm = _normalize_member_name(member.name)
            if norm in seen:
                raise ArchiveError(f"归档内存在规范化后重名的条目: {norm!r}")
            seen.add(norm)
            if member.isdir():
                if norm == "payload" or norm.startswith(PAYLOAD_PREFIX):
                    continue
                raise ArchiveError(f"不允许的目录条目: {norm!r}")
            if not member.isreg():
                raise ArchiveError(
                    f"不允许的条目类型（符号链接/硬链接/设备等）: {member.name!r}"
                )
            file_count += 1
            total_bytes += member.size
            if file_count > MAX_FILES:
                raise ArchiveError(f"归档文件数量超过上限 {MAX_FILES}")
            if member.size > MAX_FILE_BYTES:
                raise ArchiveError(f"文件 {norm!r} 超过单文件大小上限")
            if total_bytes > MAX_TOTAL_BYTES:
                raise ArchiveError(f"解包总大小超过上限 {MAX_TOTAL_BYTES} 字节")
            if norm == "manifest.json":
                if member.size > MAX_MANIFEST_BYTES:
                    raise ArchiveError("manifest.json 过大")
                manifest_bytes = tf.extractfile(member).read()
            elif norm == "manifest.sig":
                if member.size > MAX_MANIFEST_BYTES:
                    raise ArchiveError("manifest.sig 过大")
                sig_bytes = tf.extractfile(member).read()
            elif norm.startswith(PAYLOAD_PREFIX) and len(norm) > len(PAYLOAD_PREFIX):
                payload.append((norm[len(PAYLOAD_PREFIX):], member.size, member.name))
            else:
                raise ArchiveError(f"归档内出现未预期的条目: {norm!r}")
    if manifest_bytes is None:
        raise ArchiveError("归档缺少 manifest.json")
    if sig_bytes is None:
        raise ArchiveError("归档缺少 manifest.sig")
    if not payload:
        raise ArchiveError("归档 payload/ 为空")
    return manifest_bytes, sig_bytes, payload


def extract_payload(pkg_path, payload_members, dest_dir):
    """第二遍扫描：把已校验过的 payload 条目写入 dest_dir。"""
    dest_real = os.path.realpath(dest_dir)
    os.makedirs(dest_real, exist_ok=True)
    wanted = {raw: rel for rel, _size, raw in payload_members}
    written = 0
    with tarfile.open(pkg_path, "r:*") as tf:
        for member in tf:
            if not member.isreg() or member.name not in wanted:
                continue
            rel = wanted[member.name]
            target = os.path.join(dest_real, *rel.split("/"))
            # 双保险：即使前面的校验被绕过，也绝不写出目标目录
            target_real = os.path.realpath(os.path.dirname(target))
            if os.path.commonpath([dest_real, target_real]) != dest_real:
                raise ArchiveError(f"条目 {member.name!r} 会写出目标目录，拒绝")
            os.makedirs(os.path.dirname(target), exist_ok=True)
            src = tf.extractfile(member)
            with open(target, "wb") as out:
                shutil.copyfileobj(src, out, 1024 * 256)
            written += 1
    if written != len(payload_members):
        raise ArchiveError("归档在两次读取间发生变化，拒绝使用")
    return written
