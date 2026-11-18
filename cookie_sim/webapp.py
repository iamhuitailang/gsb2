"""本机 Web 服务: 纯标准库实现, 只绑定回环地址, 不访问任何外部网络。"""
from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .jar import CookieJar
from .parser import parse_set_cookie
from .request import evaluate_request, script_readable_cookies
from .samples import SAMPLES, SAMPLE_NOW, build_sample_jar, get_sample
from .sites import parse_url
from .timeutil import now_ts

_STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
_STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
}


class AppState:
    """全局应用状态: jar、持久化路径与互斥锁。"""

    def __init__(self, storage_path: str):
        self.storage_path = storage_path
        self.jar = CookieJar()
        self.lock = threading.Lock()
        if os.path.exists(storage_path):
            try:
                self.jar.load(storage_path)
            except (OSError, json.JSONDecodeError):
                # 状态文件损坏时从空 jar 启动, 不影响模拟器运行
                self.jar = CookieJar()

    def save(self) -> None:
        self.jar.save(self.storage_path)


def _jar_view(jar: CookieJar) -> dict:
    now = now_ts()
    return {
        "server_time": now,
        "cookies": [c.to_dict() for c in jar.all_cookies()],
        "rejections": [r.to_dict() for r in jar.rejections()],
    }


class CookieHandler(BaseHTTPRequestHandler):
    server_version = "CookieSim/1.0"

    # ---- 基础工具 ----
    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def log_message(self, fmt, *args):  # 安静一点, 只在需要时由调用方打印
        return

    # ---- 静态资源 ----
    def _serve_static(self, rel: str) -> None:
        if rel == "/":
            rel = "/index.html"
        target = os.path.normpath(os.path.join(_STATIC_DIR, rel.lstrip("/")))
        if not target.startswith(_STATIC_DIR) or not os.path.isfile(target):
            self.send_error(404, "Not Found")
            return
        ext = os.path.splitext(target)[1]
        with open(target, "rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", _STATIC_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ---- 路由 ----
    def do_GET(self):  # noqa: N802
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            try:
                self._handle_api_get(path)
            except ValueError as exc:
                self._send_json({"error": str(exc)}, status=400)
            return
        self._serve_static(path)

    def do_POST(self):  # noqa: N802
        path = urlparse(self.path).path
        try:
            data = self._read_json()
            with self.server.state.lock:
                self._handle_api_post(path, data)
                self.server.state.save()
        except ValueError as exc:
            self._send_json({"error": str(exc)}, status=400)
        except json.JSONDecodeError:
            self._send_json({"error": "请求体不是合法 JSON"}, status=400)

    def do_DELETE(self):  # noqa: N802
        path = urlparse(self.path).path
        try:
            with self.server.state.lock:
                self._handle_api_delete(path)
                self.server.state.save()
        except ValueError as exc:
            self._send_json({"error": str(exc)}, status=400)

    # ---- API: GET ----
    def _handle_api_get(self, path: str) -> None:
        state: AppState = self.server.state
        if path == "/api/jar":
            self._send_json(_jar_view(state.jar))
        elif path == "/api/samples":
            self._send_json({"samples": [
                {
                    "id": s.id,
                    "title": s.title,
                    "description": s.description,
                    "source_url": s.source_url,
                    "set_cookies": s.set_cookies,
                    "request_url": s.request_url,
                    "top_url": s.top_url,
                    "method": s.method,
                    "is_navigation": s.is_navigation,
                    "document_url": s.document_url,
                }
                for s in SAMPLES
            ]})
        else:
            self._send_json({"error": "未知接口"}, status=404)

    # ---- API: POST ----
    def _handle_api_post(self, path: str, data: dict) -> None:
        state: AppState = self.server.state
        if path == "/api/set-cookie":
            source_url = data.get("source_url", "")
            source = parse_url(source_url)  # 提前校验, 失败抛 ValueError
            raws = data.get("set_cookies")
            if isinstance(raws, str):
                raws = [r for r in (line.strip() for line in raws.splitlines()) if r]
            if not raws:
                raise ValueError("没有提供 Set-Cookie 内容")
            results = []
            for raw in raws:
                parsed = parse_set_cookie(raw, source_url)
                if parsed.accepted:
                    cookie = state.jar.add(parsed.cookie)
                    results.append({
                        "accepted": True,
                        "raw": raw,
                        "warnings": parsed.warnings,
                        "cookie": cookie.to_dict(),
                    })
                else:
                    state.jar.reject(raw, source.host, parsed.reason,
                                     "; ".join(parsed.warnings))
                    results.append({
                        "accepted": False,
                        "raw": raw,
                        "reason": parsed.reason,
                        "warnings": parsed.warnings,
                    })
            self._send_json({"results": results, "jar": _jar_view(state.jar)})

        elif path == "/api/evaluate":
            decision = evaluate_request(
                state.jar,
                data["request_url"],
                data["top_url"],
                method=data.get("method", "GET"),
                is_navigation=bool(data.get("is_navigation", False)),
            )
            self._send_json(decision.to_dict())

        elif path == "/api/script-view":
            view = script_readable_cookies(state.jar, data["document_url"])
            self._send_json(view.to_dict())

        elif path == "/api/load-sample":
            sample = get_sample(data.get("sample_id", ""))
            if sample is None:
                raise ValueError("样例不存在")
            state.jar = build_sample_jar(sample, now=SAMPLE_NOW)
            self._send_json({"sample_id": sample.id, "jar": _jar_view(state.jar)})

        elif path == "/api/clear":
            state.jar.clear()
            self._send_json(_jar_view(state.jar))

        elif path == "/api/purge-expired":
            removed = state.jar.purge_expired()
            self._send_json({"removed": removed, "jar": _jar_view(state.jar)})

        else:
            self._send_json({"error": "未知接口"}, status=404)

    # ---- API: DELETE ----
    def _handle_api_delete(self, path: str) -> None:
        state: AppState = self.server.state
        prefix = "/api/cookie?"
        if not path.startswith(prefix):
            self._send_json({"error": "未知接口"}, status=404)
            return
        query = parse_qs(urlparse(self.path).query)
        try:
            name = query["name"][0]
            domain = query["domain"][0]
            cookie_path = query["path"][0]
        except (KeyError, IndexError):
            raise ValueError("删除需要 name/domain/path 三个参数")
        ok = state.jar.delete(name, domain, cookie_path)
        if not ok:
            raise ValueError("指定的 cookie 不存在")
        self._send_json(_jar_view(state.jar))


def create_server(host: str, port: int, storage_path: str) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), CookieHandler)
    server.state = AppState(storage_path)
    return server
