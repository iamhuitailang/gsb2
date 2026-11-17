"""本地账号存储。密码用 PBKDF2-HMAC-SHA256 加盐哈希，绝不存明文。"""
from __future__ import annotations

import hashlib
import hmac
import os
import sqlite3
from dataclasses import dataclass

from .clock import DemoClock
from .storage import Storage

_PBKDF2_ITERATIONS = 200_000


@dataclass(frozen=True)
class Account:
    username: str
    salt: str
    pwd_hash: str
    created_at: int


def hash_password(password: str, salt: bytes | None = None) -> tuple[str, str]:
    if salt is None:
        salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, _PBKDF2_ITERATIONS
    )
    return salt.hex(), digest.hex()


class AccountStore:
    def __init__(self, storage: Storage, clock: DemoClock) -> None:
        self._storage = storage
        self._clock = clock

    def create(self, username: str, password: str) -> None:
        salt_hex, hash_hex = hash_password(password)
        with self._storage.lock:
            self._storage.conn.execute(
                "INSERT INTO accounts(username, salt, pwd_hash, created_at) "
                "VALUES(?, ?, ?, ?)",
                (username, salt_hex, hash_hex, self._clock.now()),
            )
            self._storage.conn.commit()

    def get(self, username: str) -> Account | None:
        row = self._storage.conn.execute(
            "SELECT username, salt, pwd_hash, created_at FROM accounts WHERE username = ?",
            (username,),
        ).fetchone()
        if row is None:
            return None
        return Account(**dict(row))

    def verify(self, account: Account, password: str) -> bool:
        _, candidate = hash_password(password, bytes.fromhex(account.salt))
        # 恒定时间比较，避免通过响应耗时区分账号是否存在 / 密码是否正确
        return hmac.compare_digest(candidate, account.pwd_hash)

    def list_usernames(self) -> list[str]:
        rows = self._storage.conn.execute("SELECT username FROM accounts ORDER BY username").fetchall()
        return [r["username"] for r in rows]

    def count(self) -> int:
        return int(self._storage.conn.execute("SELECT COUNT(*) AS n FROM accounts").fetchone()["n"])
