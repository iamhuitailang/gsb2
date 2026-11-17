"""Canonical serialisation, hashing and sensitive-value redaction.

Every audit value passes through :func:`redact` before it is hashed or
persisted, so credentials cannot become part of an audit record even if a
caller accidentally supplies them.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Any

GENESIS_HASH = "0" * 64

#: Fields of an audit record that make up its content (everything that is
#: hashed into ``payload_digest``).
PAYLOAD_FIELDS = (
    "audit_id",
    "org_id",
    "seq",
    "created_at",
    "action",
    "outcome",
    "actor",
    "target",
    "role",
    "changes",
    "rule_set",
    "reason",
    "detail",
)

_SENSITIVE_KEY_RE = re.compile(
    r"(?i)(?:^|_)(?:password|passwd|pwd|secret|token|api_?key|authorization|"
    r"cookie|session(?:_id)?|credential|private_?key|salt|passphrase)(?:$|_)"
)

# ``password=hunter2``, ``token: abc``, ``api_key = "..."`` -> redacted value.
# The negative lookahead keeps already-redacted values from matching again,
# which lets :func:`contains_sensitive` be used as a post-redaction guard.
_CREDENTIAL_ASSIGN_RE = re.compile(
    r"(?i)\b(password|passwd|pwd|secret|token|api[_-]?key|authorization|"
    r"credential|passphrase)\b(\s*[=:]\s*)"
    r"(?!\[REDACTED\])(\"[^\"]*\"|'[^']*'|\S+)"
)
_BEARER_RE = re.compile(
    r"(?i)\bbearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]+"
)
_JWT_RE = re.compile(
    r"\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b"
)
_REDACTED = "[REDACTED]"


def utc_now_iso() -> str:
    """Current UTC time in a stable, sortable representation."""
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="microseconds")
        .replace("+00:00", "Z")
    )


def canonical_json(value: Any) -> str:
    """Deterministic JSON used for every digest in the system."""
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def sha256_hex(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def scrub_text(text: str) -> str:
    text = _CREDENTIAL_ASSIGN_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}{_REDACTED}", text)
    text = _BEARER_RE.sub(f"Bearer {_REDACTED}", text)
    text = _JWT_RE.sub(_REDACTED, text)
    return text


def redact(value: Any) -> Any:
    """Recursively remove credentials from an audit value."""
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            if _SENSITIVE_KEY_RE.search(key_text):
                cleaned[key_text] = _REDACTED
            else:
                cleaned[key_text] = redact(item)
        return cleaned
    if isinstance(value, (list, tuple)):
        return [redact(item) for item in value]
    if isinstance(value, str):
        return scrub_text(value)
    return value


def contains_sensitive(value: Any) -> bool:
    """True if a value still has a credential-shaped key or string.

    A credential-shaped key whose value is already :data:`_REDACTED` (or
    empty) is not a leak; that is exactly what :func:`redact` produces.  This
    lets the function double as a post-redaction guard.
    """
    if isinstance(value, dict):
        for key, item in value.items():
            if _SENSITIVE_KEY_RE.search(str(key)):
                if item not in (_REDACTED, None, ""):
                    return True
            if contains_sensitive(item):
                return True
        return False
    if isinstance(value, (list, tuple)):
        return any(contains_sensitive(item) for item in value)
    if isinstance(value, str):
        return bool(
            _CREDENTIAL_ASSIGN_RE.search(value)
            or _BEARER_RE.search(value)
            or _JWT_RE.search(value)
        )
    return False


def payload_digest(payload: dict[str, Any]) -> str:
    return sha256_hex(canonical_json(payload).encode("utf-8"))


def record_hash(prev_hash: str, digest: str) -> str:
    return sha256_hex(f"{prev_hash}\n{digest}".encode("utf-8"))


def payload_from_record(record: dict[str, Any]) -> dict[str, Any]:
    """Extract the canonical content fields from an audit row/bundle record."""
    return {field: record.get(field) for field in PAYLOAD_FIELDS}
