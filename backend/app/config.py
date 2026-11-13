"""Local signing configuration.

Secrets live only in config.local.json (or SIGN_TOOL_CONFIG).  This module never
logs or serialises secret values.  Callers that need to expose key metadata must
build their own response from the explicit fields below.
"""

from __future__ import annotations

import json
import logging
import os
import re
import stat
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger("sign_tool.config")

BACKEND_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG_PATH = BACKEND_ROOT / "config.local.json"
KEY_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
KEY_STATUSES = {"active", "grace", "retired"}

_warned_permission_paths: set[str] = set()


class ConfigError(RuntimeError):
    """Raised when the local config is missing or invalid."""


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_utc(value: str | None) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ConfigError("grace_until 必须是 ISO 8601 字符串")
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError as exc:
        raise ConfigError("grace_until 不是合法的 ISO 8601 时间") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


@dataclass(frozen=True)
class KeyRecord:
    key_id: str
    # ``repr=False`` keeps the secret out of any accidental logging or traceback
    # that formats this object (e.g. pytest assertion output).
    secret: str = field(repr=False)
    status: str
    created_at: str | None = None
    grace_until: datetime | None = None

    def effective_status(self, now: datetime) -> str:
        if self.status == "grace" and self.grace_until is not None and self.grace_until <= now:
            return "retired"
        return self.status


@dataclass(frozen=True)
class Settings:
    keys: tuple[KeyRecord, ...]
    time_window_seconds: int
    future_skew_seconds: int
    nonce_retention_seconds: int
    database_path: Path
    config_path: Path

    def key_by_id(self, key_id: str | None) -> KeyRecord | None:
        if not key_id:
            return None
        for key in self.keys:
            if key.key_id == key_id:
                return key
        return None

    def active_key(self, now: datetime | None = None) -> KeyRecord | None:
        now = now or utc_now()
        for key in self.keys:
            if key.effective_status(now) == "active":
                return key
        return None

    def public_key_summary(self, now: datetime | None = None) -> list[dict[str, Any]]:
        """Key metadata that is safe to hand to the browser (no secret)."""
        now = now or utc_now()
        summary: list[dict[str, Any]] = []
        for key in self.keys:
            summary.append(
                {
                    "key_id": key.key_id,
                    "status": key.effective_status(now),
                    "configured_status": key.status,
                    "created_at": key.created_at,
                    "grace_until": iso_utc(key.grace_until) if key.grace_until else None,
                }
            )
        return summary


def _require_int(data: dict[str, Any], name: str, default: int, minimum: int, maximum: int) -> int:
    value = data.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(f"{name} 必须是整数")
    if not minimum <= value <= maximum:
        raise ConfigError(f"{name} 必须在 {minimum} 到 {maximum} 之间")
    return value


def _parse_key(raw: Any, index: int) -> KeyRecord:
    if not isinstance(raw, dict):
        raise ConfigError(f"keys[{index}] 必须是对象")

    key_id = raw.get("key_id")
    if not isinstance(key_id, str) or not KEY_ID_RE.fullmatch(key_id):
        raise ConfigError(f"keys[{index}].key_id 格式不合法")
    if key_id != key_id.strip():
        raise ConfigError(f"keys[{index}].key_id 不能包含首尾空白")

    secret = raw.get("secret")
    if not isinstance(secret, str) or len(secret) < 16:
        raise ConfigError(f"keys[{index}].secret 至少需要 16 个字符")
    if secret != secret.strip():
        raise ConfigError(f"keys[{index}].secret 不能包含首尾空白")

    status = raw.get("status")
    if status not in KEY_STATUSES:
        raise ConfigError(f"keys[{index}].status 必须是 active/grace/retired 之一")

    created_at = raw.get("created_at")
    if created_at is not None and not isinstance(created_at, str):
        raise ConfigError(f"keys[{index}].created_at 必须是字符串或 null")

    grace_until = parse_utc(raw.get("grace_until"))
    if status == "grace" and grace_until is None:
        raise ConfigError(f"keys[{index}] 处于 grace 状态时必须配置 grace_until")

    return KeyRecord(
        key_id=key_id,
        secret=secret,
        status=status,
        created_at=created_at,
        grace_until=grace_until,
    )


def build_settings(data: dict[str, Any], config_path: Path) -> Settings:
    if not isinstance(data, dict):
        raise ConfigError("配置文件顶层必须是对象")

    raw_keys = data.get("keys")
    if not isinstance(raw_keys, list) or not raw_keys:
        raise ConfigError("配置中至少需要一个密钥")

    keys = tuple(_parse_key(raw, i) for i, raw in enumerate(raw_keys))
    if len({k.key_id for k in keys}) != len(keys):
        raise ConfigError("密钥 key_id 不能重复")

    active_keys = [k for k in keys if k.status == "active"]
    if len(active_keys) != 1:
        raise ConfigError("配置中必须且只能有一个 status=active 的密钥（轮换会原子地完成切换）")

    time_window = _require_int(data, "time_window_seconds", 300, 1, 86_400)
    future_skew = _require_int(data, "future_skew_seconds", 60, 0, 900)
    nonce_retention = _require_int(data, "nonce_retention_seconds", 900, 60, 604_800)
    if nonce_retention < time_window + future_skew:
        raise ConfigError(
            "nonce_retention_seconds 必须不小于 time_window_seconds + future_skew_seconds，"
            "否则请求在仍可被接受时其 nonce 可能已被清理"
        )

    database_raw = data.get("database_path", "data/audit.sqlite3")
    if not isinstance(database_raw, str) or not database_raw.strip():
        raise ConfigError("database_path 必须是非空字符串")
    database_path = Path(database_raw).expanduser()
    if not database_path.is_absolute():
        database_path = (config_path.parent / database_path).resolve()
    else:
        database_path = database_path.resolve()

    return Settings(
        keys=keys,
        time_window_seconds=time_window,
        future_skew_seconds=future_skew,
        nonce_retention_seconds=nonce_retention,
        database_path=database_path,
        config_path=config_path,
    )


def resolve_config_path(path: str | Path | None = None) -> Path:
    if path is None:
        env_path = os.environ.get("SIGN_TOOL_CONFIG")
        if env_path:
            path = env_path
        else:
            path = DEFAULT_CONFIG_PATH
    return Path(path).expanduser().resolve()


def _warn_permissions(path: Path) -> None:
    if os.name != "posix":
        return
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
    except OSError:
        return
    key = str(path)
    if mode & 0o077 and key not in _warned_permission_paths:
        _warned_permission_paths.add(key)
        logger.warning(
            "配置文件权限过宽（mode=%o），建议执行 chmod 600 %s；密钥不会被写入日志",
            mode,
            path,
        )


def load_settings(path: str | Path | None = None) -> Settings:
    config_path = resolve_config_path(path)
    if not config_path.is_file():
        raise ConfigError(
            f"找不到本地配置 {config_path}。请先在 backend 目录执行 `python -m app.keytool init`。"
        )
    _warn_permissions(config_path)
    try:
        raw_text = config_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"无法读取本地配置 {config_path}") from exc
    try:
        data = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise ConfigError("本地配置不是合法 JSON") from exc
    return build_settings(data, config_path)
