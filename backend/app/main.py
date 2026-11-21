"""Local-only API for the forwarded-address audit workbench.

The service performs no outbound network requests, resolves no names and
uses no real proxies or accounts.  Everything is computed from the sample
data submitted with each request.
"""

from __future__ import annotations

import csv
import io
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__
from .analyzer import OUTCOME_LABELS, RISK_BY_OUTCOME, analyze
from .config import FIELD_ORDER, config_fingerprint, normalize_trust_config
from .demos import DEMOS, demo_payload, public_demos
from .headers import headers_as_list, normalize_headers
from .schemas import AnalyzeRequest, ConfigSaveRequest, DemoRunRequest
from .storage import Database

FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = Path(__file__).resolve().parents[1]


def create_app(db_path: str | Path | None = None) -> FastAPI:
    resolved_db = db_path or os.environ.get("FORWARD_AUDIT_DB") or (
        Path(__file__).resolve().parents[1] / "data" / "forward_audit.sqlite3"
    )
    app = FastAPI(
        title="转发地址安全分析台",
        version=__version__,
        description="复盘反向代理传来的客户端地址：只处理提交的样例数据，不发起外部请求。",
    )
    app.state.db = Database(resolved_db)
    app.state.db_path = str(resolved_db)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:4173",
            "http://127.0.0.1:4173",
        ],
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Content-Type"],
    )

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "version": __version__,
            "database": "sqlite",
            "outbound_requests": False,
            "counts": app.state.db.counts(),
        }

    @app.get("/api/meta")
    def meta() -> dict[str, Any]:
        return {
            "fields": FIELD_ORDER,
            "outcomes": [
                {"key": key, "label": label, "risk": RISK_BY_OUTCOME.get(key, ("unknown", "待核实"))[0]}
                for key, label in OUTCOME_LABELS.items()
            ],
            "demo_count": len(DEMOS),
        }

    # ---------------- demos ----------------
    @app.get("/api/demos")
    def list_demos() -> dict[str, Any]:
        return {"items": public_demos()}

    @app.get("/api/demos/{slug}")
    def get_demo(slug: str) -> dict[str, Any]:
        try:
            return demo_payload(slug)
        except KeyError:
            raise HTTPException(status_code=404, detail=f"演示 {slug} 不存在") from None

    @app.post("/api/demos/{slug}/run")
    def run_demo(slug: str, request: DemoRunRequest) -> JSONResponse:
        try:
            demo = demo_payload(slug)
        except KeyError:
            raise HTTPException(status_code=404, detail=f"演示 {slug} 不存在") from None
        headers, header_errors = normalize_headers(demo["headers"])
        if header_errors:
            raise HTTPException(status_code=422, detail=header_errors)
        normalized_config, config_errors, config_warnings = normalize_trust_config(
            demo["config"]
        )
        if config_errors:
            raise HTTPException(status_code=422, detail=config_errors)

        result = analyze(demo["peer"], headers, normalized_config)
        analysis_id = None
        if request.save:
            analysis_id = app.state.db.save_analysis(
                peer_raw=demo["peer"],
                headers=headers_as_list(headers),
                config=normalized_config,
                result=result,
                source="demo",
                demo_slug=slug,
            )
        matches_expectation = _matches_expectation(result, demo["expectation"])
        return JSONResponse(
            {
                "analysis_id": analysis_id,
                "demo": demo,
                "input": {
                    "peer": demo["peer"],
                    "headers": headers_as_list(headers),
                    "config": normalized_config,
                },
                "config_warnings": config_warnings,
                "result": result,
                "expectation_check": matches_expectation,
            }
        )

    # ---------------- configs ----------------
    @app.get("/api/configs")
    def list_configs() -> dict[str, Any]:
        return {"items": app.state.db.list_configs()}

    @app.post("/api/configs/validate")
    def validate_config(payload: ConfigSaveRequest) -> dict[str, Any]:
        normalized, errors, warnings = normalize_trust_config(payload.config)
        return {
            "valid": not errors,
            "config": normalized,
            "errors": errors,
            "warnings": warnings,
            "fingerprint": config_fingerprint(normalized) if normalized else None,
        }

    @app.post("/api/configs", status_code=201)
    def save_config(payload: ConfigSaveRequest) -> Any:
        normalized, errors, warnings = normalize_trust_config(payload.config)
        if errors or normalized is None:
            return JSONResponse(
                status_code=422,
                content={
                    "detail": "配置不合法，未保存",
                    "errors": errors,
                    "warnings": warnings,
                },
            )
        fingerprint = config_fingerprint(normalized)
        try:
            config_id = app.state.db.save_config(
                normalized, fingerprint, config_id=payload.config_id
            )
        except KeyError:
            raise HTTPException(status_code=404, detail="要更新的配置不存在") from None
        return {
            "id": config_id,
            "config": normalized,
            "fingerprint": fingerprint,
            "warnings": warnings,
        }

    @app.get("/api/configs/{config_id}")
    def get_config(config_id: int) -> dict[str, Any]:
        record = app.state.db.get_config(config_id)
        if record is None:
            raise HTTPException(status_code=404, detail="配置不存在")
        return record

    @app.delete("/api/configs/{config_id}")
    def delete_config(config_id: int) -> dict[str, Any]:
        if not app.state.db.delete_config(config_id):
            raise HTTPException(status_code=404, detail="配置不存在")
        return {"deleted": config_id}

    # ---------------- analysis ----------------
    @app.post("/api/analyze")
    def run_analysis(payload: AnalyzeRequest) -> JSONResponse:
        headers, header_errors = normalize_headers(payload.headers)
        normalized_config, config_errors, config_warnings = normalize_trust_config(
            payload.config
        )
        if header_errors or config_errors:
            return JSONResponse(
                status_code=422,
                content={
                    "detail": "输入不合法，未执行判定",
                    "errors": [*header_errors, *config_errors],
                    "warnings": config_warnings,
                },
            )
        assert normalized_config is not None

        result = analyze(payload.peer, headers, normalized_config)
        analysis_id = None
        if payload.save:
            source = payload.source if payload.source in {"manual", "demo"} else "manual"
            analysis_id = app.state.db.save_analysis(
                peer_raw=payload.peer,
                headers=headers_as_list(headers),
                config=normalized_config,
                result=result,
                source=source,
                demo_slug=payload.demo_slug,
            )
        return JSONResponse(
            {
                "analysis_id": analysis_id,
                "input": {
                    "peer": payload.peer,
                    "headers": headers_as_list(headers),
                    "config": normalized_config,
                },
                "config_warnings": config_warnings,
                "result": result,
            }
        )

    @app.get("/api/analyses")
    def list_analyses(
        status: str | None = None,
        outcome: str | None = None,
        source: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        limit: int = Query(50, ge=1, le=200),
        offset: int = Query(0, ge=0),
    ) -> dict[str, Any]:
        items, total = app.state.db.list_analyses(
            status=status,
            outcome=outcome,
            source=source,
            date_from=_day_boundary(date_from, end=False),
            date_to=_day_boundary(date_to, end=True),
            limit=limit,
            offset=offset,
        )
        return {"items": items, "total": total, "limit": limit, "offset": offset}

    @app.get("/api/analyses/{analysis_id}")
    def get_analysis(analysis_id: int) -> dict[str, Any]:
        record = app.state.db.get_analysis(analysis_id)
        if record is None:
            raise HTTPException(status_code=404, detail="记录不存在")
        return record

    @app.delete("/api/analyses/{analysis_id}")
    def delete_analysis(analysis_id: int) -> dict[str, Any]:
        if not app.state.db.delete_analysis(analysis_id):
            raise HTTPException(status_code=404, detail="记录不存在")
        return {"deleted": analysis_id}

    @app.get("/api/export")
    def export_records(
        format: str = Query("json", pattern="^(json|csv)$"),
        status: str | None = None,
        outcome: str | None = None,
        source: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
    ) -> Response:
        records = app.state.db.for_export(
            status=status,
            outcome=outcome,
            source=source,
            date_from=_day_boundary(date_from, end=False),
            date_to=_day_boundary(date_to, end=True),
        )
        sanitized = [_strip_paths(record) for record in records]
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        if format == "csv":
            buffer = io.StringIO()
            writer = csv.writer(buffer)
            writer.writerow(
                [
                    "record_id",
                    "created_at",
                    "source",
                    "demo_slug",
                    "peer",
                    "status",
                    "outcome",
                    "final_client",
                    "summary",
                    "trust_config",
                    "headers",
                ]
            )
            for record in sanitized:
                verdict = (record.get("result") or {}).get("verdict") or {}
                writer.writerow(
                    [
                        record["record_id"],
                        record["created_at"],
                        record["source"],
                        record["demo_slug"] or "",
                        record["peer"],
                        verdict.get("status", ""),
                        verdict.get("outcome", ""),
                        verdict.get("final_client") or "",
                        verdict.get("summary", ""),
                        json.dumps(record["trust_config"], ensure_ascii=False),
                        json.dumps(record["headers"], ensure_ascii=False),
                    ]
                )
            content = buffer.getvalue()
            return Response(
                content=content.encode("utf-8-sig"),
                media_type="text/csv; charset=utf-8",
                headers={
                    "Content-Disposition": f'attachment; filename="forward-audit-{stamp}.csv"'
                },
            )
        body = json.dumps(
            {
                "exported_at": datetime.now().isoformat(timespec="seconds"),
                "record_count": len(sanitized),
                "records": sanitized,
            },
            ensure_ascii=False,
            indent=2,
        )
        return Response(
            content=body.encode("utf-8"),
            media_type="application/json; charset=utf-8",
            headers={
                "Content-Disposition": f'attachment; filename="forward-audit-{stamp}.json"'
            },
        )

    # ---------------- demo data housekeeping ----------------
    @app.post("/api/demo-data/reset")
    def reset_demo_data() -> dict[str, Any]:
        deleted = app.state.db.delete_demo_data()
        return {"deleted": deleted, "counts": app.state.db.counts()}

    @app.get("/api/stats")
    def stats() -> dict[str, Any]:
        return app.state.db.counts()

    if FRONTEND_DIST.is_dir():
        app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="ui")
    else:

        @app.get("/", include_in_schema=False)
        def ui_not_built() -> dict[str, str]:
            return {
                "detail": "前端尚未构建。开发时请运行 frontend 的 npm run dev，"
                "或先执行 npm run build 后由本服务托管。",
                "api_docs": "/docs",
            }

    return app


def _matches_expectation(result: dict[str, Any], expectation: dict[str, Any]) -> dict[str, Any]:
    verdict = result["verdict"]
    checks = {
        "status": verdict["status"] == expectation["status"],
        "outcome": verdict["outcome"] == expectation["outcome"],
        "final_client": verdict["final_client"] == expectation["final_client"],
    }
    return {"passed": all(checks.values()), "checks": checks}


def _day_boundary(value: str | None, *, end: bool) -> str | None:
    """Interpret a ``YYYY-MM-DD`` filter as a whole UTC day.

    Stored timestamps use ``...Z``.  Padding the upper bound to the end of
    the day keeps "to 2026-11-21" inclusive instead of excluding everything
    recorded after midnight.  Values that already contain a time are passed
    through untouched.
    """
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    if len(text) == 10 and text[4] == "-" and text[7] == "-":
        return text + ("T23:59:59Z" if end else "T00:00:00Z")
    return text


def _strip_paths(value: Any) -> Any:
    """Remove local filesystem paths from exported values.

    Export files leave the machine, so no absolute path, home directory or
    database location should appear in them.  Only generic placeholders are
    substituted; nothing else in the payload is rewritten.
    """
    if isinstance(value, dict):
        return {key: _strip_paths(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_strip_paths(item) for item in value]
    if isinstance(value, str):
        text = value
        for absolute, placeholder in (
            (str(REPO_ROOT), "<repo>"),
            (str(BACKEND_ROOT), "<backend>"),
            (str(Path.home()), "<home>"),
        ):
            text = text.replace(absolute, placeholder)
        return text
    return value


app = create_app()
