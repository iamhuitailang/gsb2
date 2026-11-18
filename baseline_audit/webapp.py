"""本地 Web 服务：仅监听 127.0.0.1，无外部账号、无网络依赖。

页面与 API 响应中只出现目录展示名（basename）和相对路径；绝对路径只保存在
服务进程内存的 token 映射里，刷新页面后需要重新选择目录。
"""

from __future__ import annotations

import hashlib
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .auditor import Auditor
from .errors import AuditError, RootNotAccessible, StoreCorruptError

_WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
}


def _token_for(root_real: str) -> str:
    return hashlib.sha1(root_real.encode("utf-8")).hexdigest()[:16]


def build_handler(auditor: Auditor):
    # token -> 真实路径，仅存内存
    root_tokens: dict[str, str] = {}

    class Handler(BaseHTTPRequestHandler):
        server_version = "BaselineAudit/1.0"

        def log_message(self, fmt, *args):  # 覆盖默认访问日志，避免绝对路径进入 stderr
            auditor.store.append_log("http", fmt % args)

        # ---------- 基础工具 ----------

        def _send_json(self, payload, status: int = 200):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _read_json(self) -> dict:
            length = int(self.headers.get("Content-Length", 0))
            if not length:
                return {}
            raw = self.rfile.read(length)
            try:
                data = json.loads(raw.decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                raise ValueError("请求体不是有效的 JSON")
            if not isinstance(data, dict):
                raise ValueError("请求体必须是 JSON 对象")
            return data

        def _resolve_root(self, data: dict, query: dict) -> str:
            token = data.get("root_token") or query.get("root_token", [""])[0]
            root_real = root_tokens.get(token)
            if not root_real:
                raise RootNotAccessible("目录会话已失效，请重新选择核查目录。")
            return root_real

        def _parse_query(self) -> dict:
            from urllib.parse import parse_qs, urlparse

            return parse_qs(urlparse(self.path).query)

        # ---------- 路由 ----------

        def do_GET(self):
            from urllib.parse import urlparse

            path = urlparse(self.path).path
            try:
                if path == "/api/health":
                    return self._send_json({"ok": True})
                if path == "/api/log":
                    return self._send_json({"events": auditor.read_audit_log()})
                if path == "/api/runs":
                    root = self._resolve_root({}, self._parse_query())
                    runs = [
                        {k: r[k] for k in ("run_id", "started_at", "root_label",
                                           "rule_version", "stats", "warnings")}
                        for r in auditor.list_runs(root)
                    ]
                    return self._send_json({"runs": runs})
                if path == "/api/run":
                    query = self._parse_query()
                    root = self._resolve_root({}, query)
                    run_id = query.get("run_id", [""])[0]
                    run = auditor.get_run(root, run_id)
                    if run is None:
                        return self._send_json({"error": "核查记录不存在"}, 404)
                    return self._send_json({"run": run})
                if path == "/api/baseline":
                    root = self._resolve_root({}, self._parse_query())
                    return self._send_json({"baseline": auditor.get_baseline(root)})
                if path == "/api/exceptions":
                    root = self._resolve_root({}, self._parse_query())
                    return self._send_json({"exceptions": auditor.list_exceptions(root)})
                if path == "/api/export":
                    query = self._parse_query()
                    root = self._resolve_root({}, query)
                    run_id = query.get("run_id", [""])[0] or None
                    report = auditor.export_report(root, run_id)
                    return self._send_json(report)
                return self._serve_static(path)
            except StoreCorruptError as exc:
                auditor.store.append_log("tool_error", str(exc))
                return self._send_json(
                    {"error": "工具状态文件损坏，请查看审计日志后处理。",
                     "category": "tool_error"}, 500)
            except AuditError as exc:
                return self._send_json({"error": str(exc), "category": "user_error"}, 400)

        def do_POST(self):
            from urllib.parse import urlparse

            path = urlparse(self.path).path
            try:
                data = self._read_json()
                if path == "/api/scan":
                    root_real = auditor.resolve_root(data.get("path", ""))
                    result = auditor.scan_resolved(root_real)
                    token = _token_for(root_real)
                    root_tokens[token] = root_real
                    return self._send_json(
                        {"root_token": token, "root_label": result["run"]["root_label"],
                         "run": result["run"]}
                    )
                if path == "/api/baseline":
                    root = self._resolve_root(data, {})
                    baseline = auditor.save_baseline(root, data.get("run_id"))
                    return self._send_json({"baseline": baseline})
                if path == "/api/exceptions":
                    root = self._resolve_root(data, {})
                    record = auditor.add_exception(
                        root,
                        data["finding_id"],
                        data.get("scope", "finding"),
                        data.get("expires_at", ""),
                        data.get("reason", ""),
                    )
                    return self._send_json({"exception": record})
                if path == "/api/exceptions/revoke":
                    root = self._resolve_root(data, {})
                    ok = auditor.revoke_exception(root, data["exception_id"])
                    return self._send_json({"revoked": ok})
                return self._send_json({"error": "未知接口"}, 404)
            except StoreCorruptError as exc:
                auditor.store.append_log("tool_error", str(exc))
                return self._send_json(
                    {"error": "工具状态文件损坏，请查看审计日志后处理。",
                     "category": "tool_error"}, 500)
            except (AuditError, ValueError, KeyError) as exc:
                return self._send_json(
                    {"error": f"请求无效：{exc}", "category": "user_error"}, 400)

        def _serve_static(self, path: str):
            if path == "/":
                path = "/index.html"
            # 防目录穿越：只允许 web 目录内的已知后缀文件
            safe = os.path.normpath(path).lstrip("/")
            full = os.path.join(_WEB_DIR, safe)
            if not full.startswith(_WEB_DIR + os.sep) or not os.path.isfile(full):
                self.send_response(404)
                self.end_headers()
                return
            suffix = os.path.splitext(full)[1]
            with open(full, "rb") as static_file:
                body = static_file.read()
            self.send_response(200)
            self.send_header("Content-Type", _CONTENT_TYPES.get(suffix, "application/octet-stream"))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def serve(data_dir: str, host: str = "127.0.0.1", port: int = 8765) -> None:
    auditor = Auditor(data_dir)
    httpd = ThreadingHTTPServer((host, port), build_handler(auditor))
    actual_host, actual_port = httpd.server_address
    print(f"基线核查台已启动：http://{actual_host}:{actual_port} （Ctrl+C 停止）")
    print(f"状态数据目录：{os.path.realpath(data_dir)}（不会写入被核查目录）")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()
