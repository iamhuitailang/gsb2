"""Local key management CLI.

Usage (run from the ``backend`` directory, or with ``PYTHONPATH=backend``):

    python -m app.keytool init
    python -m app.keytool status
    python -m app.keytool rotate --grace-seconds 600
    python -m app.keytool retire-grace

Secrets are generated locally with ``secrets.token_urlsafe`` and written only to
``config.local.json`` (mode 0600).  Nothing here prints a secret.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import stat
import sys
from datetime import timedelta
from pathlib import Path

from .config import (
    ConfigError,
    build_settings,
    iso_utc,
    resolve_config_path,
    utc_now,
)

BASE_TEMPLATE = {
    "time_window_seconds": 300,
    "future_skew_seconds": 60,
    "nonce_retention_seconds": 900,
    "database_path": "data/audit.sqlite3",
}


def _new_secret() -> str:
    return secrets.token_urlsafe(48)


def _new_key_id(prefix: str = "local") -> str:
    return f"{prefix}-{utc_now().strftime('%Y%m%d')}-{secrets.token_hex(3)}"


def _write_config(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
    os.replace(tmp, path)


def _load_raw(path: Path) -> dict:
    if not path.is_file():
        raise ConfigError(f"找不到本地配置 {path}，请先执行 `python -m app.keytool init`")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ConfigError(f"配置文件 {path} 不是合法 JSON") from exc
    if not isinstance(data, dict):
        raise ConfigError(f"配置文件 {path} 顶层必须是对象")
    return data


def cmd_init(args: argparse.Namespace) -> int:
    path = resolve_config_path(args.config)
    if path.exists() and not args.force:
        print(f"配置已存在：{path}（如需重建请加 --force）")
        return 1
    key_id = args.key_id or "demo-local-01"
    data = dict(BASE_TEMPLATE)
    data["keys"] = [
        {
            "key_id": key_id,
            "secret": _new_secret(),
            "status": "active",
            "created_at": iso_utc(utc_now()),
            "grace_until": None,
        }
    ]
    settings = build_settings(data, path)
    _write_config(path, data)
    print(f"已生成 {path}（权限 600）")
    print(f"活动密钥：{key_id}（密钥原文不在终端显示）")
    print(f"数据库：{settings.database_path}")
    print("如需查看密钥原文，请直接打开该本机配置文件。")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    path = resolve_config_path(args.config)
    data = _load_raw(path)
    settings = build_settings(data, path)
    now = utc_now()
    print(f"配置文件：{path}")
    print(f"数据库：{settings.database_path}")
    print(
        f"时间窗口：{settings.time_window_seconds}s，"
        f"允许超前：{settings.future_skew_seconds}s，"
        f"nonce 保留：{settings.nonce_retention_seconds}s"
    )
    for key in settings.public_key_summary(now):
        grace = f"  grace_until={key['grace_until']}" if key["grace_until"] else ""
        print(f"- {key['key_id']}: {key['status']}{grace}")
    return 0


def cmd_rotate(args: argparse.Namespace) -> int:
    path = resolve_config_path(args.config)
    data = _load_raw(path)
    settings = build_settings(data, path)
    now = utc_now()
    if args.grace_seconds < 0 or args.grace_seconds > 86_400:
        raise ConfigError("grace-seconds 必须在 0 到 86400 之间")

    existing_active = settings.active_key(now)
    if existing_active is None:
        raise ConfigError("当前没有活动密钥，请检查配置")

    new_id = args.new_key_id or _new_key_id()
    if any(k.get("key_id") == new_id for k in data["keys"]):
        raise ConfigError(f"key_id {new_id} 已存在")

    new_key = {
        "key_id": new_id,
        "secret": _new_secret(),
        "status": "active",
        "created_at": iso_utc(now),
        "grace_until": None,
    }
    retired_at = now + timedelta(seconds=args.grace_seconds)
    for key in data["keys"]:
        if key["key_id"] == existing_active.key_id and key.get("status") == "active":
            if args.grace_seconds == 0:
                key["status"] = "retired"
                key["grace_until"] = None
            else:
                key["status"] = "grace"
                key["grace_until"] = iso_utc(retired_at)
    # Append the new active key; the old one keeps its place for auditability.
    data["keys"] = [k for k in data["keys"] if k["key_id"] != new_id] + [new_key]

    build_settings(data, path)  # validate before writing
    _write_config(path, data)
    print(f"已轮换：{existing_active.key_id} -> {new_id}")
    if args.grace_seconds:
        print(f"旧密钥在 {iso_utc(retired_at)} 之前仍可验签，之后自动拒绝。")
    else:
        print("旧密钥已立即退役。")
    return 0


def cmd_retire_grace(args: argparse.Namespace) -> int:
    path = resolve_config_path(args.config)
    data = _load_raw(path)
    changed = 0
    for key in data["keys"]:
        if key.get("status") == "grace":
            key["status"] = "retired"
            key["grace_until"] = None
            changed += 1
    build_settings(data, path)  # validate before writing
    _write_config(path, data)
    print(f"已退役 {changed} 个 grace 密钥；现在只有活动密钥可验签。")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="app.keytool", description="本地验签密钥管理")
    parser.add_argument("--config", help="配置文件路径，默认取 SIGN_TOOL_CONFIG 或 config.local.json")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="生成本地配置与演示密钥")
    p_init.add_argument("--force", action="store_true", help="覆盖已有配置")
    p_init.add_argument("--key-id", default=None, help="活动密钥 ID，默认 demo-local-01")
    p_init.set_defaults(func=cmd_init)

    p_status = sub.add_parser("status", help="查看密钥状态（不显示密钥）")
    p_status.set_defaults(func=cmd_status)

    p_rotate = sub.add_parser("rotate", help="原子轮换密钥，旧密钥进入宽限期")
    p_rotate.add_argument("--grace-seconds", type=int, default=600, help="旧密钥宽限秒数，0 表示立即退役")
    p_rotate.add_argument("--new-key-id", default=None, help="新密钥 ID（默认自动生成）")
    p_rotate.set_defaults(func=cmd_rotate)

    p_retire = sub.add_parser("retire-grace", help="立即结束所有宽限期")
    p_retire.set_defaults(func=cmd_retire_grace)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except ConfigError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
