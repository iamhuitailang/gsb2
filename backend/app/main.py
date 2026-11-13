"""FastAPI application: local signature console and demo verification endpoints.

The API is intentionally local-only.  It never calls out to a real business
service; the "demo" endpoints just echo back what was verified.
"""

from __future__ import annotations

import json
import logging
import logging.config
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import APIRouter, FastAPI, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import samples
from .audit import AuditStore
from .canonical import SCHEME, CanonicalError, build_canonical
from .config import ConfigError, Settings, iso_utc, load_settings, utc_now
from .verifier import (
    PreparedRequest,
    VerificationError,
    compute_signature,
    key_public_view,
    reject_precheck,
    verify_request,
)

logger = logging.getLogger("sign_tool.api")
SIGNATURE_HEADER = "X-Signature"
TIMESTAMP_HEADER = "X-Timestamp"
NONCE_HEADER = "X-Nonce"
KEY_ID_HEADER = "X-Key-Id"
MAX_BODY_BYTES = 64 * 1024
FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"

REASON_TEXT = {
    "accepted": "请求通过验签",
    "missing_signature": "缺少签名请求头",
    "malformed_request": "请求字段不符合规范化规则",
    "unknown_key_id": "密钥 ID 未登记",
    "retired_key": "密钥已退役",
    "key_not_usable": "密钥当前不可用",
    "timestamp_expired": "时间戳超出窗口",
    "timestamp_in_future": "时间戳超前过多",
    "malformed_signature": "签名格式不合法",
    "signature_mismatch": "签名不匹配",
    "nonce_replayed": "nonce 重放",
    "body_too_large": "请求体超过上限",
}


def configure_logging() -> None:
    logging.config.dictConfig(
        {
            "version": 1,
            "disable_existing_loggers": False,
            "formatters": {
                "default": {
                    "format": "%(asctime)s %(levelname)s %(name)s %(message)s"
                }
            },
            "handlers": {
                "console": {
                    "class": "logging.StreamHandler",
                    "formatter": "default",
                    "stream": "ext://sys.stdout",
                }
            },
            "loggers": {
                "sign_tool": {"level": os.environ.get("SIGN_TOOL_LOG_LEVEL", "INFO"), "handlers": ["console"]},
                "uvicorn.access": {"level": "WARNING"},
            },
            "root": {"level": "WARNING", "handlers": ["console"]},
        }
    )


class AppState:
    settings: Settings
    store: AuditStore


state = AppState()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    configure_logging()
    try:
        state.settings = load_settings()
    except ConfigError as exc:
        # Surface the actionable message instead of only a startup traceback.
        logger.error("本地配置加载失败：%s", exc)
        raise
    state.store = AuditStore(state.settings.database_path)
    active = state.settings.active_key(utc_now())
    logger.info(
        "signing console ready scheme=%s active_key_id=%s database=%s",
        SCHEME,
        active.key_id if active else "-",
        state.settings.database_path,
    )
    yield


app = FastAPI(title="Local Signature Console", lifespan=lifespan)
api = APIRouter(prefix="/api")


def get_state() -> AppState:
    if not hasattr(state, "settings"):
        # Allows unit tests to call verify_request without the lifespan running.
        raise RuntimeError("应用尚未初始化本地配置")
    return state


@app.exception_handler(ConfigError)
async def config_error_handler(_: Request, exc: ConfigError) -> JSONResponse:
    logger.error("配置错误：%s", exc)
    return JSONResponse({"detail": str(exc), "code": "config_error"}, status_code=500)


@app.exception_handler(VerificationError)
async def verification_error_handler(_: Request, exc: VerificationError) -> JSONResponse:
    return JSONResponse(
        {
            "accepted": False,
            "code": exc.code,
            "detail": exc.detail,
            "reason_text": REASON_TEXT.get(exc.code, "验签失败"),
            "audit_id": exc.audit_id,
        },
        status_code=exc.status,
    )


# ---------------------------------------------------------------------------
# Signing helpers exposed to the console.  These build a signature for a given
# key id; secret values are read from local config and never returned.
# ---------------------------------------------------------------------------


class CanonicalPreviewRequest(BaseModel):
    method: str = Field(default="POST", max_length=32)
    path: str = Field(default="/api/demo/echo", max_length=1024)
    query: str = Field(default="", max_length=4096)
    timestamp: int = Field(ge=0, le=99_999_999_999)
    nonce: str = Field(min_length=8, max_length=64)
    key_id: str = Field(min_length=1, max_length=64)
    body: str = Field(default="", max_length=MAX_BODY_BYTES)


@api.post("/canonical")
async def preview_canonical(payload: CanonicalPreviewRequest) -> dict[str, Any]:
    try:
        canonical = build_canonical(
            method=payload.method,
            path=payload.path,
            query=payload.query,
            timestamp=payload.timestamp,
            nonce=payload.nonce,
            key_id=payload.key_id,
            body=payload.body.encode("utf-8"),
        )
    except CanonicalError as exc:
        return JSONResponse(
            {"ok": False, "detail": str(exc)},
            status_code=400,
        )
    return {"ok": True, "canonical_string": canonical.canonical_string}


class SignRequest(BaseModel):
    method: str = Field(default="POST", max_length=32)
    path: str = Field(default="/api/demo/echo", max_length=1024)
    query: str = Field(default="", max_length=4096)
    timestamp: int | None = None
    nonce: str | None = Field(default=None, max_length=64)
    key_id: str | None = Field(default=None, max_length=64)
    body: str = Field(default="", max_length=MAX_BODY_BYTES)


@api.post("/sign")
async def sign(payload: SignRequest) -> dict[str, Any]:
    settings: Settings = get_state().settings
    now = utc_now()
    timestamp = payload.timestamp if payload.timestamp is not None else int(now.timestamp())
    nonce = payload.nonce or samples.new_nonce()
    key = settings.key_by_id(payload.key_id) if payload.key_id else settings.active_key(now)
    if key is None:
        return JSONResponse(
            {"ok": False, "code": "unknown_key_id", "detail": "指定的 key_id 不存在"},
            status_code=400,
        )
    status = key.effective_status(now)
    if status == "retired":
        return JSONResponse(
            {"ok": False, "code": "retired_key", "detail": "该密钥已退役，不能用于生成签名"},
            status_code=400,
        )
    try:
        canonical = build_canonical(
            method=payload.method,
            path=payload.path,
            query=payload.query,
            timestamp=timestamp,
            nonce=nonce,
            key_id=key.key_id,
            body=payload.body.encode("utf-8"),
        )
    except CanonicalError as exc:
        return JSONResponse({"ok": False, "code": "malformed_request", "detail": str(exc)}, status_code=400)

    signature = compute_signature(key.secret, canonical.canonical_string)
    return {
        "ok": True,
        "scheme": SCHEME,
        "canonical_string": canonical.canonical_string,
        "headers": {
            "X-Key-Id": key.key_id,
            "X-Timestamp": str(canonical.timestamp),
            "X-Nonce": canonical.nonce,
            "X-Signature": signature,
        },
        "key_status": status,
        "body_sha256": canonical.body_sha256,
    }


@api.get("/meta")
async def meta() -> dict[str, Any]:
    settings = get_state().settings
    view = key_public_view(settings)
    view.update(
        {
            "scheme": SCHEME,
            "signature_header": SIGNATURE_HEADER,
            "timestamp_header": TIMESTAMP_HEADER,
            "nonce_header": NONCE_HEADER,
            "key_id_header": KEY_ID_HEADER,
            "reason_text": REASON_TEXT,
        }
    )
    return view


@api.get("/samples")
async def get_samples() -> dict[str, Any]:
    return {"samples": samples.build_samples(get_state().settings)}


# ---------------------------------------------------------------------------
# Demo verification endpoints.  These behave like a minimal local API surface
# that a real client could be pointed at during interface debugging.
# ---------------------------------------------------------------------------


async def _verified_payload(request: Request, source: str) -> bytes:
    # Read first, then enforce the size cap, so the audit row can record the
    # real body size and hash (never the contents).  The cap is a sanity limit
    # for a local-only tool, not a defence against hostile internet traffic.
    body = await request.body()
    if len(body) > MAX_BODY_BYTES:
        prepared = _prepared_from_request(request, body, source)
        error = await run_in_threadpool(_reject_oversize, prepared)
        raise error
    return body


def _reject_oversize(prepared: PreparedRequest) -> VerificationError:
    return reject_precheck(
        prepared,
        get_state().store,
        code="body_too_large",
        detail=f"请求体超过 {MAX_BODY_BYTES} 字节上限，未参与验签",
        status=413,
    )


def _raw_path(request: Request) -> str:
    """Return the request path exactly as it appeared on the wire.

    ASGI exposes the percent-encoded path in ``scope["raw_path"]`` (bytes) and
    the decoded path in ``scope["path"]``.  Canonicalisation must start from
    the raw form where available.  Some test transports provide ``raw_path`` as
    a ``str`` instead of ``bytes``; both shapes are accepted.
    """
    raw = request.scope.get("raw_path")
    if isinstance(raw, bytes) and raw:
        # Some ASGI test transports include the query string in raw_path;
        # a real server never does.  Strip it defensively.
        raw = raw.split(b"?", 1)[0]
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            # A non-conforming client sent raw non-ASCII bytes; latin-1 keeps
            # the bytes recoverable instead of crashing the request.
            return raw.decode("latin-1")
    if isinstance(raw, str) and raw:
        return raw.split("?", 1)[0]
    return request.url.path


def _raw_query(request: Request) -> str:
    """Return the raw (still percent-encoded) query string from the wire."""
    query = request.scope.get("query_string", b"")
    try:
        return query.decode("utf-8")
    except UnicodeDecodeError:
        # Non-conforming client sent raw non-ASCII bytes; latin-1 round-trips
        # them so canonicalisation can still reject or process deterministically.
        return query.decode("latin-1")


def _prepared_from_request(request: Request, body: bytes, source: str) -> PreparedRequest:
    return PreparedRequest(
        method=request.method,
        path=_raw_path(request),
        query=_raw_query(request),
        timestamp=request.headers.get(TIMESTAMP_HEADER),
        nonce=request.headers.get(NONCE_HEADER, ""),
        key_id=request.headers.get(KEY_ID_HEADER),
        signature=request.headers.get(SIGNATURE_HEADER, ""),
        body=body,
        source=source,
    )


@api.get("/demo/ping")
async def demo_ping(request: Request) -> dict[str, Any]:
    body = await _verified_payload(request, "demo-ping")
    prepared = _prepared_from_request(request, body, "demo-ping")
    result = await run_in_threadpool(verify_request, get_state().settings, prepared, get_state().store)
    return {
        "ok": True,
        "message": "pong",
        "key_id": result.key_id,
        "key_status": result.key_status,
        "audit_id": result.audit_id,
        "canonical_string": result.canonical_string,
        "server_time": iso_utc(utc_now()),
    }


@api.get("/demo/echo")
async def demo_echo_get(request: Request) -> dict[str, Any]:
    body = await _verified_payload(request, "demo-echo")
    prepared = _prepared_from_request(request, body, "demo-echo")
    result = await run_in_threadpool(verify_request, get_state().settings, prepared, get_state().store)
    return {
        "ok": True,
        "echo": {"method": request.method, "path": request.url.path, "query": request.url.query},
        "key_id": result.key_id,
        "key_status": result.key_status,
        "audit_id": result.audit_id,
        "canonical_string": result.canonical_string,
    }


@api.post("/demo/echo")
async def demo_echo_post(request: Request) -> dict[str, Any]:
    body = await _verified_payload(request, "demo-echo")
    prepared = _prepared_from_request(request, body, "demo-echo")
    result = await run_in_threadpool(verify_request, get_state().settings, prepared, get_state().store)
    echo_body: Any
    try:
        echo_body = json.loads(body.decode("utf-8")) if body else None
    except (UnicodeDecodeError, ValueError):
        echo_body = {"raw_bytes": len(body), "note": "请求体不是 JSON，仅回显字节数"}
    return {
        "ok": True,
        "echo": echo_body,
        "key_id": result.key_id,
        "key_status": result.key_status,
        "audit_id": result.audit_id,
        "canonical_string": result.canonical_string,
        "body_bytes": len(body),
    }


@api.api_route("/demo/echo", methods=["PUT", "PATCH", "DELETE"])
async def demo_echo_other(request: Request) -> dict[str, Any]:
    """Same verification rules for other verbs, so the console can demo them."""
    body = await _verified_payload(request, "demo-echo")
    prepared = _prepared_from_request(request, body, "demo-echo")
    result = await run_in_threadpool(verify_request, get_state().settings, prepared, get_state().store)
    return {
        "ok": True,
        "echo": {"method": request.method, "path": request.url.path, "query": request.url.query},
        "key_id": result.key_id,
        "key_status": result.key_status,
        "audit_id": result.audit_id,
        "canonical_string": result.canonical_string,
        "body_bytes": len(body),
    }


# ---------------------------------------------------------------------------
# Audit views.
# ---------------------------------------------------------------------------


@api.get("/audit")
async def list_audit(
    limit: int = Query(default=50, ge=1, le=200),
    before_id: int | None = Query(default=None, ge=1),
    decision: str | None = Query(default=None, pattern="^(accepted|rejected)$"),
) -> dict[str, Any]:
    rows, stats = await run_in_threadpool(
        _load_audit, limit, before_id, decision
    )
    return {"events": rows, "stats": stats}


def _load_audit(limit: int, before_id: int | None, decision: str | None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    store = get_state().store
    return store.list_audit(limit=limit, before_id=before_id, decision=decision), store.stats()


@api.get("/audit/export", response_class=PlainTextResponse)
async def export_audit(limit: int = Query(default=200, ge=1, le=200)) -> PlainTextResponse:
    payload = await run_in_threadpool(get_state().store.export_json, limit)
    return PlainTextResponse(
        payload,
        media_type="application/json",
        headers={"Content-Disposition": 'attachment; filename="audit-export.json"'},
    )


app.include_router(api)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "server_time": iso_utc(utc_now())}


# ---------------------------------------------------------------------------
# Static frontend.  Development uses Vite on :5173; this serves the build.
# ---------------------------------------------------------------------------


@app.get("/", response_class=HTMLResponse)
async def index() -> Any:
    index_file = FRONTEND_DIST / "index.html"
    if index_file.is_file():
        return FileResponse(index_file)
    return HTMLResponse(
        "<h1>本地验签控制台</h1>"
        "<p>前端尚未构建。请在 frontend 目录执行 <code>npm install &amp;&amp; npm run build</code>，"
        "或使用 <code>npm run dev</code> 在 5173 端口启动开发服务器。</p>",
        status_code=200,
    )


if (FRONTEND_DIST / "assets").is_dir():
    # Mount the built assets (Vite emits /assets/*).  Mounted after the API
    # router so /api and /health are never shadowed.
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")
