"""基于标准库 ThreadingHTTPServer 的本地 Web 服务。

每个请求独立连接 SQLite；写操作在 service 层以 BEGIN IMMEDIATE
串行化，因此多线程并发点击退出时只有一个事务能先通过管理员检查。
"""

from __future__ import annotations

import os
from http.cookies import SimpleCookie
from urllib.parse import parse_qs, urlparse

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import db, service, templates

COOKIE_NAME = "session_token"


class OrgHTTPServer(ThreadingHTTPServer):
    # 默认 backlog 只有 5，多个页面同时提交时会拒绝连接；调大以容纳突发并发。
    request_queue_size = 128
    daemon_threads = True


class AppState:
    def __init__(self, db_path):
        self.db_path = db_path


def make_handler(state: AppState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "LocalOrgAdmin/1.0"

        def log_message(self, fmt, *args):  # 安静一点，测试时不刷屏
            pass

        # ------------------------------------------------ 基础工具

        def _cookie_token(self) -> str | None:
            raw = self.headers.get("Cookie")
            if not raw:
                return None
            cookie = SimpleCookie()
            cookie.load(raw)
            morsel = cookie.get(COOKIE_NAME)
            return morsel.value if morsel else None

        def _current_user(self):
            return service.get_session_user(state.db_path, self._cookie_token())

        def _send_html(self, content: bytes, status: int = 200) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)

        def _redirect(self, location: str, set_cookie: str | None = None) -> None:
            self.send_response(303)
            self.send_header("Location", location)
            if set_cookie:
                self.send_header("Set-Cookie", set_cookie)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def _read_form(self) -> dict[str, str]:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode("utf-8") if length else ""
            parsed = parse_qs(raw, keep_blank_values=True)
            return {k: v[0] for k, v in parsed.items()}

        def _flash(self, query: dict[str, list[str]]):
            flash = query.get("flash", [None])[0]
            msg = query.get("msg", [None])[0]
            return flash, msg

        def _require_org(self, conn, org_id: int):
            org = conn.execute(
                "SELECT * FROM orgs WHERE id = ?", (org_id,)
            ).fetchone()
            if org is None:
                self._send_html(templates._page(
                    "未找到机构", "<div class='card'>机构不存在。</div>",
                    self._current_user()), 404)
                return None
            return org

        # ------------------------------------------------ GET

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            path = parsed.path
            query = parse_qs(parsed.query, keep_blank_values=True)
            user = self._current_user()

            if path == "/login":
                if user:
                    self._redirect("/")
                else:
                    flash, msg = self._flash(query)
                    self._send_html(templates.login_page(flash, msg))
                return

            if user is None:
                self._redirect(templates.redirect("/login", "err", "请先登录")[0])
                return

            if path == "/":
                conn = db.connect(state.db_path)
                try:
                    flash, msg = self._flash(query)
                    self._send_html(templates.home_page(conn, user, flash, msg))
                finally:
                    conn.close()
                return

            if path.startswith("/orgs/"):
                rest = path[len("/orgs/"):].strip("/").split("/")
                if len(rest) == 1 and rest[0].isdigit():
                    self._handle_org_page(int(rest[0]), user, query)
                    return
                if len(rest) == 2 and rest[0].isdigit() and rest[1] == "audit":
                    self._handle_audit_page(int(rest[0]), user)
                    return

            self._send_html(templates._page(
                "未找到", "<div class='card'>页面不存在。</div>", user), 404)

        def _handle_org_page(self, org_id: int, user, query) -> None:
            conn = db.connect(state.db_path)
            try:
                org = self._require_org(conn, org_id)
                if org is None:
                    return
                membership = service.get_membership(conn, org_id, user["id"])
                if membership is None:
                    loc = templates.redirect(
                        "/", "err", "你不在该机构中，无权查看")[0]
                    self._redirect(loc)
                    return
                flash, msg = self._flash(query)
                self._send_html(
                    templates.org_page(conn, org, user, membership, flash, msg))
            finally:
                conn.close()

        def _handle_audit_page(self, org_id: int, user) -> None:
            conn = db.connect(state.db_path)
            try:
                org = self._require_org(conn, org_id)
                if org is None:
                    return
                membership = service.get_membership(conn, org_id, user["id"])
                if membership is None:
                    self._redirect(templates.redirect(
                        "/", "err", "你不在该机构中，无权查看")[0])
                    return
                self._send_html(templates.audit_page(conn, org, user))
            finally:
                conn.close()

        # ------------------------------------------------ POST

        def do_POST(self) -> None:
            parsed = urlparse(self.path)
            path = parsed.path

            if path == "/login":
                self._handle_login()
                return
            if path == "/logout":
                self._handle_logout()
                return

            user = self._current_user()
            if user is None:
                self._redirect("/login")
                return

            if path.startswith("/orgs/"):
                rest = path[len("/orgs/"):].strip("/").split("/")
                # /orgs/<id>/leave 或 /orgs/<id>/members/<uid>/<action>
                if len(rest) == 2 and rest[0].isdigit() and rest[1] == "leave":
                    self._handle_leave(int(rest[0]), user)
                    return
                if (len(rest) == 4 and rest[0].isdigit()
                        and rest[1] == "members" and rest[2].isdigit()):
                    self._handle_member_action(
                        int(rest[0]), user, int(rest[2]), rest[3])
                    return

            self._send_html(templates._page(
                "未找到", "<div class='card'>请求的操作不存在。</div>", user), 404)

        def _handle_login(self) -> None:
            form = self._read_form()
            try:
                token, user = service.login(
                    state.db_path, form.get("username", ""), form.get("password", ""))
            except service.ServiceError as exc:
                loc = templates.redirect("/login", "err", str(exc))[0]
                self._redirect(loc)
                return
            cookie = (
                f"{COOKIE_NAME}={token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400"
            )
            self._redirect("/", set_cookie=cookie)

        def _handle_logout(self) -> None:
            service.logout(state.db_path, self._cookie_token())
            cookie = f"{COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0"
            self._redirect("/login", set_cookie=cookie)

        def _handle_leave(self, org_id: int, user) -> None:
            try:
                result = service.leave_org(state.db_path, org_id, user["id"])
            except service.ServiceError as exc:
                self._redirect(templates.redirect(
                    f"/orgs/{org_id}", "err", str(exc))[0])
                return
            if result.ok:
                # 退出后不再属于该机构，回到机构列表页提示
                self._redirect(templates.redirect("/", "ok", result.message)[0])
            else:
                self._redirect(templates.redirect(
                    f"/orgs/{org_id}", "err", result.message)[0])

        def _handle_member_action(self, org_id: int, user, target_id: int,
                                  action: str) -> None:
            try:
                if action == "promote":
                    result = service.set_role(
                        state.db_path, org_id, user["id"], target_id, "admin")
                elif action == "demote":
                    result = service.set_role(
                        state.db_path, org_id, user["id"], target_id, "member")
                elif action == "disable":
                    result = service.set_active(
                        state.db_path, org_id, user["id"], target_id, False)
                elif action == "activate":
                    result = service.set_active(
                        state.db_path, org_id, user["id"], target_id, True)
                elif action == "remove":
                    result = service.remove_member(
                        state.db_path, org_id, user["id"], target_id)
                else:
                    self._redirect(templates.redirect(
                        f"/orgs/{org_id}", "err", "未知操作")[0])
                    return
            except service.ServiceError as exc:
                self._redirect(templates.redirect(
                    f"/orgs/{org_id}", "err", str(exc))[0])
                return
            flash_type = "ok" if result.ok else "err"
            self._redirect(templates.redirect(
                f"/orgs/{org_id}", flash_type, result.message)[0])

    return Handler


def create_server(host: str = "127.0.0.1", port: int = 8000,
                  db_path=db.DEFAULT_DB_PATH) -> ThreadingHTTPServer:
    db.init_db(db_path)
    state = AppState(db_path)
    return OrgHTTPServer((host, port), make_handler(state))


def main() -> None:
    port = int(os.environ.get("PORT", "8000"))
    httpd = create_server(port=port)
    print(f"机构成员管理服务已启动：http://127.0.0.1:{port}")
    print("演示账号 jia / yi / bing / ding / wu，密码均为 pass1234")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
