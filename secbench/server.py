"""本地 HTTP 服务（仅标准库，默认监听 127.0.0.1:8080，不连接任何外部服务）。"""
from __future__ import annotations

import json
import os
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from typing import Any

from . import export as export_mod
from . import ingestion, rules, storage

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
SAMPLES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "samples")

SEVERITY_LABEL = {"high": "高", "medium": "中", "low": "低"}


def _jsonable_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    for key in ("normalized",):
        if key in data and isinstance(data[key], str):
            data[key] = json.loads(data[key])
    for key in ("involved_sources", "involved_subjects", "involved_targets"):
        if key in data and isinstance(data[key], str):
            data[key] = json.loads(data[key])
    if "status" in data:
        data["status_label"] = storage.STATUS_LABEL.get(data["status"], data["status"])
    if "severity" in data:
        data["severity_label"] = SEVERITY_LABEL.get(data["severity"], data["severity"])
    if "rule_id" in data:
        meta = rules.RULES_META.get(data["rule_id"])
        data["rule_name"] = meta["name"] if meta else data["rule_id"]
    return data


class Handler(BaseHTTPRequestHandler):
    server_version = "secbench/1.0"

    # ---------- 基础工具 ----------
    def _send_json(self, obj: Any, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: str, content_type: str) -> None:
        try:
            with open(path, "rb") as fh:
                body = fh.read()
        except FileNotFoundError:
            self._send_json({"error": "not found"}, 404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def log_message(self, fmt: str, *args: Any) -> None:  # 安静一点
        pass

    # ---------- 路由 ----------
    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)
        try:
            if path == "/api/health":
                self._send_json({"ok": True, "rule_version": storage.RULE_VERSION})
            elif path == "/api/settings":
                with storage.connect() as conn:
                    storage.init_db(conn)
                    self._send_json(storage.get_settings(conn))
            elif path == "/api/rules":
                self._send_json([
                    {"rule_id": rid, **meta,
                     "rationale_template": _RULE_DOC[rid]}
                    for rid, meta in rules.RULES_META.items()
                ])
            elif path == "/api/events":
                self._handle_list_events(query)
            elif path.startswith("/api/events/"):
                event_pk = int(path.rsplit("/", 1)[1])
                with storage.connect() as conn:
                    storage.init_db(conn)
                    row = _jsonable_row(storage.get_event(conn, event_pk))
                if row is None:
                    self._send_json({"error": "事件不存在"}, 404)
                else:
                    self._send_json(row)
            elif path == "/api/imports":
                with storage.connect() as conn:
                    storage.init_db(conn)
                    imports = [_jsonable_row(r) for r in storage.list_imports(conn)]
                    self._send_json({"imports": imports})
            elif path == "/api/errors":
                import_id = int(query["import_id"][0]) if "import_id" in query else None
                with storage.connect() as conn:
                    storage.init_db(conn)
                    rows = [dict(r) for r in storage.list_row_errors(conn, import_id)]
                    self._send_json({"row_errors": rows})
            elif path == "/api/quarantined":
                import_id = int(query["import_id"][0]) if "import_id" in query else None
                with storage.connect() as conn:
                    storage.init_db(conn)
                    rows = [dict(r) for r in storage.list_quarantined(conn, import_id)]
                    self._send_json({"quarantined": rows})
            elif path == "/api/alerts":
                self._handle_list_alerts(query)
            elif path.startswith("/api/alerts/") and path.endswith("/evidence"):
                alert_id = int(path.split("/")[3])
                with storage.connect() as conn:
                    storage.init_db(conn)
                    ev = [_jsonable_row(r) for r in storage.alert_evidence(conn, alert_id)]
                    self._send_json({"evidence": ev})
            elif path == "/api/export":
                self._handle_export(query)
            elif path == "/api/samples":
                self._handle_samples(query)
            elif path == "/" or path == "/index.html":
                self._send_file(os.path.join(STATIC_DIR, "index.html"),
                                "text/html; charset=utf-8")
            elif path.startswith("/static/"):
                name = path.removeprefix("/static/")
                ctype = "text/css" if name.endswith(".css") else "application/javascript"
                self._send_file(os.path.join(STATIC_DIR, name), ctype)
            else:
                self._send_json({"error": "not found"}, 404)
        except Exception as exc:  # 单请求异常不拖垮服务
            self._send_json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            if path == "/api/import":
                self._handle_import()
            elif path == "/api/settings":
                self._handle_update_settings()
            elif path.startswith("/api/alerts/") and path.endswith("/status"):
                self._handle_set_status(int(path.split("/")[3]))
            elif path == "/api/reset":
                with storage.connect() as conn:
                    storage.init_db(conn)
                    storage.reset_all(conn)
                self._send_json({"ok": True})
            else:
                self._send_json({"error": "not found"}, 404)
        except Exception as exc:
            self._send_json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    # ---------- 业务处理 ----------
    def _handle_list_events(self, query: dict[str, list[str]]) -> None:
        with storage.connect() as conn:
            storage.init_db(conn)
            rows = storage.list_events(
                conn,
                source=query.get("source", [None])[0],
                subject=query.get("subject", [None])[0],
                src_ip=query.get("src_ip", [None])[0],
                limit=int(query.get("limit", [500])[0]),
            )
            self._send_json({"events": [_jsonable_row(r) for r in rows]})

    def _handle_list_alerts(self, query: dict[str, list[str]]) -> None:
        def q(name: str) -> str | None:
            return query.get(name, [None])[0]
        with storage.connect() as conn:
            storage.init_db(conn)
            rows = storage.list_alerts(
                conn, severity=q("severity"), source=q("source"),
                subject=q("subject"), status=q("status"),
                time_from=q("time_from"), time_to=q("time_to"),
                include_superseded=q("include_superseded") == "1",
            )
            self._send_json({"alerts": [_jsonable_row(r) for r in rows]})

    def _handle_set_status(self, alert_id: int) -> None:
        payload = self._read_json()
        status = payload.get("status", "")
        note = str(payload.get("disposition_note", ""))
        with storage.connect() as conn:
            storage.init_db(conn)
            try:
                row = storage.set_alert_status(conn, alert_id, status, note)
            except (ValueError, KeyError) as exc:
                self._send_json({"error": str(exc)}, 400)
                return
            self._send_json(_jsonable_row(row))

    def _handle_update_settings(self) -> None:
        payload = self._read_json()
        with storage.connect() as conn:
            storage.init_db(conn)
            try:
                settings = storage.update_settings(conn, payload)
            except (KeyError, ValueError) as exc:
                self._send_json({"error": str(exc)}, 400)
                return
            rules.evaluate(conn)  # 阈值变更后重新评估
            self._send_json({"settings": settings})

    def _handle_import(self) -> None:
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self._send_json({"error": "导入需使用 multipart/form-data 上传文件"}, 400)
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        filename, file_bytes = _parse_multipart(body, content_type)
        if not file_bytes:
            self._send_json({"error": "未找到上传文件"}, 400)
            return
        with storage.connect() as conn:
            storage.init_db(conn)
            try:
                result = ingestion.import_jsonl_bytes(conn, file_bytes, filename)
            except ingestion.ImportRejected as exc:
                self._send_json({"rejected": True, "error": str(exc)}, 413)
                return
            stale = rules.evaluate(conn)
            result["stale_alerts"] = stale
            self._send_json(result)

    def _handle_export(self, query: dict[str, list[str]]) -> None:
        def q(name: str) -> str | None:
            return query.get(name, [None])[0]
        fmt = q("format") or "json"
        with storage.connect() as conn:
            storage.init_db(conn)
            rows = storage.list_alerts(
                conn, severity=q("severity"), source=q("source"),
                subject=q("subject"), status=q("status"),
                time_from=q("time_from"), time_to=q("time_to"),
                include_superseded=q("include_superseded") == "1",
            )
            payload = export_mod.build_export_payload(conn, rows)
        if fmt == "jsonl":
            body = export_mod.to_jsonl_text(payload).encode("utf-8")
            ctype = "application/x-ndjson; charset=utf-8"
            fname = "secbench_alerts.jsonl"
        else:
            body = export_mod.to_json_text(payload).encode("utf-8")
            ctype = "application/json; charset=utf-8"
            fname = "secbench_alerts.json"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Disposition",
                         f'attachment; filename="{fname}"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_samples(self, query: dict[str, list[str]]) -> None:
        name = query.get("name", [None])[0]
        base = os.path.abspath(SAMPLES_DIR)
        if name:
            target = os.path.abspath(os.path.join(base, name))
            if not target.startswith(base + os.sep):
                self._send_json({"error": "非法文件名"}, 400)
                return
            self._send_file(target, "application/x-ndjson; charset=utf-8")
            return
        self._send_json({"samples": sorted(
            f for f in os.listdir(base) if f.endswith(".jsonl")
        )})


# multipart 解析：本工作台只接收单个文件字段，按 boundary 切分即可
def _parse_multipart(body: bytes, content_type: str) -> tuple[str, bytes]:
    boundary = None
    for part in content_type.split(";"):
        part = part.strip()
        if part.startswith("boundary="):
            boundary = part.split("=", 1)[1].strip('"')
    if not boundary:
        return "", b""
    delimiter = b"--" + boundary.encode()
    segments = body.split(delimiter)
    for segment in segments:
        if b"Content-Disposition" not in segment:
            continue
        head, _, content = segment.partition(b"\r\n\r\n")
        disposition_line = head.decode("utf-8", errors="replace").lstrip("\r\n").split("\r\n")[0]
        filename = "upload.jsonl"
        for token in disposition_line.split(";"):
            token = token.strip()
            if token.startswith("filename="):
                filename = token.split("=", 1)[1].strip('"') or filename
        content = content.rstrip(b"\r\n-")
        return filename, content
    return "", b""


_RULE_DOC = {
    "R1_BRUTE_FORCE": "同 src_ip 窗口内多个不同账号登录失败，随后成功登录才告警",
    "R2_PROBE_THEN_ACCESS": "同 src_ip 先出现路径探测，窗口内再有敏感路径访问或 5xx 才告警",
    "R3_CROSS_IP_EXPORT": "同一账号成功登录后窗口内，从不同 src_ip 执行敏感导出才告警",
}


def serve(host: str = "127.0.0.1", port: int = 8080) -> None:
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"secbench 工作台已启动: http://{host}:{port}")
    print(f"数据库文件: {os.path.abspath(storage.get_db_path())}（仅本机）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()
