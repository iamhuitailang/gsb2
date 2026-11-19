"""HTTP server for the local workbench (127.0.0.1 only, no external calls)."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import urllib.parse
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple

from . import __version__
from .core import (
    DEFAULT_IGNORE_DAYS,
    FINDING_STATUS_LABELS,
    MAX_IGNORE_DAYS,
    REVIEW_STATE_LABELS,
    SKIP_REASON_LABELS,
    Workbench,
    WorkbenchError,
)
from .rules import SEVERITIES, RuleConfigError
from .scanner import DEFAULT_EXCLUDED_DIRS

MAX_BODY_BYTES = 1024 * 1024
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class WorkbenchHandler(BaseHTTPRequestHandler):
    server_version = "LocalSecretWorkbench/%s" % __version__
    protocol_version = "HTTP/1.1"
    workbench: Workbench  # injected by serve()

    # ------------------------------------------------------------- utilities
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        # Deliberately terse: request lines never contain match text.
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send_bytes(
        self,
        status: int,
        body: bytes,
        content_type: str,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;"
            " connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none';"
            " frame-ancestors 'none'",
        )
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send_bytes(status, body, "application/json; charset=utf-8")

    def _error(self, status: int, code: str, message: str) -> None:
        self._send_json(status, {"error": {"code": code, "message": message}})

    def _check_host(self) -> None:
        host = (self.headers.get("Host") or "").strip().lower()
        if not host:
            return
        hostname = host.rsplit(":", 1)[0] if not host.startswith("[") else host.split("]")[0] + "]"
        if hostname not in LOCAL_HOSTS:
            raise ApiError(HTTPStatus.FORBIDDEN, "forbidden_host", "只接受来自本机的请求")

    def _check_mutation(self) -> None:
        if self.headers.get("X-Workbench-Request") != "1":
            raise ApiError(
                HTTPStatus.FORBIDDEN,
                "missing_request_header",
                "写操作必须带 X-Workbench-Request 请求头（防跨站请求）",
            )
        origin = self.headers.get("Origin")
        if origin:
            parsed = urllib.parse.urlparse(origin)
            if (parsed.hostname or "") not in LOCAL_HOSTS:
                raise ApiError(HTTPStatus.FORBIDDEN, "forbidden_origin", "拒绝跨站写操作")
        content_type = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if content_type != "application/json":
            raise ApiError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_content_type", "请求体必须是 JSON")

    def _read_json(self) -> Dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(HTTPStatus.BAD_REQUEST, "invalid_length", "Content-Length 无效") from None
        if length < 0 or length > MAX_BODY_BYTES:
            raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "body_too_large", "请求体过大")
        raw = b""
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 65536))
            if not chunk:
                break
            raw += chunk
            remaining -= len(chunk)
        if not raw:
            return {}
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(HTTPStatus.BAD_REQUEST, "invalid_json", "请求体不是合法 JSON") from None
        if not isinstance(payload, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, "invalid_json", "请求体必须是 JSON 对象")
        return payload

    # ---------------------------------------------------------------- routing
    def do_GET(self) -> None:  # noqa: N802
        self._dispatch("GET")

    def do_HEAD(self) -> None:  # noqa: N802
        self._dispatch("HEAD")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")

    def do_PUT(self) -> None:  # noqa: N802
        self._dispatch("PUT")

    def do_DELETE(self) -> None:  # noqa: N802
        self._dispatch("DELETE")

    def _dispatch(self, method: str) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=False)
        try:
            self._check_host()
            if path.startswith("/api/"):
                if method in ("POST", "PUT", "DELETE"):
                    self._check_mutation()
                self._route_api(method, path, query)
            elif method in ("GET", "HEAD"):
                self._serve_static(path)
            else:
                raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "method_not_allowed", "不支持的方法")
        except ApiError as exc:
            self._error(exc.status, exc.code, exc.message)
        except WorkbenchError as exc:
            self._error(exc.status, exc.code, exc.message)
        except RuleConfigError as exc:
            self._error(HTTPStatus.BAD_REQUEST, "rules_invalid", str(exc))
        except BrokenPipeError:
            pass
        except Exception as exc:  # noqa: BLE001
            from .utils import safe_message

            sys.stderr.write("internal error: %s\n" % safe_message(exc))
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "internal_error", "服务器内部错误：%s" % safe_message(exc))

    def _route_api(
        self, method: str, path: str, query: Dict[str, List[str]]
    ) -> None:
        workbench = self.workbench
        parts = [part for part in path.split("/") if part][1:]  # drop 'api'

        if parts == ["health"]:
            self._send_json(HTTPStatus.OK, {"status": "ok", "version": __version__})
            return
        if parts == ["config"]:
            self._send_json(HTTPStatus.OK, self._config_payload())
            return
        if parts == ["directory"]:
            self._require_method(method, "GET")
            target = (query.get("path") or [""])[0]
            self._send_json(HTTPStatus.OK, self._list_directory(target))
            return
        if parts == ["rules"]:
            if method == "GET":
                rules = workbench.current_rules()
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "text": workbench.rules_text(),
                        "path": workbench.rules_path,
                        "version": rules.version,
                        "snapshot": rules.snapshot(),
                    },
                )
                return
            if method == "PUT":
                payload = self._read_json()
                text = payload.get("text")
                if not isinstance(text, str):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "invalid_text", "text 必须是字符串")
                rule_set = workbench.update_rules(text)
                self._send_json(
                    HTTPStatus.OK,
                    {"version": rule_set.version, "snapshot": rule_set.snapshot()},
                )
                return
            raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "method_not_allowed", "不支持的方法")
        if parts == ["rules", "validate"] and method == "POST":
            payload = self._read_json()
            text = payload.get("text")
            if not isinstance(text, str):
                raise ApiError(HTTPStatus.BAD_REQUEST, "invalid_text", "text 必须是字符串")
            rule_set = workbench.validate_rules(text)
            self._send_json(
                HTTPStatus.OK,
                {"valid": True, "version": rule_set.version, "snapshot": rule_set.snapshot()},
            )
            return
        if parts == ["rules", "impact"] and method == "POST":
            payload = self._read_json()
            text = payload.get("text")
            if not isinstance(text, str):
                raise ApiError(HTTPStatus.BAD_REQUEST, "invalid_text", "text 必须是字符串")
            self._send_json(HTTPStatus.OK, workbench.rule_change_impact(text))
            return
        if parts == ["scans"]:
            if method == "GET":
                limit = int((query.get("limit") or ["50"])[0] or 50)
                self._send_json(HTTPStatus.OK, {"items": workbench.list_scans(min(max(limit, 1), 200))})
                return
            if method == "POST":
                payload = self._read_json()
                scan = workbench.start_scan(
                    payload.get("root", ""),
                    options=payload.get("options") or {},
                    exclude_patterns=payload.get("exclude_patterns"),
                )
                self._send_json(HTTPStatus.CREATED, {"scan": scan})
                return
            raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "method_not_allowed", "不支持的方法")
        if len(parts) >= 2 and parts[0] == "scans":
            scan_id = parts[1]
            if len(parts) == 2 and method == "GET":
                self._send_json(HTTPStatus.OK, {"scan": workbench.get_scan(scan_id)})
                return
            if len(parts) == 3 and parts[2] == "findings" and method == "GET":
                filters = {
                    "severity": query.get("severity"),
                    "status": query.get("status"),
                    "review_state": query.get("review_state"),
                    "rule": query.get("rule"),
                    "family": query.get("family"),
                    "path": query.get("path"),
                    "q": (query.get("q") or [""])[0],
                }
                items = workbench.scan_results(scan_id, filters)
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "items": items,
                        "total": len(items),
                        "facets": self._facets(scan_id),
                    },
                )
                return
            if len(parts) == 3 and parts[2] == "skipped" and method == "GET":
                self._send_json(HTTPStatus.OK, workbench.skip_details(scan_id))
                return
            if len(parts) == 3 and parts[2] == "compare" and method == "GET":
                baseline_id = (query.get("baseline_id") or [""])[0]
                if not baseline_id:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "baseline_required", "请提供 baseline_id")
                self._send_json(HTTPStatus.OK, {"comparison": workbench.compare_baseline(scan_id, baseline_id)})
                return
            if len(parts) == 3 and parts[2] == "report" and method == "GET":
                fmt = (query.get("format") or ["json"])[0]
                baseline_id = (query.get("baseline_id") or [None])[0]
                filters = {
                    "severity": query.get("severity"),
                    "status": query.get("status"),
                    "review_state": query.get("review_state"),
                    "rule": query.get("rule"),
                    "path": query.get("path"),
                    "q": (query.get("q") or [""])[0],
                }
                report = workbench.export_report(scan_id, fmt, filters, baseline_id)
                body = report["content"].encode("utf-8")
                self._send_bytes(
                    HTTPStatus.OK,
                    body,
                    report["content_type"],
                    {"Content-Disposition": 'attachment; filename="%s"' % report["filename"]},
                )
                return
            if len(parts) == 3 and parts[2] == "baseline" and method == "POST":
                payload = self._read_json()
                baseline = workbench.create_baseline(
                    scan_id,
                    str(payload.get("name") or ""),
                    str(payload.get("note") or ""),
                    str(payload.get("include") or "all"),
                )
                self._send_json(HTTPStatus.CREATED, {"baseline": baseline})
                return
        if len(parts) == 3 and parts[0] == "findings" and parts[2] == "review":
            finding_id = parts[1]
            if method == "POST":
                payload = self._read_json()
                finding = workbench.review_finding(
                    finding_id,
                    str(payload.get("decision") or ""),
                    str(payload.get("reason") or ""),
                    ignore_days=payload.get("ignore_days"),
                    ignore_until=payload.get("ignore_until"),
                    actor=str(payload.get("actor") or ""),
                    expected_fingerprint=payload.get("expected_fingerprint"),
                )
                self._send_json(HTTPStatus.OK, {"finding": finding})
                return
            if method == "DELETE":
                finding = workbench.clear_review(finding_id)
                self._send_json(HTTPStatus.OK, {"finding": finding})
                return
        if parts == ["reviews"] and method == "GET":
            self._send_json(
                HTTPStatus.OK,
                {"items": workbench.reviews(), "events": workbench.review_events()},
            )
            return
        if parts == ["baselines"]:
            if method == "GET":
                self._send_json(HTTPStatus.OK, {"items": workbench.list_baselines()})
                return
            raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "method_not_allowed", "不支持的方法")
        if len(parts) == 2 and parts[0] == "baselines":
            baseline_id = parts[1]
            if method == "DELETE":
                workbench.delete_baseline(baseline_id)
                self._send_json(HTTPStatus.OK, {"deleted": baseline_id})
                return
        raise ApiError(HTTPStatus.NOT_FOUND, "not_found", "接口不存在")

    def _require_method(self, method: str, expected: str) -> None:
        if method != expected:
            raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "method_not_allowed", "不支持的方法")

    def _facets(self, scan_id: str) -> Dict[str, Dict[str, int]]:
        workbench = self.workbench
        items = workbench.scan_results(scan_id, {})
        def count(key: str) -> Dict[str, int]:
            result: Dict[str, int] = {}
            for item in items:
                value = str(item.get(key) or "")
                result[value] = result.get(value, 0) + 1
            return result

        return {
            "severity": count("severity"),
            "status": count("status"),
            "review_state": count("review_state"),
            "rule": count("rule_id"),
            "family": count("family"),
        }

    def _config_payload(self) -> Dict[str, Any]:
        return {
            "version": __version__,
            "severities": list(SEVERITIES),
            "status_labels": FINDING_STATUS_LABELS,
            "review_state_labels": REVIEW_STATE_LABELS,
            "skip_reason_labels": SKIP_REASON_LABELS,
            "default_excluded_dirs": list(DEFAULT_EXCLUDED_DIRS),
            "default_ignore_days": DEFAULT_IGNORE_DAYS,
            "max_ignore_days": MAX_IGNORE_DAYS,
            "rules_path": self.workbench.rules_path,
            "data_dir": self.workbench.data_dir,
        }

    def _list_directory(self, target: str) -> Dict[str, Any]:
        """Directory picker: directories only, no file contents, no symlink traversal."""
        if not target:
            start = os.path.expanduser("~")
        else:
            start = os.path.expanduser(target)
        absolute = os.path.abspath(start)
        if not os.path.isdir(absolute):
            raise ApiError(HTTPStatus.BAD_REQUEST, "invalid_directory", "目录不存在")
        parent = os.path.dirname(absolute)
        children = []
        try:
            with os.scandir(absolute) as entries:
                for entry in sorted(entries, key=lambda item: item.name.lower()):
                    if entry.name.startswith(".") and entry.name not in (".config", ".env"):
                        continue
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            children.append(
                                {"name": entry.name, "path": os.path.join(absolute, entry.name), "symlink": False}
                            )
                        elif entry.is_symlink():
                            children.append(
                                {"name": entry.name, "path": os.path.join(absolute, entry.name), "symlink": True}
                            )
                    except OSError:
                        continue
        except PermissionError:
            raise ApiError(HTTPStatus.FORBIDDEN, "permission_denied", "没有权限读取该目录") from None
        return {
            "path": absolute,
            "parent": parent if parent != absolute else None,
            "entries": children[:500],
            "truncated": len(children) > 500,
        }

    def _serve_static(self, path: str) -> None:
        if path in ("/", ""):
            name = "index.html"
        else:
            name = path.lstrip("/")
        if name.startswith("static/"):
            name = name[len("static/"):]
        if "/" in name or "\\" in name or name.startswith("."):
            raise ApiError(HTTPStatus.NOT_FOUND, "not_found", "页面不存在")
        if not re.match(r"^[A-Za-z0-9._-]+$", name):
            raise ApiError(HTTPStatus.NOT_FOUND, "not_found", "页面不存在")
        file_path = os.path.join(WEB_DIR, name)
        if not os.path.isfile(file_path):
            raise ApiError(HTTPStatus.NOT_FOUND, "not_found", "页面不存在")
        extension = os.path.splitext(name)[1].lower()
        content_type = STATIC_TYPES.get(extension, "application/octet-stream")
        with open(file_path, "rb") as handle:
            body = handle.read()
        self._send_bytes(HTTPStatus.OK, body, content_type)


def make_server(workbench: Workbench, host: str = "127.0.0.1", port: int = 0) -> ThreadingHTTPServer:
    handler = type("BoundWorkbenchHandler", (WorkbenchHandler,), {"workbench": workbench})
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    return server


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m workbench",
        description="本地源码安全审查工作台（仅监听 127.0.0.1，不访问外部服务）",
    )
    parser.add_argument("--data-dir", default=os.environ.get("WORKBENCH_DATA_DIR", "workbench-data"))
    parser.add_argument("--rules", default=None, help="规则 JSON 路径（默认 <data-dir>/rules.json）")
    parser.add_argument("--host", default="127.0.0.1", choices=["127.0.0.1", "localhost", "::1"])
    parser.add_argument("--port", type=int, default=int(os.environ.get("WORKBENCH_PORT", "8765")))
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    args = parser.parse_args(argv)

    workbench = Workbench(os.path.abspath(args.data_dir), rules_path=args.rules)
    try:
        server = make_server(workbench, args.host, args.port)
    except OSError as exc:
        sys.stderr.write("无法监听 %s:%s — %s\n" % (args.host, args.port, exc))
        return 1
    host, port = server.server_address[0], server.server_address[1]
    url = "http://%s:%s/" % (host, port)
    print("Local Secret Workbench %s" % __version__)
    print("  地址：%s" % url)
    print("  数据目录：%s" % workbench.data_dir)
    print("  规则文件：%s" % workbench.rules_path)
    print("  按 Ctrl+C 停止")
    if args.open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
