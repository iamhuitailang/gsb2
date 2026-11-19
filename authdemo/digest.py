"""Versioned password digest schemes.

Stored digests are self-describing strings:

  v1:<md5_hex>                            legacy, unsalted MD5 (weakest)
  v2:<salt_hex>:<sha256_hex>              legacy, salted SHA-256
  v3:<iterations>:<salt_hex>:<hex>        current, PBKDF2-HMAC-SHA256

Only v3 is produced for new/updated digests. v1/v2 exist so imported
legacy accounts can still log in; they are upgraded to v3 on first
successful login.
"""

import hashlib
import hmac
import secrets

CURRENT_VERSION = 3
# Demo-scale iteration count: fast enough for tests, still a real KDF.
PBKDF2_ITERATIONS = 60_000
_PBKDF2_DKLEN = 32


class DigestError(ValueError):
    """A stored digest is malformed or internally inconsistent."""


class UnknownVersionError(DigestError):
    """The digest version tag is not one this build understands."""


def _md5_hex(data: bytes) -> str:
    try:
        return hashlib.md5(data, usedforsecurity=False).hexdigest()
    except TypeError:  # very old Pythons lack the keyword
        return hashlib.md5(data).hexdigest()


def hash_v1(password: str) -> str:
    return "v1:" + _md5_hex(password.encode("utf-8"))


def hash_v2(password: str, salt_hex: str | None = None) -> str:
    salt_hex = salt_hex or secrets.token_hex(8)
    digest = hashlib.sha256((salt_hex + password).encode("utf-8")).hexdigest()
    return f"v2:{salt_hex}:{digest}"


def hash_current(password: str, iterations: int = PBKDF2_ITERATIONS) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, iterations, dklen=_PBKDF2_DKLEN
    )
    return f"v3:{iterations}:{salt.hex()}:{dk.hex()}"


def _fromhex(field: str) -> bytes:
    try:
        return bytes.fromhex(field)
    except (ValueError, AttributeError):
        raise DigestError("non-hex field in digest") from None


def parse(stored: str) -> tuple[int, list[str]]:
    """Validate a stored digest string, returning (version, parts).

    Raises UnknownVersionError for unrecognised tags and DigestError for
    malformed content. Never raises any other exception.
    """
    if not isinstance(stored, str) or not stored:
        raise DigestError("digest is empty or not a string")
    parts = stored.split(":")
    tag = parts[0]
    if tag == "v1":
        if len(parts) != 2 or len(_fromhex(parts[1])) != 16:
            raise DigestError("malformed v1 digest")
        return 1, parts
    if tag == "v2":
        if len(parts) != 3:
            raise DigestError("malformed v2 digest")
        salt = _fromhex(parts[1])
        if not salt or len(_fromhex(parts[2])) != 32:
            raise DigestError("malformed v2 digest")
        return 2, parts
    if tag == "v3":
        if len(parts) != 4:
            raise DigestError("malformed v3 digest")
        try:
            iterations = int(parts[1])
        except ValueError:
            raise DigestError("bad iteration count") from None
        if not (1 <= iterations <= 10_000_000):
            raise DigestError("iteration count out of range")
        salt = _fromhex(parts[2])
        if not salt or len(_fromhex(parts[3])) != _PBKDF2_DKLEN:
            raise DigestError("malformed v3 digest")
        return 3, parts
    if tag.startswith("v") and tag[1:].isdigit():
        raise UnknownVersionError(f"unsupported digest version {tag}")
    raise DigestError("unrecognised digest format")


def version_of(stored: str) -> int:
    return parse(stored)[0]


def verify(stored: str, password: str) -> bool:
    """Check password against a stored digest. Raises DigestError on
    unknown/malformed formats — callers must treat that as a failed login,
    never as a pass."""
    version, parts = parse(stored)
    pw = password.encode("utf-8")
    if version == 1:
        candidate = _md5_hex(pw)
        expected = parts[1]
    elif version == 2:
        candidate = hashlib.sha256((parts[1] + password).encode("utf-8")).hexdigest()
        expected = parts[2]
    else:  # version == 3
        dk = hashlib.pbkdf2_hmac(
            "sha256", pw, bytes.fromhex(parts[2]), int(parts[1]), dklen=_PBKDF2_DKLEN
        )
        candidate = dk.hex()
        expected = parts[3]
    return hmac.compare_digest(candidate, expected.lower())
