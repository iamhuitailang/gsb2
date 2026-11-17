"""Minimal local HTTP workbench.

The server intentionally has no third-party dependencies and is bound to
127.0.0.1.  Cookies are HttpOnly + SameSite=Strict, every mutating request
needs the session-bound CSRF token, and request bodies (which may contain the
operator's password or the permit) are never logged.
"""

from __future__ import annotations

import argparse
import json
import logging
import mimetypes
import os
import re
import secrets
import sys
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from . import db as dbm
from .service import (
    CsrfRejected,
    NotFound,
    Unauthorized,
    Workbench,
    WorkbenchError,
    create_workbench,
)

COOKIE_NAME = "wb_session"
STATIC_DIR = Path(__file__).resolve().parent / "static"
MAX_BODY = 64 * 1024
API_RE = re.compile(r"^/api/history/([0-9a-f]{32})$")

log = logging.getLogger("workbench")


def _read_secret(path: Path) -> bytes:
    if path.exists():
        data = path.read_bytes()[:64]
        if len(data) >= 32:
            return data
    path.parent.mkdir(parents=True, exist_ok=True)
    secret = secrets.token_bytes(48)
    path.write_bytes(secret)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return secret


class Handler(BaseHTTPRequestHandler):
    server_version = "ArchiveWorkbench/1.0"
    sys_version = ""

    workbench: Workbench
    quiet: bool = False

    # ------------------------------------------------------------------ utils

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        # Never log headers/cookies; only the request line is retained.
        if not self.quiet:
            log.info("%s %s", self.command, self.path.split("?", 1)[0])

    def _send(self, status: int, body: bytes, content_type: str, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; "
            "base-uri 'none'; form-action 'self'",
        )
        for key, value in (headers or []):
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, payload, headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8", headers)

    def _error(self, exc: WorkbenchError):
        payload = {"error": exc.code, "message": exc.message}
        if exc.manifest is not None:
            payload["manifest"] = exc.manifest
        if exc.operation is not None:
            payload["operation"] = exc.operation
        self._json(exc.status, payload)

    def _cookie_token(self) -> str | None:
        header = self.headers.get("Cookie")
        if not header:
            return None
        try:
            cookie = SimpleCookie()
            cookie.load(header)
        except Exception:
            return None
        morsel = cookie.get(COOKIE_NAME)
        return morsel.value if morsel else None

    def _session(self):
        return self.workbench.session_for_token(self._cookie_token())

    def _body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length < 0 or length > MAX_BODY:
            raise WorkbenchError("请求体过大。")
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise WorkbenchError("请求格式无效。")
        if not isinstance(data, dict):
            raise WorkbenchError("请求格式无效。")
        return data

    def _require_session(self):
        session = self._session()
        if session is None:
            raise Unauthorized("请先登录。")
        return session

    def _require_csrf(self, session) -> None:
        header = self.headers.get("X-CSRF-Token", "")
        if not self.workbench.verify_csrf(session, header):
            raise CsrfRejected("CSRF 校验失败，请刷新页面后重试。")

    # ----------------------------------------------------------------- routes

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            if path == "/":
                self._serve_static("index.html", "text/html; charset=utf-8")
            elif path.startswith("/static/"):
                name = path[len("/static/"):]
                if "/" in name or name.startswith("."):
                    raise NotFound("资源不存在。")
                self._serve_static(name)
            elif path == "/api/state":
                session = self._require_session()
                state = self.workbench.active_scope(session)
                state["user"] = session.username
                state["csrf"] = self.workbench.csrf_for(session)
                self._json(200, state)
            elif path == "/api/preview":
                session = self._require_session()
                self._json(200, self.workbench.preview(session))
            elif path == "/api/history":
                self._require_session()
                self._json(200, {"operations": self.workbench.cleanup_history()})
            elif path == "/healthz":
                self._json(200, {"ok": True})
            else:
                match = API_RE.match(path)
                if match:
                    self._require_session()
                    operation_id = match.group(1)
                    self._json(
                        200,
                        {
                            "operation": self.workbench.operation(operation_id),
                            "audit": self.workbench.audit_for_operation(operation_id),
                        },
                    )
                else:
                    raise NotFound("资源不存在。")
        except WorkbenchError as exc:
            if exc.status == 404 and path.startswith("/static/"):
                self._send(404, b"not found", "text/plain; charset=utf-8")
            else:
                self._error(exc)
        except Exception:
            log.exception("unhandled GET error")
            self._json(500, {"error": "internal", "message": "服务器内部错误。"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            data = self._body()

            if path == "/api/login":
                username = str(data.get("username", ""))[:64]
                password = str(data.get("password", ""))[:256]
                raw, session, csrf = self.workbench.login(username, password)
                cookie = (
                    f"{COOKIE_NAME}={raw}; HttpOnly; SameSite=Strict; "
                    "Path=/; Max-Age=28800"
                )
                state = self.workbench.active_scope(session)
                state["user"] = session.username
                state["csrf"] = csrf
                self._json(200, state, headers=[("Set-Cookie", cookie)])
                return

            session = self._require_session()
            self._require_csrf(session)

            if path == "/api/logout":
                self.workbench.logout(session)
                cookie = (
                    f"{COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; "
                    "Max-Age=0"
                )
                self._json(200, {"ok": True}, headers=[("Set-Cookie", cookie)])
                return

            if path == "/api/scope":
                manifest = self.workbench.set_scope(
                    session,
                    int(data.get("folder_id", 0)),
                    str(data.get("batch", "")),
                    str(data.get("keyword", "")),
                )
                self._json(200, manifest)
            elif path == "/api/confirm":
                result = self.workbench.confirm(
                    session,
                    folder_id=int(data.get("folder_id", 0)),
                    batch=str(data.get("batch", "")),
                    keyword=str(data.get("keyword", "")),
                    expected_digest=str(data.get("digest", "")),
                    password=str(data.get("password", ""))[:256],
                )
                self._json(200, result)
            elif path == "/api/submit":
                result = self.workbench.submit(
                    session, str(data.get("permit", ""))[:512]
                )
                self._json(200, result)
            elif path == "/api/discard":
                self.workbench.discard_permit(
                    session, str(data.get("permit", ""))[:512]
                )
                self._json(200, {"ok": True})
            elif path == "/api/preview":
                self._json(200, self.workbench.preview(session))
            else:
                raise NotFound("资源不存在。")
        except WorkbenchError as exc:
            self._error(exc)
        except (TypeError, ValueError):
            self._json(400, {"error": "bad_request", "message": "请求参数无效。"})
        except Exception:
            log.exception("unhandled POST error")
            self._json(500, {"error": "internal", "message": "服务器内部错误。"})

    # ---------------------------------------------------------------- static

    def _serve_static(self, name: str, content_type: str | None = None) -> None:
        static_root = STATIC_DIR.resolve()
        target = (static_root / name).resolve()
        if target != static_root and static_root not in target.parents:
            raise NotFound("资源不存在。")
        if not target.is_file():
            raise NotFound("资源不存在。")
        if content_type is None:
            content_type = (
                mimetypes.guess_type(str(target))[0]
                or "application/octet-stream"
            )
        self._send(200, target.read_bytes(), content_type)


def serve(
    db_path: str | Path,
    secret_path: str | Path,
    host: str = "127.0.0.1",
    port: int = 8765,
    *,
    quiet: bool = False,
) -> ThreadingHTTPServer:
    secret = _read_secret(Path(secret_path))
    workbench = create_workbench(db_path, secret)
    handler = type("BoundHandler", (Handler,), {"workbench": workbench, "quiet": quiet})
    httpd = ThreadingHTTPServer((host, port), handler)
    httpd.daemon_threads = True
    return httpd


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="归档清理工作台（本地）")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--db", default=str(dbm.resolve_db_path()), help="SQLite database path"
    )
    parser.add_argument(
        "--secret",
        default=str(Path(dbm.resolve_db_path()).parent / "workbench.secret"),
        help="file holding the CSRF signing secret",
    )
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.WARNING if args.quiet else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    httpd = serve(args.db, args.secret, args.host, args.port, quiet=args.quiet)
    host, port = httpd.server_address[:2]
    print(f"归档清理工作台已启动：http://{host}:{port}/", file=sys.stderr)
    print(
        f"账号与密码见 README（默认账号 {dbm.DEFAULT_USERNAME}）。",
        file=sys.stderr,
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
