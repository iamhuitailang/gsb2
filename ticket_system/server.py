"""HTTP 服务：登录、分页、批量预览与执行、结果查询。"""

from __future__ import annotations

import hmac
import json
import re
import sqlite3
import sys
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from . import service
from .db import connect

STATIC_DIR = Path(__file__).parent / "static"
MAX_BODY_BYTES = 1 << 20

_TICKET_PATH = re.compile(r"^/api/tickets/(\d+)(/transfer|/audit)?$")
_BATCH_PATH = re.compile(r"^/api/close-batches/(\d+)$")


class ApiHandler(BaseHTTPRequestHandler):
    server_version = "TicketSystem/1.0"
    protocol_version = "HTTP/1.1"

    db_path: str = "tickets.db"

    _raw_body: bytes | None = None

    # -- 基础工具 -------------------------------------------------------
    def log_message(self, fmt: str, *args: Any) -> None:  # pragma: no cover
        if self.server.verbose:  # type: ignore[attr-defined]
            sys.stderr.write(f"[{self.log_date_time_string()}] {fmt % args}\n")

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, status: int, code: str, message: str) -> None:
        self._send_json(status, {"error": {"code": code, "message": message}})

    def _read_raw_body(self) -> bytes:
        """在路由/鉴权之前读完请求体，避免 HTTP/1.1 长连接上残留字节。"""
        length = self.headers.get("Content-Length")
        if not length:
            return b""
        try:
            size = int(length)
        except ValueError:
            # 长度不可解析时无法确定要读多少字节，断开连接避免串包
            self.close_connection = True
            raise service.ApiError(400, "invalid_body", "请求体长度非法")
        if size < 0 or size > MAX_BODY_BYTES:
            # 超限时不能安全跳过，直接断开连接
            self.close_connection = True
            raise service.ApiError(413, "body_too_large", "请求体过大")
        chunks: list[bytes] = []
        remaining = size
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 65536))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def _read_json(self) -> dict[str, Any]:
        raw = self._raw_body or b""
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise service.ApiError(400, "invalid_json", "请求体不是合法 JSON")
        if not isinstance(data, dict):
            raise service.ApiError(400, "invalid_json", "请求体必须是 JSON 对象")
        return data

    def _session_token(self) -> str:
        header = self.headers.get("Authorization", "")
        if header.lower().startswith("bearer "):
            return header[7:].strip()
        return self.headers.get("X-Session-Token", "").strip()

    def _require_user(self, conn: sqlite3.Connection) -> service.User:
        token = self._session_token()
        user = service.user_for_token(conn, token) if token else None
        if user is None:
            raise service.ApiError(401, "not_authenticated", "请先登录")
        return user

    def _require_csrf(self, conn: sqlite3.Connection) -> None:
        token = self._session_token()
        expected = service.session_csrf_token(conn, token) if token else None
        supplied = self.headers.get("X-CSRF-Token", "")
        # 头部可能带非 ASCII 字节，统一按字节比较，避免 compare_digest 抛 TypeError
        ok = bool(expected) and hmac.compare_digest(
            supplied.encode("utf-8", "surrogateescape"),
            expected.encode("utf-8"),
        )
        if not ok:
            raise service.ApiError(403, "invalid_csrf", "CSRF 校验失败，请刷新页面")

    # -- 路由 -----------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        conn = connect(self.db_path)
        try:
            # GET 一般不带宽体；若带了也必须读掉，否则长连接上的下一请求会错位
            self._read_raw_body()
            if parsed.path.startswith("/api/"):
                self._handle_api_get(conn, parsed.path, parse_qs(parsed.query))
            else:
                self._serve_static(parsed.path)
        except service.ApiError as exc:
            self._send_error_json(exc.status, exc.code, exc.message)
        except Exception:  # pragma: no cover - 兜底
            self._send_error_json(500, "internal_error", "服务器内部错误")
        finally:
            self._raw_body = None
            conn.close()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        conn = connect(self.db_path)
        try:
            self._raw_body = self._read_raw_body()
            self._handle_api_post(conn, parsed.path)
        except service.ApiError as exc:
            self._send_error_json(exc.status, exc.code, exc.message)
        except Exception:  # pragma: no cover - 兜底
            self._send_error_json(500, "internal_error", "服务器内部错误")
        finally:
            self._raw_body = None
            conn.close()

    def _handle_api_get(
        self, conn: sqlite3.Connection, path: str, query: dict[str, list[str]]
    ) -> None:
        if path == "/api/groups":
            self._require_user(conn)
            self._send_json(200, {"groups": service.list_groups(conn)})
            return

        if path == "/api/me":
            user = self._require_user(conn)
            self._send_json(200, {"user": user.as_dict()})
            return

        if path == "/api/tickets":
            user = self._require_user(conn)
            group_id = user.group_id
            if user.is_admin:
                # 管理员可指定小组；不指定时默认第一个小组
                requested = query.get("group_id")
                if requested:
                    try:
                        group_id = int(requested[0])
                    except ValueError:
                        raise service.ApiError(400, "invalid_query", "group_id 必须是整数")
                else:
                    groups = service.list_groups(conn)
                    group_id = groups[0]["id"] if groups else None
            if group_id is None:
                raise service.ApiError(403, "no_group", "当前账号不属于任何小组")
            page = _int_param(query, "page", 1)
            page_size = _int_param(query, "page_size", 10)
            self._send_json(
                200,
                service.list_group_tickets(
                    conn, group_id=group_id, page=page, page_size=page_size
                ),
            )
            return

        match = _TICKET_PATH.match(path)
        if match:
            user = self._require_user(conn)
            ticket_id = int(match.group(1))
            suffix = match.group(2)
            if suffix == "/audit":
                self._require_own_group_ticket(conn, user, ticket_id)
                self._send_json(200, {"audit": service.audit_log(conn, ticket_id)})
                return
            raise service.ApiError(404, "not_found", "接口不存在")

        match = _BATCH_PATH.match(path)
        if match:
            user = self._require_user(conn)
            batch = service.get_batch(conn, user, int(match.group(1)))
            self._send_json(200, {"batch": batch})
            return

        raise service.ApiError(404, "not_found", "接口不存在")

    def _require_own_group_ticket(
        self, conn: sqlite3.Connection, user: service.User, ticket_id: int
    ) -> None:
        row = service.get_ticket(conn, ticket_id)
        if row is None or (not user.is_admin and row["group_id"] != user.group_id):
            raise service.ApiError(404, "ticket_not_found", "工单不存在")

    def _handle_api_post(self, conn: sqlite3.Connection, path: str) -> None:
        if path == "/api/login":
            body = self._read_json()
            username = body.get("username")
            password = body.get("password")
            if not isinstance(username, str) or not isinstance(password, str):
                raise service.ApiError(400, "invalid_credentials", "请输入用户名和密码")
            user = service.authenticate(conn, username.strip(), password)
            session = service.create_session(conn, user)
            self._send_json(200, {**session, "user": user.as_dict()})
            return

        if path == "/api/logout":
            token = self._session_token()
            if token:
                service.delete_session(conn, token)
            self._send_json(200, {"ok": True})
            return

        user = self._require_user(conn)
        self._require_csrf(conn)

        if path == "/api/close-batches/preview":
            body = self._read_json()
            result = service.preview_batch(conn, user, body.get("ticket_ids"))
            self._send_json(200, result)
            return

        if path == "/api/close-batches":
            body = self._read_json()
            result = service.close_batch(
                conn, user, body.get("ticket_ids"), body.get("batch_key")
            )
            self._send_json(200, {"batch": result})
            return

        match = _TICKET_PATH.match(path)
        if match and match.group(2) == "/transfer":
            if not user.is_admin:
                raise service.ApiError(403, "not_admin", "只有管理员可以转移工单")
            body = self._read_json()
            to_group_id = body.get("to_group_id")
            if isinstance(to_group_id, bool) or not isinstance(to_group_id, int):
                raise service.ApiError(400, "invalid_group", "to_group_id 必须是整数")
            result = service.transfer_ticket(conn, user, int(match.group(1)), to_group_id)
            self._send_json(200, {"transfer": result})
            return

        raise service.ApiError(404, "not_found", "接口不存在")

    # -- 静态文件 -------------------------------------------------------
    def _serve_static(self, path: str) -> None:
        if path in ("/", "/index.html"):
            file_path = STATIC_DIR / "index.html"
        else:
            root = STATIC_DIR.resolve()
            candidate = (root / path.lstrip("/")).resolve()
            # 用相对路径判定，避免 /static_evil 这类同前缀目录绕过
            try:
                candidate.relative_to(root)
            except ValueError:
                self._send_error_json(404, "not_found", "文件不存在")
                return
            file_path = candidate
        if not file_path.is_file():
            self._send_error_json(404, "not_found", "文件不存在")
            return
        content = file_path.read_bytes()
        content_type = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
        }.get(file_path.suffix, "application/octet-stream")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


def _int_param(query: dict[str, list[str]], name: str, default: int) -> int:
    values = query.get(name)
    if not values:
        return default
    try:
        return int(values[0])
    except ValueError:
        raise service.ApiError(400, "invalid_query", f"参数 {name} 必须是整数")


class TicketServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], db_path: str, verbose: bool = False):
        self.db_path = db_path
        self.verbose = verbose
        handler = type("ConfiguredHandler", (ApiHandler,), {"db_path": db_path})
        super().__init__(address, handler)


def serve(db_path: str = "tickets.db", host: str = "127.0.0.1", port: int = 8000,
          verbose: bool = True) -> None:
    server = TicketServer((host, port), db_path, verbose=verbose)
    actual_host, actual_port = server.server_address[:2]
    print(f"工单系统已启动: http://{actual_host}:{actual_port}")
    print(f"数据库文件: {Path(db_path).resolve()}")
    print("按 Ctrl+C 停止。", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def serve_in_thread(db_path: str, port: int = 0) -> tuple[TicketServer, threading.Thread]:
    server = TicketServer(("127.0.0.1", port), db_path, verbose=False)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread
