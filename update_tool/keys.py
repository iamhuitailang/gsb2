"""本地受信公钥库与演示密钥的文件存取。

目录结构（都在 --root 下）：
  keys/private/<key_id>.json   私钥（权限 600，绝不写进日志）
  keys/public/<key_id>.json    公钥
  trust/trusted.json           受信钥匙库：key_id -> {status, public, ...}

钥匙状态：active（可签发）/ revoked（已撤销，验证一律拒绝）。
轮换 = 新增一把 active 钥匙 + 撤销旧钥匙；撤销不可绕过。
"""
from __future__ import annotations

import json
import os
import stat
from datetime import datetime, timezone
from pathlib import Path

from . import crypto
from .errors import ToolError


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _atomic_write_json(path: Path, data, mode=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
    if mode is not None:
        os.chmod(tmp, mode)
    os.replace(tmp, path)


def generate_and_save(root: Path, bits: int, label: str = "", trust: bool = True) -> str:
    pub, priv = crypto.generate_keypair(bits)
    kid = crypto.key_id(pub)
    priv_rec = {"key_id": kid, "label": label, "public": pub, "private": {"d": priv["d"]}}
    pub_rec = {"key_id": kid, "label": label, "public": pub}
    priv_path = root / "keys" / "private" / f"{kid}.json"
    _atomic_write_json(priv_path, priv_rec, mode=stat.S_IRUSR | stat.S_IWUSR)
    _atomic_write_json(root / "keys" / "public" / f"{kid}.json", pub_rec)
    if trust:
        TrustStore(root).add(pub, label=label)
    return kid


def load_private(root: Path, key_id: str) -> dict:
    path = root / "keys" / "private" / f"{key_id}.json"
    if not path.exists():
        raise ToolError(f"找不到私钥 {key_id}（{path}）")
    rec = json.loads(path.read_text(encoding="utf-8"))
    priv = dict(rec["public"])
    priv["d"] = rec["private"]["d"]
    return priv


def load_public_file(path) -> dict:
    rec = json.loads(Path(path).read_text(encoding="utf-8"))
    pub = rec.get("public", rec)
    if crypto.key_id(pub) != rec.get("key_id", crypto.key_id(pub)):
        raise ToolError("公钥文件内容与 key_id 不符")
    return pub


class TrustStore:
    def __init__(self, root: Path):
        self.path = Path(root) / "trust" / "trusted.json"

    def _load(self) -> dict:
        if not self.path.exists():
            return {"keys": {}}
        return json.loads(self.path.read_text(encoding="utf-8"))

    def _save(self, data: dict):
        _atomic_write_json(self.path, data)

    def add(self, pub: dict, label: str = "") -> str:
        kid = crypto.key_id(pub)
        data = self._load()
        existing = data["keys"].get(kid)
        if existing and existing["status"] == "revoked":
            raise ToolError(f"钥匙 {kid} 已被撤销，不能重新加入（请生成新钥匙）")
        data["keys"][kid] = {
            "status": "active",
            "label": label,
            "public": pub,
            "added": _now(),
        }
        self._save(data)
        return kid

    def revoke(self, key_id: str):
        data = self._load()
        entry = data["keys"].get(key_id)
        if entry is None:
            raise ToolError(f"钥匙 {key_id} 不在受信列表中")
        if entry["status"] == "revoked":
            raise ToolError(f"钥匙 {key_id} 已经撤销过了")
        entry["status"] = "revoked"
        entry["revoked"] = _now()
        self._save(data)

    def get_active(self, key_id: str):
        """返回受信且未撤销的公钥；否则 None。"""
        entry = self._load()["keys"].get(key_id)
        if entry and entry["status"] == "active":
            return entry["public"]
        return None

    def list(self) -> dict:
        return self._load()["keys"]
