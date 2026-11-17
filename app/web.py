"""Minimal local web UI for role management and audit verification."""

from __future__ import annotations

import html
import http.cookies
import json
import secrets
import sqlite3
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, quote, urlparse

from .auth import verify_password
from .canonical import payload_digest, payload_from_record, record_hash
from .report import (
    build_bundle,
    load_baseline,
    verify_bundle,
)
from .rules import rule_summary
from .service import Actor, PermissionDenied, RoleService
from .store import AuditError, Store

SESSION_COOKIE = "gsb2_session"
SESSION_TTL = 8 * 3600
MAX_BODY = 4 * 1024 * 1024
MAX_COPY_BYTES = 2 * 1024 * 1024


# ---------------------------------------------------------------------------
# Application state
# ---------------------------------------------------------------------------


@dataclass
class Session:
    token: str
    admin_id: str
    username: str
    org_id: str | None
    is_super: bool
    csrf: str
    expires_at: float


class App:
    def __init__(
        self,
        store: Store,
        *,
        copies_dir: Path | None = None,
    ) -> None:
        self.store = store
        self.service = RoleService(store)
        self.copies_dir = Path(copies_dir) if copies_dir else store.db_path.parent / "exports"
        self.sessions: dict[str, Session] = {}

    # -- sessions ------------------------------------------------------------

    def new_session(self, admin: dict[str, Any]) -> Session:
        token = secrets.token_urlsafe(32)
        session = Session(
            token=token,
            admin_id=admin["admin_id"],
            username=admin["username"],
            org_id=admin["org_id"],
            is_super=bool(admin["is_super"]),
            csrf=secrets.token_urlsafe(24),
            expires_at=time.time() + SESSION_TTL,
        )
        self.sessions[token] = session
        return session

    def get_session(self, token: str | None) -> Session | None:
        if not token:
            return None
        session = self.sessions.get(token)
        if session is None:
            return None
        if session.expires_at < time.time():
            self.sessions.pop(token, None)
            return None
        return session

    def actor(self, session: Session) -> Actor:
        return Actor(
            admin_id=session.admin_id,
            username=session.username,
            org_id=session.org_id,
            is_super=session.is_super,
        )

    def allowed_orgs(self, session: Session) -> list[dict[str, Any]]:
        orgs = self.store.list_orgs()
        if session.is_super:
            return orgs
        return [org for org in orgs if org["org_id"] == session.org_id]

    def resolve_org(self, session: Session, requested: str | None) -> str:
        allowed = {org["org_id"] for org in self.allowed_orgs(session)}
        if requested:
            if requested not in allowed:
                raise PermissionDenied("无权查看该机构")
            return requested
        if session.org_id and session.org_id in allowed:
            return session.org_id
        if allowed:
            return sorted(allowed)[0]
        raise PermissionDenied("没有可访问的机构")

    def list_copies(self, session: Session) -> list[Path]:
        """Copies visible to this admin; normal admins only see their org."""
        if not self.copies_dir.exists():
            return []
        visible: list[Path] = []
        for path in sorted(self.copies_dir.glob("*.json")):
            if not path.is_file():
                continue
            if session.is_super:
                visible.append(path)
                continue
            try:
                bundle = json.loads(path.read_text("utf-8"))
            except (OSError, ValueError):
                continue
            org = bundle.get("org") if isinstance(bundle, dict) else None
            if isinstance(org, dict) and org.get("org_id") == session.org_id:
                visible.append(path)
        return visible


# ---------------------------------------------------------------------------
# HTML helpers
# ---------------------------------------------------------------------------


def esc(value: Any) -> str:
    return html.escape("" if value is None else str(value))


STYLE = """
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin:0; font: 15px/1.55 -apple-system, "Segoe UI", "Noto Sans SC", sans-serif;
       background:#f4f5f7; color:#1c2024; }
header { background:#1f2937; color:#f9fafb; padding: 12px 24px; display:flex;
         align-items:center; gap:20px; flex-wrap:wrap; }
header h1 { font-size:16px; margin:0; font-weight:600; letter-spacing:.02em; }
nav { display:flex; gap:14px; margin-left:auto; flex-wrap:wrap; }
nav a { color:#d1d5db; text-decoration:none; font-size:14px; }
nav a:hover, nav a.active { color:#fff; text-decoration:underline; }
main { max-width:1120px; margin: 24px auto 64px; padding: 0 20px; }
h2 { font-size:20px; margin: 0 0 4px; }
h3 { font-size:16px; margin:24px 0 8px; }
.sub { color:#5b6470; margin:0 0 20px; font-size:14px; }
.card { background:#fff; border:1px solid #e3e6ea; border-radius:10px; padding:18px 20px;
        margin-bottom:18px; box-shadow:0 1px 2px rgba(16,24,40,.04); }
table { width:100%; border-collapse:collapse; font-size:14px; }
th, td { text-align:left; padding:8px 10px; border-bottom:1px solid #edf0f2; vertical-align:top; }
th { color:#5b6470; font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
tr:last-child td { border-bottom:none; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12.5px;
              word-break:break-all; }
label { display:block; font-size:13px; color:#4b5563; margin:0 0 4px; }
input[type=text], input[type=password], select, textarea {
  width:100%; padding:8px 10px; border:1px solid #cfd5dc; border-radius:7px; font:inherit;
  background:#fff; }
textarea { min-height:64px; resize:vertical; }
.row { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; }
button, .btn { display:inline-block; border:1px solid #1f2937; background:#1f2937; color:#fff;
               padding:8px 14px; border-radius:7px; font:inherit; cursor:pointer;
               text-decoration:none; }
button.secondary, .btn.secondary { background:#fff; color:#1f2937; }
button.danger { background:#b42318; border-color:#b42318; }
button.link { background:none; border:none; color:#b42318; padding:0; cursor:pointer;
              text-decoration:underline; font-size:14px; }
.inline { display:inline; }
.flash { background:#ecfdf3; border:1px solid #abefc6; color:#085d3a; padding:10px 14px;
         border-radius:8px; margin-bottom:16px; }
.flash.error { background:#fef3f2; border-color:#fecdca; color:#912018; }
.flash.warn { background:#fffaeb; border-color:#fedf89; color:#7a2e0e; }
.badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px;
         font-weight:600; }
.badge.ok { background:#ecfdf3; color:#067647; }
.badge.bad { background:#fef3f2; color:#b42318; }
.badge.warn { background:#fffaeb; color:#b54708; }
.badge.neutral { background:#f2f4f7; color:#475467; }
.muted { color:#667085; font-size:13px; }
.missing { color:#b42318; font-weight:600; }
.complete { color:#067647; font-weight:600; }
dl.kv { display:grid; grid-template-columns: 180px 1fr; gap:6px 18px; margin:0; }
dl.kv dt { color:#5b6470; font-size:13px; }
dl.kv dd { margin:0; font-size:14px; }
.right { text-align:right; }
"""


def page(
    title: str,
    session: Session | None,
    body: str,
    *,
    active: str = "",
    flash: tuple[str, str] | None = None,
) -> str:
    nav_items = []
    if session:
        current = "class=\"active\"" if active == "roles" else ""
        nav_items.append(f"<a href=\"/roles\" {current}>角色管理</a>")
        current = "class=\"active\"" if active == "audit" else ""
        nav_items.append(f"<a href=\"/audit\" {current}>审计记录</a>")
        current = "class=\"active\"" if active == "verify" else ""
        nav_items.append(f"<a href=\"/verify\" {current}>校验副本</a>")
        nav_items.append(
            f"<span class=\"muted\" style=\"color:#9ca3af\">"
            f"{esc(session.username)} · {esc(session.org_id or '全局')}</span>"
        )
        nav_items.append(
            "<form method=\"post\" action=\"/logout\" class=\"inline\">"
            f"<input type=\"hidden\" name=\"csrf\" value=\"{esc(session.csrf)}\">"
            "<button class=\"link\" style=\"color:#d1d5db\">退出</button></form>"
        )
    flash_html = ""
    if flash:
        kind, message = flash
        css = "" if kind == "ok" else f" {kind}"
        flash_html = f"<div class=\"flash{css}\">{esc(message)}</div>"
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)} · 角色管理后台</title><style>{STYLE}</style></head>
<body><header><h1>角色管理后台</h1><nav>{''.join(nav_items)}</nav></header>
<main>{flash_html}{body}</main></body></html>"""


def csrf_input(session: Session) -> str:
    return f"<input type=\"hidden\" name=\"csrf\" value=\"{esc(session.csrf)}\">"


def flash_from_query(query: dict[str, list[str]]) -> tuple[str, str] | None:
    message = query.get("msg", [""])[0]
    if not message:
        return None
    kind = query.get("kind", ["ok"])[0]
    if kind not in {"ok", "error", "warn"}:
        kind = "ok"
    return (kind, message)


def parse_multipart(
    content_type: str, body: bytes
) -> tuple[dict[str, str], dict[str, bytes]]:
    """Very small multipart/form-data parser (stdlib `cgi` is gone in 3.13).

    Returns ``(fields, files)``.  A part with a filename is treated as an
    uploaded file; everything else is decoded as a text field.
    """
    marker = "boundary="
    index = content_type.find(marker)
    if index == -1:
        return {}, {}
    boundary = content_type[index + len(marker):].split(";")[0].strip().strip('"')
    delimiter = b"--" + boundary.encode("latin-1")
    fields: dict[str, str] = {}
    files: dict[str, bytes] = {}
    for chunk in body.split(delimiter)[1:]:
        if chunk.startswith(b"--"):
            break
        chunk = chunk.lstrip(b"\r\n")
        head, separator, data = chunk.partition(b"\r\n\r\n")
        if not separator:
            continue
        data = data[:-2] if data.endswith(b"\r\n") else data
        headers = {}
        for line in head.decode("latin-1", "replace").split("\r\n"):
            name, _, value = line.partition(":")
            headers[name.strip().lower()] = value.strip()
        disposition = headers.get("content-disposition", "")
        name = _disposition_param(disposition, "name")
        if not name:
            continue
        if _disposition_param(disposition, "filename") is not None:
            files[name] = data
        else:
            fields[name] = data.decode("utf-8", "replace")
    return fields, files


def _disposition_param(disposition: str, key: str) -> str | None:
    for piece in disposition.split(";")[1:]:
        piece = piece.strip()
        if piece.startswith(key + "="):
            return piece[len(key) + 1:].strip().strip('"')
    return None


# ---------------------------------------------------------------------------
# Handlers / response plumbing
# ---------------------------------------------------------------------------


class Request:
    def __init__(self, handler: BaseHTTPRequestHandler, method: str) -> None:
        self.handler = handler
        parsed = urlparse(handler.path)
        self.path = parsed.path.rstrip("/") or "/"
        self.query = parse_qs(parsed.query, keep_blank_values=True)
        self.cookies = http.cookies.SimpleCookie()
        try:
            self.cookies.load(handler.headers.get("Cookie", ""))
        except http.cookies.CookieError:
            pass
        self.form: dict[str, str] = {}
        self.files: dict[str, bytes] = {}
        try:
            length = int(handler.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length < 0:
            length = 0
        if length > MAX_BODY:
            raise ValueError("请求体过大")
        body = handler.rfile.read(length) if method == "POST" and length else b""
        content_type = handler.headers.get("Content-Type", "")
        if method == "POST" and body:
            if content_type.startswith("multipart/form-data"):
                self.form, self.files = parse_multipart(content_type, body)
            else:
                form = parse_qs(body.decode("utf-8", "replace"), keep_blank_values=True)
                self.form = {key: values[0] for key, values in form.items()}
        self.method = method

    def cookie(self, name: str) -> str | None:
        morsel = self.cookies.get(name)
        return morsel.value if morsel else None


def redirect(location: str) -> "Response":
    return Response(HTTPStatus.SEE_OTHER, b"", headers={"Location": location})


class Response:
    def __init__(
        self, status: int, body: bytes | str, headers: dict[str, str] | None = None
    ) -> None:
        self.status = int(status)
        self.body = body.encode("utf-8") if isinstance(body, str) else body
        self.headers = headers or {}


Handler = Callable[[Request, Session | None], Response]


class Router:
    def __init__(self, app: App) -> None:
        self.app = app
        self.routes: list[tuple[str, str, Handler, bool, bool]] = []

    def add(
        self,
        method: str,
        path: str,
        handler: Handler,
        *,
        auth: bool = True,
        csrf: bool = True,
    ) -> None:
        self.routes.append((method, path, handler, auth, csrf))

    def dispatch(self, request: Request) -> Response:
        session = self.app.get_session(request.cookie(SESSION_COOKIE))
        for method, path, handler, auth, csrf in self.routes:
            if method != request.method or path != request.path:
                continue
            if auth and session is None:
                return redirect("/login")
            if csrf and request.method == "POST" and session is not None:
                token = request.form.get("csrf") or ""
                if not secrets.compare_digest(token, session.csrf):
                    return Response(
                        HTTPStatus.FORBIDDEN,
                        page("请求被拒绝", session, "<p>表单校验失败，请刷新后重试。</p>"),
                    )
            return handler(request, session)
        return Response(
            HTTPStatus.NOT_FOUND,
            page("页面不存在", session, "<p>页面不存在。</p>"),
        )


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------


def make_handlers(app: App, router: Router) -> None:
    store = app.store

    def login_form(request: Request, session: Session | None) -> Response:
        if session:
            return redirect("/roles")
        body = """
<h2>登录</h2>
<p class="sub">本地角色管理后台。所有角色变更都会写入审计记录。</p>
<div class="card"><form method="post" action="/login">
  <div style="margin-bottom:12px"><label for="u">用户名</label>
    <input id="u" name="username" type="text" autocomplete="username" required></div>
  <div style="margin-bottom:16px"><label for="p">密码</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required></div>
  <button type="submit">登录</button>
</form></div>"""
        return Response(HTTPStatus.OK, page("登录", None, body))

    def login_submit(request: Request, session: Session | None) -> Response:
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        admin = store.get_admin_by_username(username)
        if admin is None or not verify_password(password, admin["password_hash"]):
            body = """
<h2>登录</h2>
<div class="flash error">用户名或密码不正确。</div>
<div class="card"><form method="post" action="/login">
  <div style="margin-bottom:12px"><label for="u">用户名</label>
    <input id="u" name="username" type="text" autocomplete="username" required></div>
  <div style="margin-bottom:16px"><label for="p">密码</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required></div>
  <button type="submit">登录</button>
</form></div>"""
            return Response(HTTPStatus.UNAUTHORIZED, page("登录", None, body))
        new_session = app.new_session(admin)
        response = redirect("/roles")
        response.headers["Set-Cookie"] = (
            f"{SESSION_COOKIE}={new_session.token}; Path=/; HttpOnly; SameSite=Lax"
        )
        return response

    def logout(request: Request, session: Session | None) -> Response:
        if session:
            app.sessions.pop(session.token, None)
        response = redirect("/login")
        response.headers["Set-Cookie"] = (
            f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
        )
        return response

    def roles_page(request: Request, session: Session | None) -> Response:
        assert session is not None
        try:
            org_id = app.resolve_org(session, request.query.get("org", [None])[0])
        except PermissionDenied as exc:
            return Response(
                HTTPStatus.FORBIDDEN,
                page("无权访问", session, f"<div class=\"flash error\">{esc(exc)}</div>"),
            )
        org = store.get_org(org_id)
        rules = rule_summary(org["rule_set"])
        assignments = store.list_assignments(org_id)
        assignments_rows = "".join(
            f"""<tr>
<td><span class="mono">{esc(item['subject'])}</span></td>
<td><span class="badge neutral">{esc(item['role'])}</span></td>
<td class="muted">{esc(item['granted_by'])}</td>
<td class="muted">{esc(item['granted_at'])}</td>
<td class="right"><form method="post" action="/roles/revoke" class="inline">
  {csrf_input(session)}
  <input type="hidden" name="org" value="{esc(org_id)}">
  <input type="hidden" name="subject" value="{esc(item['subject'])}">
  <input type="hidden" name="role" value="{esc(item['role'])}">
  <button class="link" type="submit">收回</button></form></td>
</tr>"""
            for item in assignments
        ) or "<tr><td colspan=\"5\" class=\"muted\">该机构暂无角色分配。</td></tr>"

        roles_options = "".join(
            f"<option value=\"{esc(role)}\">{esc(role)}</option>"
            for role in rules["allowed_roles"]
        )
        org_switcher = ""
        orgs = app.allowed_orgs(session)
        if len(orgs) > 1:
            options = "".join(
                f"<option value=\"{esc(o['org_id'])}\""
                f"{' selected' if o['org_id'] == org_id else ''}>"
                f"{esc(o['name'])}</option>"
                for o in orgs
            )
            org_switcher = f"""<form method="get" action="/roles" class="inline">
<select name="org" onchange="this.form.submit()">{options}</select></form>"""

        body = f"""
<h2>角色管理 · {esc(org['name'])}</h2>
<p class="sub">机构标识 <span class="mono">{esc(org_id)}</span> · 规则集
<span class="mono">{esc(rules['name'])}</span>（{esc(rules['digest'][:16])}…）{org_switcher}</p>

<div class="card"><h3 style="margin-top:0">当前角色分配</h3>
<table><thead><tr><th>对象</th><th>角色</th><th>授予人</th><th>授予时间</th><th></th></tr></thead>
<tbody>{assignments_rows}</tbody></table></div>

<div class="card"><h3 style="margin-top:0">添加角色</h3>
<form method="post" action="/roles/grant">
  {csrf_input(session)}
  <input type="hidden" name="org" value="{esc(org_id)}">
  <div class="row">
    <div><label for="gs">对象（用户 ID）</label>
      <input id="gs" name="subject" type="text" required></div>
    <div><label for="gr">角色</label>
      <select id="gr" name="role">{roles_options}</select></div>
    <div><label for="greason">原因（可选）</label>
      <input id="greason" name="reason" type="text"></div>
    <div style="display:flex;align-items:flex-end"><button type="submit">授予</button></div>
  </div>
</form></div>

<div class="card"><h3 style="margin-top:0">替换角色</h3>
<form method="post" action="/roles/change">
  {csrf_input(session)}
  <input type="hidden" name="org" value="{esc(org_id)}">
  <div class="row">
    <div><label for="cs">对象（用户 ID）</label>
      <input id="cs" name="subject" type="text" required></div>
    <div><label for="co">原角色</label>
      <input id="co" name="old_role" type="text" required></div>
    <div><label for="cn">新角色</label>
      <select id="cn" name="new_role">{roles_options}</select></div>
    <div><label for="creason">原因（可选）</label>
      <input id="creason" name="reason" type="text"></div>
    <div style="display:flex;align-items:flex-end"><button type="submit">替换</button></div>
  </div>
</form></div>

<div class="card"><h3 style="margin-top:0">规则说明</h3>
<dl class="kv">
  <dt>规则集</dt><dd class="mono">{esc(rules['name'])}</dd>
  <dt>规则摘要（SHA-256）</dt><dd class="mono">{esc(rules['digest'])}</dd>
  <dt>允许角色</dt><dd>{esc('、'.join(rules['allowed_roles']))}</dd>
  <dt>受保护角色</dt><dd>{esc('、'.join(rules['protected_roles']) or '无')}</dd>
  <dt>每人角色上限</dt><dd>{esc(rules['max_roles_per_subject'])}</dd>
</dl></div>
"""
        return Response(
            HTTPStatus.OK,
            page("角色管理", session, body, active="roles", flash=flash_from_query(request.query)),
        )

    def _redirect_roles(session: Session, org_id: str, kind: str, message: str) -> Response:
        return redirect(
            f"/roles?org={quote(org_id)}&kind={quote(kind)}&msg={quote(message)}"
        )

    def grant(request: Request, session: Session | None) -> Response:
        assert session is not None
        org_id = request.form.get("org", "")
        try:
            app.service.grant_role(
                app.actor(session),
                org_id=org_id,
                subject=request.form.get("subject", "").strip(),
                role=request.form.get("role", "").strip(),
                reason=request.form.get("reason", "").strip() or None,
            )
        except (PermissionDenied, KeyError, AuditError) as exc:
            return _redirect_roles(session, org_id, "error", f"授予失败：{exc}")
        return _redirect_roles(session, org_id, "ok", "角色已授予，已写入审计记录")

    def revoke(request: Request, session: Session | None) -> Response:
        assert session is not None
        org_id = request.form.get("org", "")
        try:
            app.service.revoke_role(
                app.actor(session),
                org_id=org_id,
                subject=request.form.get("subject", "").strip(),
                role=request.form.get("role", "").strip(),
                reason=request.form.get("reason", "").strip() or None,
            )
        except (PermissionDenied, KeyError, AuditError) as exc:
            return _redirect_roles(session, org_id, "error", f"收回失败：{exc}")
        return _redirect_roles(session, org_id, "ok", "角色已收回，已写入审计记录")

    def change(request: Request, session: Session | None) -> Response:
        assert session is not None
        org_id = request.form.get("org", "")
        try:
            app.service.change_role(
                app.actor(session),
                org_id=org_id,
                subject=request.form.get("subject", "").strip(),
                old_role=request.form.get("old_role", "").strip(),
                new_role=request.form.get("new_role", "").strip(),
                reason=request.form.get("reason", "").strip() or None,
            )
        except (PermissionDenied, KeyError, AuditError) as exc:
            return _redirect_roles(session, org_id, "error", f"替换失败：{exc}")
        return _redirect_roles(session, org_id, "ok", "角色已替换，已写入审计记录")

    def audit_page(request: Request, session: Session | None) -> Response:
        assert session is not None
        try:
            org_id = app.resolve_org(session, request.query.get("org", [None])[0])
        except PermissionDenied as exc:
            return Response(
                HTTPStatus.FORBIDDEN,
                page("无权访问", session, f"<div class=\"flash error\">{esc(exc)}</div>"),
            )
        org = store.get_org(org_id)
        records = store.list_audit(org_id)
        baseline_error: str | None = None
        try:
            baseline = load_baseline(store.baseline_path, org_id)
        except (OSError, sqlite3.Error) as exc:
            baseline = []
            baseline_error = str(exc)
        baseline_ok = baseline_error is None
        baseline_by_id = {entry["audit_id"]: entry for entry in baseline}
        rows = []
        chain_ok = True
        prev = None
        for record in records:
            payload = payload_from_record(record)
            digest = payload_digest(payload)
            rhash = record_hash(record["prev_hash"], digest)
            entry = baseline_by_id.get(record["audit_id"])
            anchored = (
                entry is not None
                and entry["digest"] == digest
                and entry["record_hash"] == rhash
                and entry["prev_hash"] == record["prev_hash"]
            )
            linked = prev is None or record["prev_hash"] == prev
            if not (anchored and linked and digest == record["digest"]):
                chain_ok = False
            prev = rhash
            outcome = (
                "<span class=\"badge ok\">成功</span>"
                if record["outcome"] == "success"
                else "<span class=\"badge bad\">失败</span>"
            )
            verify_badge = (
                "<span class=\"badge ok\">已锚定</span>"
                if anchored
                else "<span class=\"badge bad\">异常</span>"
            )
            changes = json.dumps(record["changes"], ensure_ascii=False, sort_keys=True)
            detail = json.dumps(record["detail"], ensure_ascii=False, sort_keys=True)
            rows.append(
                f"""<tr>
<td class="mono">{record['seq']}</td>
<td class="muted">{esc(record['created_at'])}</td>
<td>{esc(record['actor'])}</td>
<td><span class="mono">{esc(record['target'])}</span></td>
<td>{esc(record['action'])} {outcome}</td>
<td>{esc(record['role'] or '—')}</td>
<td class="mono" style="max-width:280px">{esc(changes)}</td>
<td class="mono" style="max-width:220px">{esc(detail)}</td>
<td class="mono">{esc(record['rule_set'])}<br>{verify_badge}</td>
<td class="mono" style="max-width:180px">{esc(record['record_hash'][:20])}…</td>
</tr>"""
            )
        table_rows = "".join(rows) or (
            "<tr><td colspan=\"10\" class=\"muted\">该机构暂无审计记录。</td></tr>"
        )
        live_ids = {record["audit_id"] for record in records}
        orphan_baseline = [
            entry["seq"] for entry in baseline if entry["audit_id"] not in live_ids
        ]
        if orphan_baseline:
            chain_ok = False
        integrity = (
            "<span class=\"complete\">全部记录均与本地基准一致，顺序连续</span>"
            if chain_ok and records
            else (
                "<span class=\"complete\">暂无记录</span>"
                if not records
                else "<span class=\"missing\">存在无法核对或链接异常的记录</span>"
            )
        )
        if not baseline_ok:
            chain_ok = False
            integrity = (
                "<span class=\"missing\">本地审计基准不可读，无法核对记录完整性"
                f"（{esc(baseline_error)}）</span>"
            )
        if orphan_baseline:
            integrity += (
                f"<br><span class=\"missing\">本地基准中有 {len(orphan_baseline)} 条记录"
                f"未出现在审计表中（seq {esc(', '.join(str(s) for s in orphan_baseline))}）"
                "</span>"
            )
        body = f"""
<h2>审计记录 · {esc(org['name'])}</h2>
<p class="sub">仅供查看，记录不可编辑或删除。机构 <span class="mono">{esc(org_id)}</span>
· 共 {len(records)} 条 · {integrity}</p>

<div class="card">
<form method="get" action="/audit/export" style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
  <input type="hidden" name="org" value="{esc(org_id)}">
  <div><label for="fs">起始序号（可选）</label>
    <input id="fs" name="first_seq" type="text" inputmode="numeric" style="width:130px"></div>
  <div><label for="ls">结束序号（可选）</label>
    <input id="ls" name="last_seq" type="text" inputmode="numeric" style="width:130px"></div>
  <button type="submit">导出 JSON 副本</button>
  <span class="muted">导出包含可独立核对顺序与内容的完整性信息。</span>
</form></div>

<div class="card" style="overflow-x:auto">
<table><thead><tr>
<th>序号</th><th>时间</th><th>操作人</th><th>对象</th><th>动作 / 结果</th>
<th>角色</th><th>变更</th><th>详情</th><th>规则集</th><th>记录哈希</th>
</tr></thead><tbody>{table_rows}</tbody></table></div>

<p class="muted">本地审计基准：<span class="mono">{esc(store.baseline_path)}</span>
（与主库分开保存）。审计页只读，不能编辑或删除历史记录。</p>
"""
        return Response(
            HTTPStatus.OK,
            page("审计记录", session, body, active="audit", flash=flash_from_query(request.query)),
        )

    def audit_export(request: Request, session: Session | None) -> Response:
        assert session is not None
        try:
            org_id = app.resolve_org(session, request.query.get("org", [None])[0])
            first_seq = _optional_int(request.query.get("first_seq", [""])[0])
            last_seq = _optional_int(request.query.get("last_seq", [""])[0])
            bundle = build_bundle(
                store,
                org_id,
                first_seq=first_seq,
                last_seq=last_seq,
                exported_by=session.username,
            )
        except PermissionDenied as exc:
            return Response(
                HTTPStatus.FORBIDDEN,
                page("无权访问", session, f"<div class=\"flash error\">{esc(exc)}</div>"),
            )
        except (KeyError, ValueError) as exc:
            return Response(
                HTTPStatus.BAD_REQUEST,
                page("导出失败", session, f"<div class=\"flash error\">{esc(exc)}</div>"),
            )
        payload = json.dumps(bundle, ensure_ascii=False, indent=2).encode("utf-8")
        filename = f"audit-{org_id}-{bundle['selection']['first_seq']}-{bundle['selection']['last_seq']}.json"
        return Response(
            HTTPStatus.OK,
            payload,
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "Content-Disposition": f"attachment; filename=\"{filename}\"",
            },
        )

    def verify_page(request: Request, session: Session | None) -> Response:
        assert session is not None
        copies = app.list_copies(session)
        copy_rows = "".join(
            f"""<tr><td class="mono">{esc(path.name)}</td>
<td class="muted">{path.stat().st_size} 字节</td>
<td class="right"><form method="post" action="/verify" enctype="multipart/form-data" class="inline">
  {csrf_input(session)}
  <input type="hidden" name="source" value="local:{esc(path.name)}">
  <button class="secondary" type="submit">校验此副本</button></form></td></tr>"""
            for path in copies
        ) or "<tr><td colspan=\"3\" class=\"muted\">导出目录中没有副本。</td></tr>"

        body = f"""
<h2>校验审计副本</h2>
<p class="sub">校验入口以只读方式核对所选副本，不会写回真实审计记录。
判定依据是单独保存的本地审计基准 <span class="mono">{esc(store.baseline_path)}</span>，
副本自带的摘要仅作参考。</p>

<div class="card"><h3 style="margin-top:0">选择导出目录中的副本</h3>
<table><thead><tr><th>文件名</th><th>大小</th><th></th></tr></thead>
<tbody>{copy_rows}</tbody></table></div>

<div class="card"><h3 style="margin-top:0">上传副本文件</h3>
<form method="post" action="/verify" enctype="multipart/form-data">
  {csrf_input(session)}
  <div class="row">
    <div><label for="f">JSON 副本（≤ 2 MB）</label>
      <input id="f" name="copy" type="file" accept="application/json,.json" required></div>
    <div style="display:flex;align-items:flex-end"><button type="submit">上传并校验</button></div>
  </div>
</form></div>
"""
        return Response(
            HTTPStatus.OK,
            page("校验副本", session, body, active="verify", flash=flash_from_query(request.query)),
        )

    def verify_submit(request: Request, session: Session | None) -> Response:
        assert session is not None
        source = request.form.get("source", "")
        data: bytes | None = None
        label = ""
        if source.startswith("local:"):
            name = source[len("local:"):]
            visible = {path.name: path for path in app.list_copies(session)}
            path = visible.get(name)
            if path is None:
                return _verify_error(session, "所选副本不存在或不在当前管理员范围内")
            if path.stat().st_size > MAX_COPY_BYTES:
                return _verify_error(session, "副本文件过大")
            data = path.read_bytes()
            label = name
        else:
            data = request.files.get("copy")
            label = "上传的副本"
            if not data:
                return _verify_error(session, "请选择要校验的副本")
            if len(data) > MAX_COPY_BYTES:
                return _verify_error(session, "副本文件超过 2 MB")

        try:
            bundle = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            return _verify_error(session, f"副本不是有效的 JSON：{exc}")
        if not isinstance(bundle, dict):
            return _verify_error(session, "副本结构无效")

        expected_org = None if session.is_super else session.org_id
        try:
            report = verify_bundle(
                bundle,
                store.baseline_path,
                live_db_path=store.db_path,
                expected_org_id=expected_org,
            )
        except (AuditError, OSError, sqlite3.Error) as exc:
            return _verify_error(session, f"校验失败：{exc}")
        return Response(
            HTTPStatus.OK,
            page("校验结果", session, render_report(report, label), active="verify"),
        )

    def _verify_error(session: Session, message: str) -> Response:
        return Response(
            HTTPStatus.BAD_REQUEST,
            page(
                "校验失败",
                session,
                f"<div class=\"flash error\">{esc(message)}</div>"
                "<p><a class=\"btn secondary\" href=\"/verify\">返回</a></p>",
                active="verify",
            ),
        )

    def not_found(request: Request, session: Session | None) -> Response:
        return Response(HTTPStatus.NOT_FOUND, page("页面不存在", session, "<p>页面不存在。</p>"))

    router.add("GET", "/", login_form, auth=False)
    router.add("GET", "/login", login_form, auth=False)
    router.add("POST", "/login", login_submit, auth=False, csrf=False)
    router.add("POST", "/logout", logout)
    router.add("GET", "/roles", roles_page)
    router.add("POST", "/roles/grant", grant)
    router.add("POST", "/roles/revoke", revoke)
    router.add("POST", "/roles/change", change)
    router.add("GET", "/audit", audit_page)
    router.add("GET", "/audit/export", audit_export)
    router.add("GET", "/verify", verify_page)
    router.add("POST", "/verify", verify_submit)


def render_report(report: dict[str, Any], label: str) -> str:
    status = report["status"]    badge = {
        "verified": "<span class=\"badge ok\">顺序与内容一致</span>",
        "incomplete": "<span class=\"badge warn\">覆盖不完整</span>",
        "failed": "<span class=\"badge bad\">核对未通过</span>",
    }.get(status, "<span class=\"badge neutral\">未知</span>")

    missing = report.get("missing_ranges") or []
    missing_html = ""
    if missing:
        parts = "、".join(
            f"seq {start}" if start == end else f"seq {start}-{end}"
            for start, end in missing
        )
        missing_html = (
            f"<div class=\"flash error\">副本缺少 {esc(parts)} 的记录，"
            "无法作为完整副本。</div>"
        )
    covered_text = _format_ranges(report.get("covered_ranges") or [])
    missing_text = _format_ranges(missing)

    def check_row(name: str, ok: bool | None, detail: str) -> str:
        if ok is None:
            mark = "<span class=\"badge neutral\">参考</span>"
        elif ok:
            mark = "<span class=\"badge ok\">通过</span>"
        else:
            mark = "<span class=\"badge bad\">未通过</span>"
        return (
            f"<tr><td>{esc(name)}</td><td>{mark}</td>"
            f"<td class=\"muted\">{esc(detail)}</td></tr>"
        )

    checks = report["checks"]
    content = checks["record_content"]
    order = checks["record_order"]
    anchor = checks["baseline_anchor"]
    chain = checks["chain_link"]
    coverage = checks["coverage"]
    live = checks["live_records"]
    embedded = checks["embedded_integrity"]

    rows = [
        check_row(
            "记录内容",
            content["content_matches_declared"],
            f"重算 {content['records_checked']} 条内容的 SHA-256 摘要，"
            f"算法 {content['digest_algorithm']}；"
            + ("无凭据字段" if content["no_credentials"] else "发现疑似凭据"),
        ),
        check_row(
            "记录顺序",
            order["ascending"] and order["unique"],
            f"序号 {', '.join(str(s) for s in order['sequence']) or '无'}，"
            + ("严格递增且不重复" if order["ascending"] and order["unique"] else "顺序异常")
            + ("，连续无缺口" if order["contiguous"] else "，内部存在缺口"),
        ),
        check_row(
            "本地基准锚定",
            anchor["all_anchored"],
            f"{anchor['records_anchored']}/{anchor['records_checked']} 条与基准记录一致"
            f"（基准文件 {anchor['baseline_path']}）",
        ),
        check_row(
            "链式链接",
            chain["internal_links_ok"] and chain["anchors_to_baseline_predecessor"],
            "副本内部逐条链接，并与基准中前一条的哈希衔接"
            if chain["internal_links_ok"] and chain["anchors_to_baseline_predecessor"]
            else "存在断链或起始衔接异常",
        ),
        check_row(
            "覆盖完整性",
            coverage["complete_for_org"],
            f"副本覆盖 {covered_text}；本地基准共 "
            f"{len(coverage['baseline_sequence'])} 条"
            + (f"；缺少 {missing_text}" if missing else ""),
        ),
        check_row(
            "真实记录只读比对",
            live["all_match"] if live["checked"] else None,
            f"只读打开主库比对了 {live['checked']} 条，"
            f"{live['matched']} 条一致；未写回任何数据",
        ),
        check_row(
            "副本自带完整性信息",
            None,
            "仅作参考，不作为判定依据"
            + (
                "（清单与记录一致）"
                if embedded["manifest_consistent_with_records"]
                else "（清单与记录不一致）"
            ),
        ),
        check_row(
            "规则集",
            checks.get("rule_set", {}).get("matches_local_definition"),
            (
                f"{checks['rule_set']['name']} · "
                f"{checks['rule_set']['digest'][:32]}…"
                if checks.get("rule_set")
                else "副本未声明规则集"
            ),
        ),
    ]

    errors_html = "".join(f"<li>{esc(item)}</li>" for item in report["errors"])
    warnings_html = "".join(f"<li>{esc(item)}</li>" for item in report["warnings"])
    error_block = f"<div class=\"card\"><h3 style=\"margin-top:0\">错误</h3><ul>{errors_html}</ul></div>" if errors_html else ""
    warning_block = f"<div class=\"card\"><h3 style=\"margin-top:0\">提示</h3><ul>{warnings_html}</ul></div>" if warnings_html else ""

    return f"""
<h2>校验结果 · {esc(label)}</h2>
<p class="sub">{badge} 机构 <span class="mono">{esc(report.get('org_id'))}</span></p>
{missing_html}
<div class="card"><p style="margin:0">{esc(report['summary'])}</p></div>
{error_block}
{warning_block}
<div class="card"><h3 style="margin-top:0">核对明细</h3>
<table><thead><tr><th style="width:150px">检查项</th><th style="width:110px">结果</th><th>说明</th></tr></thead>
<tbody>{''.join(rows)}</tbody></table></div>
<p class="muted">本次校验以只读方式打开本地审计基准与主库，未修改任何审计记录。
<a href="/verify">返回校验页</a> · <a href="/audit">查看审计记录</a></p>
"""


def _format_ranges(ranges: list[list[int]]) -> str:
    """Format ``[[start, end], ...]`` pairs for display."""
    return "、".join(
        f"seq {start}" if start == end else f"seq {start}-{end}"
        for start, end in ranges
    ) or "无"


def _optional_int(value: str) -> int | None:
    value = (value or "").strip()
    if not value:
        return None
    number = int(value)
    if number < 1:
        raise ValueError("序号必须为正整数")
    return number


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------


class BoundHandler(BaseHTTPRequestHandler):
    app: App
    router: Router
    server_version = "gsb2"

    def do_GET(self) -> None:  # noqa: N802
        self._handle("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._handle("POST")

    def _handle(self, method: str) -> None:
        try:
            request = Request(self, method)
        except ValueError as exc:
            self._send(Response(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, str(exc)))
            return
        try:
            response = self.router.dispatch(request)
        except PermissionDenied as exc:
            response = Response(HTTPStatus.FORBIDDEN, f"403: {exc}")
        except KeyError as exc:
            response = Response(HTTPStatus.BAD_REQUEST, f"400: {exc}")
        except AuditError as exc:
            response = Response(HTTPStatus.CONFLICT, f"409: {exc}")
        except Exception:  # pragma: no cover - defensive
            import traceback

            traceback.print_exc()
            response = Response(HTTPStatus.INTERNAL_SERVER_ERROR, "500: 内部错误")
        self._send(response)

    def _send(self, response: Response) -> None:
        self.send_response(response.status)
        headers = {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"}
        headers.update(response.headers)
        for key, value in headers.items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(response.body)))
        self.end_headers()
        if response.body:
            self.wfile.write(response.body)

    def log_message(self, fmt: str, *args: Any) -> None:
        """Quiet request logging that never records query strings."""
        message = fmt % args
        if "?" in message:
            message = message.split("?", 1)[0] + "?<redacted>"
        print(f"[web] {self.address_string()} {message}")


def serve(app: App, host: str = "127.0.0.1", port: int = 8787) -> ThreadingHTTPServer:
    router = Router(app)
    make_handlers(app, router)

    class Handler(BoundHandler):
        pass

    Handler.app = app
    Handler.router = router
    server = ThreadingHTTPServer((host, port), Handler)
    return server
