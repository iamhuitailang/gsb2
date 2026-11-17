"""TOTP 与一次性备用码的原语，只依赖 Python 标准库。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
import urllib.parse

TOTP_DIGITS = 6
TOTP_PERIOD = 30
TOTP_WINDOW = 1

BACKUP_CODE_LENGTH = 10
BACKUP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def generate_totp_secret() -> str:
    """生成 160 位、无填充的 base32 密钥。"""
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def _decode_secret(secret: str) -> bytes:
    cleaned = "".join((secret or "").split()).upper()
    cleaned = cleaned.rstrip("=")
    if not cleaned:
        raise ValueError("密钥为空")
    padding = "=" * (-len(cleaned) % 8)
    return base64.b32decode(cleaned + padding, casefold=True)


def _hotp(key: bytes, counter: int, digits: int = TOTP_DIGITS) -> str:
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return f"{value % (10 ** digits):0{digits}d}"


def totp_code(
    secret: str,
    timestamp: float | None = None,
    *,
    digits: int = TOTP_DIGITS,
    period: int = TOTP_PERIOD,
) -> str:
    moment = time.time() if timestamp is None else timestamp
    try:
        key = _decode_secret(secret)
    except (ValueError, TypeError):
        return ""
    return _hotp(key, int(moment // period), digits)


def verify_totp(
    secret: str,
    code: str,
    timestamp: float | None = None,
    *,
    digits: int = TOTP_DIGITS,
    period: int = TOTP_PERIOD,
    window: int = TOTP_WINDOW,
) -> bool:
    if not secret:
        return False
    cleaned = "".join((code or "").split())
    if len(cleaned) != digits or not cleaned.isdigit():
        return False
    try:
        key = _decode_secret(secret)
    except (ValueError, TypeError):
        return False
    moment = time.time() if timestamp is None else timestamp
    step = int(moment // period)
    for delta in range(-window, window + 1):
        if hmac.compare_digest(_hotp(key, step + delta, digits), cleaned):
            return True
    return False


def provisioning_uri(secret: str, account: str, issuer: str = "GSB2") -> str:
    label = urllib.parse.quote(f"{issuer}:{account}", safe="")
    query = urllib.parse.urlencode(
        {
            "secret": secret,
            "issuer": issuer,
            "algorithm": "SHA1",
            "digits": TOTP_DIGITS,
            "period": TOTP_PERIOD,
        }
    )
    return f"otpauth://totp/{label}?{query}"


def generate_backup_code() -> str:
    raw = "".join(secrets.choice(BACKUP_ALPHABET) for _ in range(BACKUP_CODE_LENGTH))
    return f"{raw[:5]}-{raw[5:]}"


def normalize_backup_code(code: str) -> str:
    """只保留备用码字符集里的字母数字，忽略连字符/空格/大小写。"""
    return "".join(
        ch for ch in (code or "").upper() if ch.isascii() and ch.isalnum() and ch in BACKUP_ALPHABET
    )


def hash_backup_code(code: str, key: bytes) -> str:
    """用服务端密钥做 HMAC；数据库里只放这个摘要。"""
    normalized = normalize_backup_code(code)
    return hmac.new(key, normalized.encode("utf-8"), hashlib.sha256).hexdigest()
