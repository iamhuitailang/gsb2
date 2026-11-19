"""口令与令牌相关工具，仅使用 Python 标准库。"""

from __future__ import annotations

import hashlib
import hmac
import secrets

PBKDF2_ITERATIONS = 200_000
_ALGORITHM = "pbkdf2_sha256"


def hash_password(password: str, *, salt: bytes | None = None) -> str:
    """生成 ``pbkdf2_sha256$迭代次数$盐$摘要`` 格式的密码串。"""
    if not isinstance(password, str) or not password:
        raise ValueError("密码不能为空")
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS
    )
    return f"{_ALGORITHM}${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations, salt_hex, digest_hex = encoded.split("$", 3)
        if algorithm != _ALGORITHM:
            return False
        expected = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            bytes.fromhex(salt_hex),
            int(iterations),
        )
        return hmac.compare_digest(expected, bytes.fromhex(digest_hex))
    except (ValueError, TypeError):
        return False


def new_session_token() -> str:
    return secrets.token_urlsafe(32)
