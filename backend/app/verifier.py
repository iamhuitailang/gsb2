"""Signature generation and verification.

Verification order is fixed:

1. required signing headers (a plain unsigned request is not "malformed")
2. canonicalisation (malformed input -> 400)
3. key id lookup and key status (retired keys never reach HMAC work)
4. timestamp window
5. HMAC-SHA256 over the canonical string, constant-time comparison
6. atomic nonce reservation in SQLite (only after the signature is valid)

Every outcome writes exactly one audit row. Secrets and full signatures never
reach logs or the audit table.
"""

from __future__ import annotations

import hmac
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .audit import AuditStore, VerificationContext
from .canonical import CanonicalError, build_canonical, body_sha256
from .config import KeyRecord, Settings, iso_utc, utc_now

SIGNATURE_HEX_LEN = 64
logger = logging.getLogger("sign_tool.verify")


class VerificationError(Exception):
    def __init__(self, code: str, detail: str, status: int = 401, audit_id: int | None = None) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status = status
        self.audit_id = audit_id


@dataclass
class PreparedRequest:
    method: str
    path: str
    query: str
    timestamp: str | int | None
    nonce: str
    key_id: str | None
    signature: str
    body: bytes
    source: str
    request_id: str = ""

    def with_request_id(self) -> "PreparedRequest":
        if not self.request_id:
            self.request_id = "local-" + uuid.uuid4().hex[:12]
        return self


@dataclass
class VerificationResult:
    canonical_string: str
    key_id: str
    key_status: str
    signature_ok: bool
    audit_id: int
    accepted: bool


def compute_signature(secret: str, canonical_string: str) -> str:
    return hmac.new(secret.encode("utf-8"), canonical_string.encode("utf-8"), "sha256").hexdigest()


def _context(prepared: PreparedRequest, *, key: KeyRecord | None, key_status: str | None) -> VerificationContext:
    try:
        ts_value: int | None = (
            int(str(prepared.timestamp).strip())
            if prepared.timestamp not in (None, "")
            else None
        )
    except (TypeError, ValueError):
        ts_value = None

    return VerificationContext(
        request_id=prepared.request_id,
        source=prepared.source,
        method=_printable(prepared.method, 32),
        path=_printable(prepared.path, 512),
        query=_printable(prepared.query, 2048),
        key_id=(key.key_id if key else prepared.key_id) or None,
        key_status=key_status,
        timestamp=ts_value,
        nonce=prepared.nonce or "-",
        signature=prepared.signature or "",
        body_sha256=body_sha256(prepared.body),
        body_bytes=len(prepared.body),
    )


def _printable(value: Any, limit: int) -> str:
    """Bounded single-line text for the audit context.

    Non-control Unicode is preserved (paths may contain Chinese); only C0
    controls and DEL are dropped.  The audit layer applies its own bound.
    """
    if not isinstance(value, str):
        return "-"
    clean = "".join(ch for ch in value if ord(ch) >= 0x20 and ord(ch) != 0x7F)
    return clean[:limit] or "-"


def verify_request(
    settings: Settings,
    prepared: PreparedRequest,
    store: AuditStore,
    *,
    now: datetime | None = None,
    clock: float | None = None,
) -> VerificationResult:
    prepared.with_request_id()
    now_dt = now or utc_now()
    now_ts = clock if clock is not None else now_dt.timestamp()

    key: KeyRecord | None = None
    key_status: str | None = None

    def reject(code: str, detail: str, status: int = 401) -> VerificationError:
        ctx = _context(prepared, key=key, key_status=key_status)
        audit_id = store.reject(
            ctx,
            reason_code=code,
            reason_detail=detail,
            now=now_ts,
        )
        logger.warning(
            "request_id=%s decision=rejected reason=%s key_id=%s path=%s",
            prepared.request_id,
            code,
            ctx.key_id or "-",
            ctx.path,
        )
        return VerificationError(code, detail, status, audit_id)

    # 1. Required headers.  A plain unsigned curl/browser request is the
    # common case; it gets its own reason instead of "malformed".
    missing = [
        name
        for name, value in (
            ("X-Key-Id", prepared.key_id),
            ("X-Timestamp", prepared.timestamp),
            ("X-Nonce", prepared.nonce),
            ("X-Signature", prepared.signature),
        )
        if value in (None, "")
    ]
    if missing:
        raise reject(
            "missing_signature",
            "请求缺少签名头：" + ", ".join(missing),
        )

    # 2. Canonicalisation.
    try:
        canonical = build_canonical(
            method=prepared.method,
            path=prepared.path,
            query=prepared.query,
            timestamp=prepared.timestamp,
            nonce=prepared.nonce,
            key_id=prepared.key_id or "",
            body=prepared.body,
        )
    except CanonicalError as exc:
        raise reject("malformed_request", str(exc), status=400) from exc

    # 3. Key lookup and rotation state.
    key = settings.key_by_id(canonical.key_id)
    if key is None:
        raise reject("unknown_key_id", "key_id 未在本地配置中登记")
    key_status = key.effective_status(now_dt)
    if key_status == "retired":
        raise reject("retired_key", "该密钥已结束轮换，不再接受请求")
    if key_status not in {"active", "grace"}:
        raise reject("key_not_usable", "该密钥当前不可用于验签")

    # 4. Timestamp window.
    age = now_ts - canonical.timestamp
    if age > settings.time_window_seconds:
        raise reject(
            "timestamp_expired",
            f"请求时间戳超出允许窗口（{settings.time_window_seconds} 秒）",
        )
    if canonical.timestamp - now_ts > settings.future_skew_seconds:
        raise reject(
            "timestamp_in_future",
            f"请求时间戳超前于服务器时间超过 {settings.future_skew_seconds} 秒",
        )

    # 5. Signature.
    provided = prepared.signature.strip()
    if len(provided) != SIGNATURE_HEX_LEN or any(
        ch not in "0123456789abcdefABCDEF" for ch in provided
    ):
        raise reject(
            "malformed_signature",
            "签名必须是 64 位十六进制 HMAC-SHA256 值",
            status=400,
        )

    expected = compute_signature(key.secret, canonical.canonical_string)
    if not hmac.compare_digest(expected, provided.lower()):
        raise reject("signature_mismatch", "HMAC 签名不匹配")

    # 6. Nonce reservation.  The signature check above runs before the nonce
    # table is touched, so an attacker who cannot forge a signature also
    # cannot consume a victim's nonce.
    ctx = _context(prepared, key=key, key_status=key_status)
    audit_row, accepted = store.accept(
        ctx, nonce_retention_seconds=settings.nonce_retention_seconds, now=now_ts
    )
    audit_id = int(audit_row["id"])
    if not accepted:
        logger.warning(
            "request_id=%s decision=rejected reason=nonce_replayed key_id=%s audit_id=%s",
            prepared.request_id,
            key.key_id,
            audit_id,
        )
        raise VerificationError(
            "nonce_replayed", "该 nonce 已被使用，拒绝重放", status=409, audit_id=audit_id
        )

    logger.info(
        "request_id=%s decision=accepted key_id=%s key_status=%s path=%s",
        prepared.request_id,
        key.key_id,
        key_status,
        canonical.path,
    )
    return VerificationResult(
        canonical_string=canonical.canonical_string,
        key_id=key.key_id,
        key_status=key_status,
        signature_ok=True,
        audit_id=audit_id,
        accepted=True,
    )


def reject_precheck(
    prepared: PreparedRequest,
    store: AuditStore,
    *,
    code: str,
    detail: str,
    status: int,
    now: datetime | None = None,
) -> VerificationError:
    """Reject a request before canonicalisation, still writing an audit row.

    Used for checks the transport layer must perform first (for example an
    oversized body).  It mirrors the normal rejection path so every refusal
    has a traceable audit id and a log line without any sensitive payload.
    """
    prepared.with_request_id()
    now_dt = now or utc_now()
    ctx = _context(prepared, key=None, key_status=None)
    audit_id = store.reject(
        ctx,
        reason_code=code,
        reason_detail=detail,
        now=now_dt.timestamp(),
    )
    logger.warning(
        "request_id=%s decision=rejected reason=%s key_id=%s path=%s",
        prepared.request_id,
        code,
        ctx.key_id or "-",
        ctx.path,
    )
    return VerificationError(code, detail, status, audit_id)


def key_public_view(settings: Settings, now: datetime | None = None) -> dict[str, Any]:
    """Key metadata safe for the browser: ids, statuses and timing only."""
    now_dt = now or utc_now()
    active = settings.active_key(now_dt)
    return {
        "active_key_id": active.key_id if active else None,
        "keys": settings.public_key_summary(now_dt),
        "time_window_seconds": settings.time_window_seconds,
        "future_skew_seconds": settings.future_skew_seconds,
        "nonce_retention_seconds": settings.nonce_retention_seconds,
        "server_time": iso_utc(now_dt),
    }
