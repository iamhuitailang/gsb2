"""更新包的打包与验收（验证）。

验收顺序（全部通过才算 ACCEPTED）：
1. 归档结构安全（archive.read_archive）
2. 清单合法（manifest.validate）
3. 签名钥匙受信且未撤销，签名有效
4. min_tool_version 不超过本工具版本
5. 安全解包到隔离目录后，逐文件核对摘要；
   缺文件、摘要/大小不符、清单外的多余文件一律拒绝
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import tarfile
from pathlib import Path

from . import TOOL_VERSION, archive, crypto, manifest as mf
from .errors import ToolError, VerifyError


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 256), b""):
            h.update(chunk)
    return h.hexdigest()


def pack(content_dir, product, channel, version, min_tool_version,
         key_id, priv, out_path):
    """把 content_dir 打成一个带签名的更新包。"""
    content = Path(content_dir)
    if not content.is_dir():
        raise ToolError(f"内容目录不存在: {content_dir}")
    files = []
    for f in sorted(content.rglob("*")):
        if f.is_file():
            rel = f.relative_to(content).as_posix()
            files.append({
                "path": rel,
                "sha256": _sha256_file(f),
                "size": f.stat().st_size,
            })
    if not files:
        raise ToolError("内容目录里没有任何文件")
    manifest = mf.build_manifest(product, channel, version, min_tool_version, files)
    manifest_bytes = json.dumps(manifest, indent=2, sort_keys=True).encode()
    sig_rec = {
        "algorithm": "demo-rsa-sha256",
        "key_id": key_id,
        "signature": crypto.sign(priv, manifest_bytes).hex(),
    }
    sig_bytes = json.dumps(sig_rec, indent=2, sort_keys=True).encode()

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(out_path, "w:gz") as tf:
        for name, blob in (("manifest.json", manifest_bytes),
                           ("manifest.sig", sig_bytes)):
            ti = tarfile.TarInfo(name)
            ti.size = len(blob)
            ti.mtime = 0
            ti.mode = 0o644
            tf.addfile(ti, io.BytesIO(blob))
        for entry in files:
            src = content / entry["path"]
            ti = tf.gettarinfo(str(src), arcname="payload/" + entry["path"])
            ti.mtime = 0
            with open(src, "rb") as fobj:
                tf.addfile(ti, fobj)
    return out_path


def _check_payload_tree(dest_dir: Path, files: list):
    """解包结果与清单双向核对：缺项、多余、摘要/大小不符都拒绝。"""
    actual = {}
    for f in sorted(dest_dir.rglob("*")):
        if f.is_file():
            rel = f.relative_to(dest_dir).as_posix()
            actual[rel] = f
    expected = {entry["path"]: entry for entry in files}
    missing = sorted(set(expected) - set(actual))
    if missing:
        raise VerifyError(f"归档缺少清单声明的文件: {missing[:5]}")
    extra = sorted(set(actual) - set(expected))
    if extra:
        raise VerifyError(f"归档含清单之外的多余文件: {extra[:5]}")
    for path, entry in expected.items():
        f = actual[path]
        if f.stat().st_size != entry["size"]:
            raise VerifyError(f"文件大小不符: {path}")
        if _sha256_file(f) != entry["sha256"]:
            raise VerifyError(f"文件摘要与清单不符: {path}")


def verify_package(pkg_path, trust, dest_dir, tool_version=TOOL_VERSION) -> dict:
    """完整验收一个更新包；通过后负载已解到 dest_dir。失败抛 ToolError。"""
    # 1. 归档结构安全
    manifest_bytes, sig_bytes, payload_members = archive.read_archive(pkg_path)
    # 2. 清单合法
    manifest, files = mf.load_and_validate(manifest_bytes)
    # 3. 签名：钥匙必须当前受信且未撤销
    try:
        sig_rec = json.loads(sig_bytes.decode("utf-8"))
        key_id = sig_rec["key_id"]
        signature = bytes.fromhex(sig_rec["signature"])
    except (ValueError, KeyError, TypeError) as e:
        raise VerifyError(f"签名文件格式错误: {e}")
    pub = trust.get_active(key_id)
    if pub is None:
        raise VerifyError(f"签发钥匙 {key_id} 不在受信列表或已被撤销")
    if not crypto.verify(pub, manifest_bytes, signature):
        raise VerifyError("签名验证失败（内容被改动或钥匙不匹配）")
    # 4. 工具版本要求
    if mf.version_tuple(tool_version) < mf.version_tuple(manifest["min_tool_version"]):
        raise VerifyError(
            f"更新包要求工具版本 >= {manifest['min_tool_version']}，"
            f"当前为 {tool_version}"
        )
    # 5. 安全解包 + 摘要核对
    archive.extract_payload(pkg_path, payload_members, str(dest_dir))
    _check_payload_tree(Path(dest_dir), files)
    return {
        "product": manifest["product"],
        "channel": manifest["channel"],
        "version": manifest["version"],
        "min_tool_version": manifest["min_tool_version"],
        "key_id": key_id,
        "files": files,
    }
