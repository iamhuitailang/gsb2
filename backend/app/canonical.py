"""Canonicalization utilities for the local signature console."""

import hashlib
import re
from dataclasses import dataclass
from urllib.parse import parse_qsl, quote, unquote

SCHEME = "HMAC-SHA256-V1"
EMPTY_BODY_SHA256 = hashlib.sha256(b"").hexdigest()

_METHOD_RE = re.compile(r"^[A-Z0-9-]{1,16}$")
_TIMESTAMP_RE = re.compile(r"^[0-9]{1,12}$")
_NONCE_RE = re.compile(r"^[\x21-\x7e]{8,64}$")
_KEY_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_PATH_SAFE = "/-._~"
_QUERY_SAFE = "-._~"
_ESCAPED_SLASH_RE = re.compile(r"%2f", re.IGNORECASE)
# A "%" that is not the start of a valid %XX escape.  Such a byte would be
# ambiguous (left literal by some decoders, rejected by others), so it must be
# written as %25 explicitly.
_INVALID_ESCAPE_RE = re.compile(r"%(?![0-9A-Fa-f]{2})")


class CanonicalError(ValueError):
    """Raised when a request cannot be normalized into the canonical form."""


@dataclass(frozen=True)
class CanonicalRequest:
    method: str
    path: str
    query: str
    timestamp: int
    nonce: str
    key_id: str
    body_sha256: str
    canonical_string: str


def _normalize_method(raw):
    if not isinstance(raw, str):
        raise CanonicalError("method 必须是字符串")
    method = raw.strip().upper()
    if not _METHOD_RE.fullmatch(method):
        raise CanonicalError("method 必须是 1-16 位 ASCII 字母、数字或连字符（不支持空白）")
    return method


def _normalize_path(raw):
    if not isinstance(raw, str):
        raise CanonicalError("path 必须是字符串")
    path = raw
    if not path:
        raise CanonicalError("path 不能为空")
    if "://" in path or path.startswith("//"):
        raise CanonicalError("path 只接受 URL 路径部分，不接受完整 URL")
    if "?" in path or "#" in path:
        raise CanonicalError("path 不能包含查询串或片段，请把参数放到 query 字段")
    if _ESCAPED_SLASH_RE.search(path):
        raise CanonicalError("path 中不允许百分号编码的斜杠（%2F）")
    if _INVALID_ESCAPE_RE.search(path):
        raise CanonicalError("path 中有无效的百分号转义，字面 % 请写成 %25")

    encoded_path = path[1:] if path.startswith("/") else path
    try:
        decoded = unquote(encoded_path, encoding="utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise CanonicalError("path 的百分号编码不是合法的 UTF-8") from exc
    if not decoded:
        return "/"
    if decoded.startswith("/") or "//" in decoded:
        raise CanonicalError("path 不能包含多余的斜杠或空路径段")
    if decoded.endswith("/"):
        # A trailing slash is an empty final segment, and HTTP clients that
        # follow a slash redirect would then sign a different path.  Reject it
        # so the rule is explicit rather than silently normalised away.
        raise CanonicalError("path 不能以斜杠结尾（根路径 / 除外）")
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in decoded):
        raise CanonicalError("path 不能包含控制字符")

    canonical = quote(decoded, safe=_PATH_SAFE, encoding="utf-8", errors="strict")
    if len(canonical) > 512:
        raise CanonicalError("path 规范化后不能超过 512 个字符")
    return "/" + canonical


def _normalize_query(raw):
    if raw is None:
        return ""
    if not isinstance(raw, str):
        raise CanonicalError("query 必须是字符串")
    # Only the optional "?" prefix is structural; whitespace inside values is
    # meaningful (and percent-encoded), so the string is never trimmed.
    query = raw[1:] if raw.startswith("?") else raw
    if not query:
        return ""
    if "#" in query:
        raise CanonicalError("query 不能包含片段（#）")
    if ";" in query:
        # Some clients and server stacks also treat ";" as a pair separator;
        # requiring %3B removes any ambiguity about how a value is split.
        raise CanonicalError("query 中不允许裸分号（;），请写成 %3B")
    if _INVALID_ESCAPE_RE.search(query):
        raise CanonicalError("query 中有无效的百分号转义，字面 % 请写成 %25")
    try:
        pairs = parse_qsl(
            query,
            keep_blank_values=True,
            strict_parsing=False,
            encoding="utf-8",
            errors="strict",
            separator="&",
        )
    except (UnicodeDecodeError, ValueError) as exc:
        raise CanonicalError("query 的百分号编码不是合法的 UTF-8") from exc

    normalized = []
    for name, value in pairs:
        # parse_qsl yields ("", "") for a completely empty segment such as the
        # trailing "&" in "a=1&" or the "&&" in "a=1&&b=2"; those carry no
        # information and are dropped.  An empty *name* with a real value
        # (e.g. "=x") is ambiguous and rejected.
        if not name and not value:
            continue
        if not name or not name.strip():
            raise CanonicalError("query 参数名不能为空或只包含空白")
        normalized.append(
            (
                quote(name, safe=_QUERY_SAFE, encoding="utf-8", errors="strict"),
                quote(value, safe=_QUERY_SAFE, encoding="utf-8", errors="strict"),
            )
        )
    normalized.sort()
    result = "&".join(f"{name}={value}" for name, value in normalized)
    if len(result) > 2048:
        raise CanonicalError("query 规范化后不能超过 2048 个字符")
    return result


def _parse_timestamp(raw):
    if isinstance(raw, bool):
        raise CanonicalError("timestamp 必须是整数秒")
    if isinstance(raw, int):
        value = raw
    else:
        text = str(raw)
        if not _TIMESTAMP_RE.fullmatch(text):
            raise CanonicalError("timestamp 必须是十进制整数秒（不接受毫秒、浮点或空白）")
        value = int(text)
    if value < 0:
        raise CanonicalError("timestamp 不能为负数")
    return value


def _validate_nonce(raw):
    if not isinstance(raw, str):
        raise CanonicalError("nonce 必须是字符串")
    if not _NONCE_RE.fullmatch(raw):
        raise CanonicalError("nonce 必须是 8-64 个可见 ASCII 字符，且不含空白")
    return raw


def _validate_key_id(raw):
    if not isinstance(raw, str):
        raise CanonicalError("key_id 必须是字符串")
    if not _KEY_ID_RE.fullmatch(raw):
        raise CanonicalError("key_id 格式不合法")
    return raw


def body_sha256(body):
    if not isinstance(body, bytes):
        raise CanonicalError("body 必须是原始字节")
    return hashlib.sha256(body).hexdigest()


def build_canonical(*, method, path, query, timestamp, nonce, key_id, body=b""):
    method_n = _normalize_method(method)
    path_n = _normalize_path(path)
    query_n = _normalize_query(query)
    timestamp_n = _parse_timestamp(timestamp)
    nonce_n = _validate_nonce(nonce)
    key_id_n = _validate_key_id(key_id)
    body_hash = body_sha256(body)

    canonical_string = "\n".join(
        [
            SCHEME,
            f"METHOD:{method_n}",
            f"PATH:{path_n}",
            f"QUERY:{query_n}",
            f"TIMESTAMP:{timestamp_n}",
            f"NONCE:{nonce_n}",
            f"KEY-ID:{key_id_n}",
            f"BODY-SHA256:{body_hash}",
        ]
    )
    return CanonicalRequest(
        method=method_n,
        path=path_n,
        query=query_n,
        timestamp=timestamp_n,
        nonce=nonce_n,
        key_id=key_id_n,
        body_sha256=body_hash,
        canonical_string=canonical_string,
    )
