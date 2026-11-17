"""SQLite 连接管理与建表、种子数据。

并发安全的关键约定：
- 每个请求使用独立连接，启用 WAL，写事务一律 ``BEGIN IMMEDIATE``，
  使“剩余有效管理员检查 + 成员变更写入”在同一个事务内原子完成。
"""

from __future__ import annotations

import hashlib
import hmac
import os
import sqlite3
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = BASE_DIR / "data" / "app.db"

# 演示种子数据：两个机构、共 5 名用户。
# 机构 A 有甲、乙两名管理员和普通成员丙；机构 B 的管理员名单不受 A 的操作影响。
SEED_USERS = [
    # (username, display_name, password)
    ("jia", "甲", "pass1234"),
    ("yi", "乙", "pass1234"),
    ("bing", "丙", "pass1234"),
    ("ding", "丁", "pass1234"),
    ("wu", "戊", "pass1234"),
]
SEED_ORGS = [
    # (name, [(username, role, is_active)])
    ("甲方机构", [
        ("jia", "admin", 1),
        ("yi", "admin", 1),
        ("bing", "member", 1),
    ]),
    ("乙方机构", [
        ("ding", "admin", 1),
        ("wu", "member", 1),
    ]),
]


def hash_password(password: str, salt: bytes | None = None) -> str:
    """PBKDF2-HMAC-SHA256，返回 ``salt$hash`` 十六进制字符串。"""
    if salt is None:
        salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 200_000)
    return f"{salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, digest_hex = stored.split("$", 1)
    except ValueError:
        return False
    candidate = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), 200_000
    )
    return hmac.compare_digest(candidate.hex(), digest_hex)


def connect(db_path: str | os.PathLike[str] = DEFAULT_DB_PATH) -> sqlite3.Connection:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    # WAL 让读写并发更顺畅；busy_timeout 配合 BEGIN IMMEDIATE 排队抢写锁。
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=10000")
    return conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orgs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memberships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL REFERENCES orgs(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER REFERENCES orgs(id),
    actor_user_id INTEGER REFERENCES users(id),
    target_user_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL,
    result TEXT NOT NULL CHECK (result IN ('success', 'blocked')),
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def init_db(db_path: str | os.PathLike[str] = DEFAULT_DB_PATH, *, seed: bool = True) -> None:
    conn = connect(db_path)
    try:
        conn.executescript(SCHEMA)
        if seed and conn.execute("SELECT COUNT(*) FROM orgs").fetchone()[0] == 0:
            _seed(conn)
    finally:
        conn.close()


def _seed(conn: sqlite3.Connection) -> None:
    for username, display_name, password in SEED_USERS:
        conn.execute(
            "INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)",
            (username, display_name, hash_password(password)),
        )
    user_id = {
        row["username"]: row["id"]
        for row in conn.execute("SELECT id, username FROM users")
    }
    for org_name, members in SEED_ORGS:
        cur = conn.execute("INSERT INTO orgs (name) VALUES (?)", (org_name,))
        org_id = cur.lastrowid
        for username, role, is_active in members:
            conn.execute(
                "INSERT INTO memberships (org_id, user_id, role, is_active) "
                "VALUES (?, ?, ?, ?)",
                (org_id, user_id[username], role, is_active),
            )
