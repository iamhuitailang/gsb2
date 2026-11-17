"""HTTP 层（仅监听 127.0.0.1）。

端点约定：

* ``POST /api/login``         普通登录。来源取 TCP 对端地址，请求体里即使带
                              ``source`` 也一律忽略 —— 用户不能自己指定来源。
* ``POST /api/demo/login``    本地测试入口，允许在请求体中传 ``source`` 模拟
                              不同来源，仅本机可访问。
* ``POST /api/demo/clock``    推进/回拨/重置演示时钟。
* ``GET  /api/demo/status``   查询账号层与来源层窗口（含截止时间、可重试秒数）。
* ``GET  /api/demo/admin-log`` 管理员日志（标出每次拦截生效的是哪一层）。
* ``GET  /``                  演示页面。

对外失败响应文案与 HTTP 状态码完全一致，不区分密码错误、账号锁定、来源锁定。
"""
from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .config import Config
from .rate_limit import GENERIC_FAILURE
from .service import LoginService

_FAILURE_STATUS = 401
_SUCCESS_STATUS = 200


class LoginHttpHandler(BaseHTTPRequestHandler):
    server_version = "LocalLoginSvc/1.0"
    service: LoginService = None  # 由 build_server 注入

    # ---- 基础工具 -------------------------------------------------------

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _failure(self) -> None:
        # 统一文案、统一状态码，对外不暴露任何限流细节
        self._send_json(_FAILURE_STATUS, {"success": False, "message": GENERIC_FAILURE})

    def _read_json_body(self) -> dict | None:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > self.service.config.max_body_bytes:
            return None
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None
        return data if isinstance(data, dict) else None

    def _is_loopback(self) -> bool:
        return self.client_address[0] in ("127.0.0.1", "::1", "localhost")

    def _deny_external(self) -> bool:
        if self._is_loopback():
            return False
        self._send_json(403, {"success": False, "message": "演示入口仅允许本机访问"})
        return True

    def log_message(self, fmt: str, *args) -> None:  # 静音默认访问日志
        return

    # ---- 路由 -----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 (http.server 命名)
        path = urlparse(self.path).path
        if path == "/":
            self._serve_page()
        elif path == "/api/demo/status":
            self._handle_status(urlparse(self.path).query)
        elif path == "/api/demo/admin-log":
            if self._deny_external():
                return
            self._handle_admin_log()
        elif path == "/health":
            self._send_json(200, {"ok": True, "now": self.service.clock.now()})
        else:
            self._send_json(404, {"success": False, "message": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/login":
            self._handle_login(user_selectable_source=False)
        elif path == "/api/demo/login":
            if self._deny_external():
                return
            self._handle_login(user_selectable_source=True)
        elif path == "/api/demo/clock":
            if self._deny_external():
                return
            self._handle_clock()
        else:
            self._send_json(404, {"success": False, "message": "not found"})

    # ---- 业务处理 -------------------------------------------------------

    def _handle_login(self, user_selectable_source: bool) -> None:
        data = self._read_json_body()
        if data is None:
            self._failure()
            return
        username = str(data.get("username") or "").strip()
        password = str(data.get("password") or "")
        if not username or not password:
            self._failure()
            return

        if user_selectable_source:
            source = str(data.get("source") or "").strip()
            if not self.service.is_valid_source(source):
                self._send_json(400, {"success": False, "message": "来源标识不合法"})
                return
        else:
            # 普通接口：来源由服务端按 TCP 对端确定，忽略请求体中的 source
            source = f"ip:{self.client_address[0]}"

        result = self.service.limiter.attempt(username, password, source)
        if not result.success:
            self._failure()
            return

        self._send_json(
            _SUCCESS_STATUS,
            {
                "success": True,
                "message": "登录成功",
                "username": username,
                "source": source,
                "source_window": self._window_payload(result.source_state),
            },
        )

    def _handle_clock(self) -> None:
        data = self._read_json_body()
        if data is None:
            self._send_json(400, {"success": False, "message": "请求体不合法"})
            return
        action = str(data.get("action") or "advance")
        if action == "reset":
            now = self.service.clock.reset()
        else:
            try:
                seconds = int(data.get("seconds", 0))
            except (TypeError, ValueError):
                self._send_json(400, {"success": False, "message": "seconds 必须是整数"})
                return
            now = self.service.clock.advance(seconds)
        self._send_json(200, {"success": True, "now": now})

    def _handle_status(self, query: str) -> None:
        params = parse_qs(query)
        username = (params.get("username") or [""])[0].strip()
        source = (params.get("source") or [""])[0].strip()
        if not username or not source:
            self._send_json(400, {"success": False, "message": "username 和 source 都是必填项"})
            return
        if not self.service.is_valid_source(source):
            self._send_json(400, {"success": False, "message": "来源标识不合法"})
            return
        self._send_json(
            200,
            {
                "now": self.service.clock.now(),
                "username": username,
                "source": source,
                "account_window": self._window_payload(self.service.limiter.account_state(username)),
                "source_window": self._window_payload(self.service.limiter.source_state(source)),
            },
        )

    def _handle_admin_log(self) -> None:
        self._send_json(200, {"entries": self.service.admin_log.recent(200)})

    @staticmethod
    def _window_payload(state) -> dict:
        return {
            "scope": state.scope,
            "key": state.key,
            "failures": state.failures,
            "limit": state.limit,
            "blocked": state.blocked,
            "deadline": state.deadline,
            "window_seconds": state.window_seconds,
            "retry_after": state.retry_after,
        }

    def _serve_page(self) -> None:
        page_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "index.html")
        try:
            with open(page_path, "rb") as f:
                body = f.read()
        except OSError:
            self._send_json(404, {"success": False, "message": "page missing"})
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def build_server(config: Config | None = None) -> tuple[ThreadingHTTPServer, LoginService]:
    service = LoginService(config)
    handler = type("BoundHandler", (LoginHttpHandler,), {"service": service})
    httpd = ThreadingHTTPServer((service.config.host, service.config.port), handler)
    return httpd, service
