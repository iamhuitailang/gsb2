from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import APP_NAME, MAX_REQUEST_BYTES, MAX_SOURCE_NOTE_LEN, WEB_DIR
from .db import Database, StoreError
from .samples import list_samples, read_sample
from .service import PolicyService, ServiceError, parse_submission
from .strict_json import JsonInputError, loads_strict


class BodyTooLarge(Exception):
    pass


async def _read_body(request: Request) -> bytes:
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > MAX_REQUEST_BYTES:
                raise BodyTooLarge
        except ValueError:
            pass
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_REQUEST_BYTES:
            raise BodyTooLarge
        chunks.append(chunk)
    return b"".join(chunks)


def _error_response(exc: ServiceError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content=exc.payload())


def create_app(db: Database | None = None) -> FastAPI:
    database = db or Database(_db_path())
    service = PolicyService(database)

    app = FastAPI(
        title=APP_NAME,
        version="1.0.0",
        # Swagger/ReDoc 页面默认从 CDN 拉取前端资源；本应用要求完全离线，
        # 因此关闭文档 UI，仅保留本地的 OpenAPI 描述。
        docs_url=None,
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )
    app.state.db = database
    app.state.service = service

    @app.exception_handler(ServiceError)
    async def _service_error(_: Request, exc: ServiceError) -> JSONResponse:
        return _error_response(exc)

    @app.exception_handler(StoreError)
    async def _store_error(_: Request, exc: StoreError) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content={"ok": False, "code": "storage_error", "message": str(exc)},
        )

    @app.get("/api/samples")
    async def samples() -> dict[str, Any]:
        return {"samples": list_samples()}

    @app.get("/api/samples/{filename}")
    async def sample_detail(filename: str) -> dict[str, Any]:
        try:
            return read_sample(filename)
        except ValueError as exc:
            raise ServiceError(400, "invalid_sample_name", str(exc)) from exc
        except KeyError as exc:
            raise ServiceError(404, "sample_not_found", "找不到该样例") from exc

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "app": APP_NAME}

    @app.get("/api/state")
    async def state() -> dict[str, Any]:
        return service.state()

    @app.get("/api/history")
    async def history(limit: int = 100) -> dict[str, Any]:
        limit = max(1, min(limit, 500))
        return service.history(audit_limit=limit, version_limit=limit)

    @app.get("/api/versions/{version_id}")
    async def version_detail(version_id: int) -> dict[str, Any]:
        return service.version_detail(version_id)

    @app.post("/api/import/preview")
    async def preview(request: Request) -> dict[str, Any]:
        body = await _read_body(request)
        submission = parse_submission(body)
        return service.preview(submission)

    @app.post("/api/import/apply")
    async def apply(request: Request) -> dict[str, Any]:
        body = await _read_body(request)
        submission = parse_submission(body)
        return service.apply(submission)

    @app.get("/api/versions/{version_id}/restore-preview")
    async def restore_preview(version_id: int) -> dict[str, Any]:
        return service.preview_restore(version_id)

    @app.post("/api/versions/{version_id}/restore")
    async def restore(version_id: int, request: Request) -> dict[str, Any]:
        body = await _read_body(request)
        try:
            envelope = loads_strict(body, max_bytes=MAX_REQUEST_BYTES)
        except JsonInputError as exc:
            raise ServiceError(
                400, "invalid_json", "请求不是合法的 JSON", details=exc.as_detail()
            ) from exc
        if not isinstance(envelope, dict):
            raise ServiceError(400, "invalid_envelope", "请求体必须是 JSON 对象")
        allowed = {"source_note", "base_generation", "confirm_digest"}
        unknown = sorted(set(envelope) - allowed)
        if unknown:
            raise ServiceError(
                400,
                "unknown_envelope_field",
                f"请求包含未知字段：{', '.join(unknown)}",
            )
        source_note = envelope.get("source_note") or ""
        if not isinstance(source_note, str):
            raise ServiceError(400, "invalid_source_note", "来源说明必须是字符串")
        source_note = source_note.strip()
        if len(source_note) > MAX_SOURCE_NOTE_LEN:
            raise ServiceError(
                400,
                "source_note_too_long",
                f"来源说明不能超过 {MAX_SOURCE_NOTE_LEN} 个字符",
            )
        raw_generation = envelope.get("base_generation")
        if raw_generation is not None and (
            isinstance(raw_generation, bool) or not isinstance(raw_generation, int)
        ):
            raise ServiceError(400, "invalid_field", "base_generation 必须是整数")
        digest = envelope.get("confirm_digest")
        if digest is not None and not isinstance(digest, str):
            raise ServiceError(400, "invalid_field", "confirm_digest 必须是字符串")
        return service.restore(
            version_id,
            source_note=source_note,
            base_generation=raw_generation,
            confirm_digest=digest,
        )

    @app.exception_handler(BodyTooLarge)
    async def _too_large(_: Request, __: BodyTooLarge) -> JSONResponse:
        return JSONResponse(
            status_code=413,
            content={
                "ok": False,
                "code": "request_too_large",
                "message": f"请求体超过 {MAX_REQUEST_BYTES} 字节上限",
            },
        )

    if WEB_DIR.is_dir():
        # 静态资源挂载在最后：/api/* 已先行注册，不会被它吞掉。
        app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")

    return app


def _db_path() -> Any:
    from .config import db_path_from_env

    return db_path_from_env()
