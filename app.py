#!/usr/bin/env python3
"""gsb2 —— 本地账号中心演示：TOTP 二次验证 + 一次性备用码。

只依赖 Python 标准库，数据落在 instance/app.db，默认监听 127.0.0.1:8765。
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import html
import http.cookies
import logging
import os
import secrets
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import otp

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INSTANCE_DIR = os.environ.get("GSB2_INSTANCE", os.path.join(BASE_DIR, "instance"))
DB_PATH = os.environ.get("GSB2_DB", os.path.join(INSTANCE_DIR, "app.db"))
KEY_PATH = os.environ.get("GSB2_KEY", os.path.join(INSTANCE_DIR, "backup.key"))

DEMO_USERNAME = os.environ.get("GSB2_USER", "demo")
DEMO_PASSWORD = os.environ.get("GSB2_PASSWORD", "demo-pass-2026")

SESSION_TTL = 3600
REVEAL_TTL = 300
BACKUP_CODE_COUNT = 10
COOKIE_NAME = "sid"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    email TEXT NOT NULL,
    totp_secret TEXT,
    totp_pending_secret TEXT,
    totp_pending_created_at INTEGER,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backup_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    batch_id TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    used_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS backup_codes_user ON backup_codes(user_id, used_at);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    stage TEXT NOT NULL,
    csrf TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
"""


# ---------- 密码 ----------


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt$16384$8$1${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt_hex, digest_hex = stored.split("$")
        if algo != "scrypt":
            return False
        expected = bytes.fromhex(digest_hex)
        computed = hashlib.scrypt(
            password.encode("utf-8"),
            salt=bytes.fromhex(salt_hex),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(expected),
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(computed, expected)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def rollback_quietly(conn: sqlite3.Connection) -> None:
    """BEGIN 本身失败时事务还不存在，ROLLBACK 会再抛错；这里统一吞掉。"""
    try:
        conn.execute("ROLLBACK")
    except sqlite3.OperationalError:
        pass


# ---------- 后端 ----------


class AccountCenter:
    """账号、二次验证、备用码与会话的全部后端逻辑。"""

    def __init__(self, db_path: str = DB_PATH, key_path: str = KEY_PATH, logger=None):
        self.db_path = db_path
        self.key_path = key_path
        self.logger = logger or logging.getLogger("gsb2")
        os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
        self._init_db()
        self.backup_key = self._load_key()
        self._reveals: dict[int, tuple[str, dict, float]] = {}
        self._reveal_lock = threading.Lock()
        self.ensure_demo_user()

    # ----- 基础设施 -----

    def _init_db(self) -> None:
        conn = self.connect()
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(SCHEMA)
        finally:
            conn.close()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=15, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=15000")
        return conn

    def _load_key(self) -> bytes:
        os.makedirs(os.path.dirname(os.path.abspath(self.key_path)), exist_ok=True)
        try:
            with open(self.key_path, "rb") as handle:
                key = handle.read()
        except FileNotFoundError:
            key = secrets.token_bytes(32)
            try:
                fd = os.open(self.key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                # 另一个进程先建好了，直接读它写下的密钥。
                with open(self.key_path, "rb") as handle:
                    key = handle.read()
            else:
                with os.fdopen(fd, "wb") as handle:
                    handle.write(key)
        if len(key) < 32:
            raise RuntimeError("backup.key 内容过短，请删除后重新生成")
        return key

    def ensure_demo_user(self, *, reset: bool = False) -> None:
        conn = self.connect()
        try:
            row = conn.execute(
                "SELECT id FROM users WHERE username=?", (DEMO_USERNAME,)
            ).fetchone()
            if reset and row is not None:
                conn.execute("DELETE FROM backup_codes WHERE user_id=?", (row["id"],))
                conn.execute("DELETE FROM sessions WHERE user_id=?", (row["id"],))
                conn.execute(
                    "UPDATE users SET password_hash=?, totp_secret=NULL,"
                    " totp_pending_secret=NULL, totp_pending_created_at=NULL,"
                    " totp_enabled=0 WHERE id=?",
                    (hash_password(DEMO_PASSWORD), row["id"]),
                )
                self.logger.info("demo.user.reset user=%s", DEMO_USERNAME)
                return
            if row is None:
                conn.execute(
                    "INSERT INTO users(username, password_hash, display_name, email, created_at)"
                    " VALUES (?,?,?,?,?)",
                    (
                        DEMO_USERNAME,
                        hash_password(DEMO_PASSWORD),
                        "演示用户",
                        "demo@example.test",
                        int(time.time()),
                    ),
                )
                self.logger.info("demo.user.created user=%s", DEMO_USERNAME)
        finally:
            conn.close()

    # ----- 查询 -----

    def find_user(self, username: str):
        conn = self.connect()
        try:
            return conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        finally:
            conn.close()

    def get_user(self, user_id: int):
        conn = self.connect()
        try:
            return conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        finally:
            conn.close()

    # ----- 会话：密码通过后只到 mfa 阶段 -----

    def create_session(self, user_id: int, stage: str, replaces: int | None = None) -> tuple[str, str]:
        token = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(24)
        now = int(time.time())
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            if replaces is not None:
                conn.execute("DELETE FROM sessions WHERE id=?", (replaces,))
            conn.execute(
                "INSERT INTO sessions(token_hash, user_id, stage, csrf, created_at, expires_at)"
                " VALUES (?,?,?,?,?,?)",
                (token_digest(token), user_id, stage, csrf, now, now + SESSION_TTL),
            )
            conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
            conn.execute("COMMIT")
        except Exception:
            rollback_quietly(conn)
            raise
        finally:
            conn.close()
        return token, csrf

    def load_session(self, token: str | None):
        if not token:
            return None
        conn = self.connect()
        try:
            row = conn.execute(
                "SELECT * FROM sessions WHERE token_hash=?", (token_digest(token),)
            ).fetchone()
            if row is not None and row["expires_at"] < int(time.time()):
                conn.execute("DELETE FROM sessions WHERE id=?", (row["id"],))
                return None
            return row
        finally:
            conn.close()

    def delete_session(self, session_id: int) -> None:
        conn = self.connect()
        try:
            conn.execute("DELETE FROM sessions WHERE id=?", (session_id,))
        finally:
            conn.close()

    # ----- 一次性展示（验证器配置 / 备用码） -----

    def stash_reveal(self, session_id: int, kind: str, payload: dict) -> None:
        with self._reveal_lock:
            self._reveals[session_id] = (kind, payload, time.time() + REVEAL_TTL)

    def take_reveal(self, session_id: int, kind: str) -> dict | None:
        """读取并销毁。验证器密钥与备用码原文都只在生成后的那一次响应里出现。"""
        with self._reveal_lock:
            entry = self._reveals.get(session_id)
            if entry is None or entry[0] != kind:
                return None
            del self._reveals[session_id]
            if entry[2] < time.time():
                return None
            return entry[1]

    def drop_reveal(self, session_id: int, kind: str) -> None:
        with self._reveal_lock:
            entry = self._reveals.get(session_id)
            if entry is not None and entry[0] == kind:
                del self._reveals[session_id]

    # ----- 待启用的验证器配置 -----

    def set_pending_totp(self, user_id: int) -> tuple[str, str] | None:
        """生成待启用的密钥并返回 (secret, provisioning_uri)。

        只有尚未启用（totp_enabled=0）的账号才能写待启用配置；
        此时二次验证仍然不生效。
        """
        secret = otp.generate_totp_secret()
        username = ""
        updated = 0
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            cursor = conn.execute(
                "UPDATE users SET totp_pending_secret=?, totp_pending_created_at=?"
                " WHERE id=? AND totp_enabled=0",
                (secret, int(time.time()), user_id),
            )
            updated = cursor.rowcount
            user = conn.execute("SELECT username FROM users WHERE id=?", (user_id,)).fetchone()
            if user is not None:
                username = user["username"]
            conn.execute("COMMIT")
        except Exception:
            rollback_quietly(conn)
            raise
        finally:
            conn.close()
        if updated != 1 or not username:
            return None
        uri = otp.provisioning_uri(secret, username, issuer="GSB2 本地账号中心")
        return secret, uri

    def confirm_pending_totp(
        self, user_id: int, code: str, keep_session_id: int | None = None
    ) -> bool:
        """用正确的一次性口令把待启用配置转正；错误时保持原状。

        启用时把这个账号其它已登录会话一并作废：启用前建立的会话
        没有经过第二步，不能因为启用动作反而被“升级”为安全会话。
        """
        user = self.get_user(user_id)
        secret = user["totp_pending_secret"] if user else None
        if not secret or not otp.verify_totp(secret, code):
            return False
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            cursor = conn.execute(
                "UPDATE users SET totp_secret=?, totp_pending_secret=NULL,"
                " totp_pending_created_at=NULL, totp_enabled=1 WHERE id=? AND totp_pending_secret=?",
                (secret, user_id, secret),
            )
            updated = cursor.rowcount
            if updated == 1:
                if keep_session_id is None:
                    conn.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
                else:
                    conn.execute(
                        "DELETE FROM sessions WHERE user_id=? AND id<>?",
                        (user_id, keep_session_id),
                    )
            conn.execute("COMMIT")
        except Exception:
            rollback_quietly(conn)
            raise
        finally:
            conn.close()
        return updated == 1

    def cancel_pending_totp(self, user_id: int) -> None:
        conn = self.connect()
        try:
            conn.execute(
                "UPDATE users SET totp_pending_secret=NULL, totp_pending_created_at=NULL"
                " WHERE id=?",
                (user_id,),
            )
        finally:
            conn.close()

    # ----- 备用码 -----

    def generate_backup_batch(self, user_id: int, count: int = BACKUP_CODE_COUNT) -> list[str]:
        """整批替换：同一事务里先删旧批次再写新批次，旧码立即失效。"""
        codes = [otp.generate_backup_code() for _ in range(count)]
        batch_id = secrets.token_hex(8)
        now = int(time.time())
        rows = [
            (user_id, batch_id, otp.hash_backup_code(code, self.backup_key), now)
            for code in codes
        ]
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM backup_codes WHERE user_id=?", (user_id,))
            conn.executemany(
                "INSERT INTO backup_codes(user_id, batch_id, code_hash, created_at)"
                " VALUES (?,?,?,?)",
                rows,
            )
            conn.execute("COMMIT")
        except Exception:
            rollback_quietly(conn)
            raise
        finally:
            conn.close()
        return codes

    def consume_backup_code(self, user_id: int, code: str) -> bool:
        """原子地消费一个备用码。

        BEGIN IMMEDIATE 先拿写锁，查与改在同一个事务内完成；
        两个请求同时提交同一个码时，后到的那个看不到未使用的行。
        """
        normalized = otp.normalize_backup_code(code)
        if len(normalized) != otp.BACKUP_CODE_LENGTH:
            return False
        digest = otp.hash_backup_code(normalized, self.backup_key)
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT id FROM backup_codes WHERE user_id=? AND used_at IS NULL"
                " AND code_hash=?",
                (user_id, digest),
            ).fetchone()
            used = False
            if row is not None:
                cursor = conn.execute(
                    "UPDATE backup_codes SET used_at=? WHERE id=? AND used_at IS NULL",
                    (int(time.time()), row["id"]),
                )
                used = cursor.rowcount == 1
            conn.execute("COMMIT")
            return used
        except Exception:
            rollback_quietly(conn)
            raise
        finally:
            conn.close()

    def remaining_backup_codes(self, user_id: int) -> int:
        conn = self.connect()
        try:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM backup_codes WHERE user_id=? AND used_at IS NULL",
                (user_id,),
            ).fetchone()
            return int(row["n"])
        finally:
            conn.close()


# ---------- 页面 ----------

PAGE_CSS = """
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.6 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
       color: #1c2230; background: #f4f6fa; }
header { display: flex; gap: 16px; align-items: center; padding: 14px 22px;
         background: #fff; border-bottom: 1px solid #e3e7ef; }
header strong { font-size: 16px; }
header nav { margin-left: auto; display: flex; gap: 12px; align-items: center; }
header nav a { color: #2d5bd7; text-decoration: none; }
main { max-width: 680px; margin: 34px auto; padding: 0 18px; }
.card { background: #fff; border: 1px solid #e3e7ef; border-radius: 10px; padding: 22px 24px; }
h1 { font-size: 21px; margin: 0 0 12px; }
h2 { font-size: 17px; margin: 22px 0 8px; }
p { margin: 8px 0; }
label { display: block; margin: 12px 0; }
input { width: 100%; padding: 9px 11px; border: 1px solid #c8d0dd; border-radius: 7px; font: inherit; }
input[name=code] { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .5px; }
button { margin-top: 6px; padding: 9px 16px; border: 0; border-radius: 7px;
         background: #2d5bd7; color: #fff; font: inherit; cursor: pointer; }
button.secondary { background: #5c667a; }
button.danger { background: #b03a48; }
a.button { display: inline-block; margin-top: 6px; padding: 9px 16px; border-radius: 7px;
           background: #2d5bd7; color: #fff; text-decoration: none; }
.form-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.muted { color: #667085; }
.error { color: #b42318; background: #fef3f2; border: 1px solid #fecdca;
         padding: 9px 12px; border-radius: 7px; margin: 12px 0; }
.ok { color: #067647; background: #ecfdf3; border: 1px solid #abefc6;
      padding: 9px 12px; border-radius: 7px; margin: 12px 0; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.reveal { background: #0f172a; color: #e2e8f0; border-radius: 8px; padding: 14px 16px;
          word-break: break-all; font-family: ui-monospace, Menlo, monospace; font-size: 13px; }
.codes { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
         gap: 10px; padding: 0; list-style: none; margin: 14px 0; }
.codes li { background: #f8fafc; border: 1px dashed #b8c2d3; border-radius: 6px;
            padding: 10px 12px; font-family: ui-monospace, Menlo, monospace; letter-spacing: .6px; }
table { width: 100%; border-collapse: collapse; margin: 10px 0; }
th, td { text-align: left; padding: 7px 0; border-bottom: 1px solid #eef1f6; vertical-align: top; }
th { width: 34%; color: #667085; font-weight: 500; }
.badge { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 12px;
         background: #e8eefb; color: #274690; }
.badge.on { background: #dcfae6; color: #067647; }
form.inline { display: inline; }
"""


def esc(value) -> str:
    return html.escape("" if value is None else str(value))


def nav_for(session) -> str:
    csrf = esc(session["csrf"])
    return (
        '<nav><a href="/">首页</a><a href="/profile">个人资料</a>'
        '<a href="/settings">设置</a>'
        '<form class="inline" method="post" action="/logout">'
        f'<input type="hidden" name="csrf" value="{csrf}">'
        '<button class="secondary" type="submit">退出</button></form></nav>'
    )


def page(title: str, body: str, session=None) -> str:
    nav = nav_for(session) if session is not None else ""
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)} · GSB2</title><style>{PAGE_CSS}</style></head>
<body><header><strong>GSB2 本地账号中心</strong>{nav}</header>
<main><div class="card">{body}</div></main></body></html>"""


def error_banner(message: str) -> str:
    return f'<div class="error">{esc(message)}</div>'


def ok_banner(message: str) -> str:
    return f'<div class="ok">{esc(message)}</div>'


def render_login(error: str | None = None) -> str:
    banner = error_banner(error) if error else ""
    body = f"""<h1>登录</h1>
{banner}
<form method="post" action="/login">
  <label>用户名<input name="username" autocomplete="username" autofocus required></label>
  <label>密码<input type="password" name="password" autocomplete="current-password" required></label>
  <button type="submit">登录</button>
</form>
<p class="muted">演示账号用户名固定为 demo，密码见 README（或环境变量 GSB2_PASSWORD）。</p>"""
    return page("登录", body)


def render_verify(session, error: str | None = None) -> str:
    csrf = esc(session["csrf"])
    banner = error_banner(error) if error else ""
    body = f"""<h1>第二步验证</h1>
{banner}
<p>密码已通过，但会话仍处于待验证状态；完成第二步之前，个人资料不会返回。</p>
<form method="post" action="/verify">
  <input type="hidden" name="csrf" value="{csrf}">
  <label>验证器口令或备用码
    <input name="code" autocomplete="one-time-code" autofocus required></label>
  <button type="submit">验证</button>
</form>
<p class="muted">验证器口令为 6 位数字；备用码形如 ABCDE-FGHIJ，每个只能使用一次。</p>"""
    return page("第二步验证", body, session=session)


def status_badge(user) -> str:
    return (
        '<span class="badge on">已启用</span>'
        if user["totp_enabled"]
        else '<span class="badge">未启用</span>'
    )


def render_home(user, session, remaining: int) -> str:
    name = esc(user["display_name"])
    username = esc(user["username"])
    email = esc(user["email"])
    badge = status_badge(user)
    banner = ok_banner("已完成密码 + 第二步验证，可以访问个人资料。")
    body = f"""<h1>你好，{name}</h1>
{banner}
<table>
  <tr><th>用户名</th><td class="mono">{username}</td></tr>
  <tr><th>姓名</th><td>{name}</td></tr>
  <tr><th>邮箱</th><td>{email}</td></tr>
  <tr><th>二次验证</th><td>{badge}</td></tr>
  <tr><th>剩余备用码</th><td>{remaining} 个</td></tr>
</table>
<p><a href="/profile">查看个人资料页</a> · <a href="/settings">安全设置</a></p>"""
    return page("首页", body, session=session)


def render_profile(user, session) -> str:
    username = esc(user["username"])
    name = esc(user["display_name"])
    email = esc(user["email"])
    badge = status_badge(user)
    body = f"""<h1>个人资料</h1>
<p class="muted">此页面只接受已完成第二步验证的会话。</p>
<table>
  <tr><th>用户名</th><td class="mono">{username}</td></tr>
  <tr><th>姓名</th><td>{name}</td></tr>
  <tr><th>邮箱</th><td>{email}</td></tr>
  <tr><th>二次验证</th><td>{badge}</td></tr>
</table>
<p><a href="/">返回首页</a></p>"""
    return page("个人资料", body, session=session)


def render_settings(user, session, remaining: int) -> str:
    csrf = esc(session["csrf"])
    badge = status_badge(user)
    if user["totp_enabled"]:
        state = f"""<p>二次验证：{badge}</p>
<p>剩余未使用的备用码：<strong>{remaining}</strong> 个。</p>
<h2>备用码</h2>
<p class="muted">生成后旧的一组立即失效；新码只在生成后的页面展示一次，请立刻保存。</p>
<div class="form-row">
  <a class="button" href="/settings/backup-codes">查看 / 重新生成备用码</a>
</div>"""
    elif user["totp_pending_secret"]:
        state = f"""<p>二次验证：<span class="badge">待启用（尚未生效）</span></p>
<p class="muted">配置已生成，但未启用。输入验证器当前口令确认后才会真正生效。</p>
<div class="form-row">
  <a class="button" href="/settings/totp/confirm">继续确认</a>
  <form method="post" action="/settings/totp/cancel">
    <input type="hidden" name="csrf" value="{csrf}">
    <button class="danger" type="submit">放弃待启用的配置</button>
  </form>
</div>"""
    else:
        state = f"""<p>二次验证：{badge}</p>
<p class="muted">先生成验证器配置，再用它当前的一次性口令确认，才会启用。</p>
<form method="post" action="/settings/totp/setup">
  <input type="hidden" name="csrf" value="{csrf}">
  <button type="submit">生成验证器配置</button>
</form>"""
    username = esc(user["username"])
    email = esc(user["email"])
    body = f"""<h1>安全设置</h1>
{state}
<h2>当前账号</h2>
<table>
  <tr><th>用户名</th><td class="mono">{username}</td></tr>
  <tr><th>邮箱</th><td>{email}</td></tr>
</table>
<p class="muted">备用码只保存 HMAC 摘要，服务端无法再次展示原文。</p>"""
    return page("安全设置", body, session=session)


def render_totp_setup(user, session, reveal: dict | None, error: str | None = None) -> str:
    csrf = esc(session["csrf"])
    banner = error_banner(error) if error else ""
    if reveal is not None:
        uri = esc(reveal["uri"])
        secret_value = esc(reveal["secret"])
        secret_block = (
            "<p>把下面的配置加入验证器；本地演示也可以直接运行 "
            "<code>python3 manage.py code</code> 取当前口令。</p>"
            f'<div class="reveal">{uri}</div>'
            "<p>手动输入用的密钥（仅本次展示）：</p>"
            f'<div class="reveal">{secret_value}</div>'
            '<p class="muted">只在这一次响应里展示；刷新后不再回显，需要时请重新生成。'
            "普通页面与日志都不会出现它。</p>"
        )
    else:
        secret_block = (
            '<p class="muted">配置原文只展示过一次，已不再回显。'
            "如果没保存，请放弃并重新生成。</p>"
        )
    body = f"""<h1>启用二次验证</h1>
{banner}
{secret_block}
<h2>输入验证器当前口令以确认</h2>
<form method="post" action="/settings/totp/confirm">
  <input type="hidden" name="csrf" value="{csrf}">
  <label>6 位一次性口令<input name="code" autocomplete="one-time-code" required></label>
  <button type="submit">确认并启用</button>
</form>
<form method="post" action="/settings/totp/cancel">
  <input type="hidden" name="csrf" value="{csrf}">
  <button class="secondary" type="submit">放弃</button>
</form>"""
    return page("启用二次验证", body, session=session)


def render_backup_codes(user, session, reveal: dict | None, remaining: int) -> str:
    csrf = esc(session["csrf"])
    if reveal is not None:
        items = "".join(f"<li>{esc(code)}</li>" for code in reveal["codes"])
        banner = ok_banner("新的备用码已生成，旧的一组立即全部失效。")
        content = (
            f"{banner}"
            "<p>每个备用码只能使用一次。请现在保存，离开本页后无法再次查看。</p>"
            f'<ul class="codes">{items}</ul>'
        )
    else:
        content = (
            '<p class="muted">备用码只在生成时展示一次，已展示过或已过期，无法再次查看。</p>'
        )
    body = f"""<h1>备用码</h1>
{content}
<p class="muted">当前剩余可用备用码：{remaining} 个。</p>
<h2>重新生成备用码</h2>
<p class="muted">重新生成会立即作废旧的一组（包括还没用过的）。</p>
<form method="post" action="/settings/backup-codes">
  <input type="hidden" name="csrf" value="{csrf}">
  <button type="submit">重新生成备用码</button>
</form>
<p><a href="/settings">返回安全设置</a></p>"""
    return page("备用码", body, session=session)


# ---------- HTTP ----------


class Handler(BaseHTTPRequestHandler):
    server_version = "GSB2Demo/1.0"
    protocol_version = "HTTP/1.1"

    @property
    def app(self) -> AccountCenter:
        return self.server.app  # type: ignore[attr-defined]

    # 访问日志只记录方法、路径和状态码：不含查询串、Cookie、请求体。
    def log_request(self, code="-", size="-") -> None:
        path = urlsplit(self.path).path
        self.app.logger.info("%s %s %s -> %s", self.client_address[0], self.command, path, code)

    def log_message(self, fmt: str, *args) -> None:
        # 兜底：仍不写请求体/头内容。
        self.app.logger.info("%s %s", self.client_address[0], fmt % args)

    def do_GET(self) -> None:
        self._body = b""
        self._dispatch("GET")

    def do_POST(self) -> None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0 or length > 65536:
            self.close_connection = True
            self.send_page(413, page("错误", "<h1>请求体过大</h1>"))
            return
        self._body = self.rfile.read(length) if length else b""
        self._dispatch("POST")

    def _dispatch(self, method: str) -> None:
        path = urlsplit(self.path).path
        handler = ROUTES.get((method, path))
        try:
            if handler is None:
                self.send_page(404, page("404", "<h1>页面不存在</h1>"))
                return
            handler(self)
        except Exception:
            self.app.logger.exception("request.failed path=%s", path)
            self.send_page(500, page("错误", "<h1>服务器内部错误</h1>"))

    # ----- 响应 -----

    def send_page(self, status: int, body: str, *, headers=None) -> None:
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        for name, value in headers or []:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def redirect(self, location: str, *, cookie: str | None = None) -> None:
        headers = [("Location", location)]
        if cookie:
            headers.append(("Set-Cookie", cookie))
        self.send_page(303, page("跳转", f'<p>跳转到 <a href="{esc(location)}">这里</a>。</p>'), headers=headers)

    def session_cookie(self, token: str) -> str:
        return f"{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL}"

    def cleared_cookie(self) -> str:
        return f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"

    # ----- 请求上下文 -----

    def session_token(self) -> str | None:
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        jar = http.cookies.SimpleCookie()
        try:
            jar.load(raw)
        except http.cookies.CookieError:
            return None
        morsel = jar.get(COOKIE_NAME)
        return morsel.value if morsel else None

    def current_session(self):
        return self.app.load_session(self.session_token())

    def current_user(self, session):
        return self.app.get_user(session["user_id"]) if session else None

    def form(self) -> dict[str, str]:
        raw = self._body or b""
        if not raw:
            return {}
        try:
            parsed = parse_qs(raw.decode("utf-8"), keep_blank_values=True)
        except UnicodeDecodeError:
            return {}
        return {key: values[0] for key, values in parsed.items()}

    @staticmethod
    def csrf_ok(session, form: dict[str, str]) -> bool:
        supplied = form.get("csrf", "")
        if not supplied or not supplied.isascii():
            return False
        return hmac.compare_digest(supplied, session["csrf"])

    def require_authenticated(self):
        """只放行已完成第二步验证的会话；否则跳到对应页面并返回 (None, None)。"""
        session = self.current_session()
        if session is None:
            self.redirect("/login")
            return None, None
        if session["stage"] != "auth":
            self.redirect("/verify")
            return None, None
        user = self.current_user(session)
        if user is None:
            self.redirect("/login")
            return None, None
        return session, user


# ----- GET 路由 -----


def get_root(handler: Handler) -> None:
    session = handler.current_session()
    if session is None:
        handler.redirect("/login")
        return
    if session["stage"] != "auth":
        handler.redirect("/verify")
        return
    user = handler.current_user(session)
    if user is None:
        handler.redirect("/login")
        return
    remaining = handler.app.remaining_backup_codes(user["id"])
    handler.send_page(200, render_home(user, session, remaining))


def get_login(handler: Handler) -> None:
    session = handler.current_session()
    if session is not None:
        handler.redirect("/" if session["stage"] == "auth" else "/verify")
        return
    handler.send_page(200, render_login())


def get_verify(handler: Handler) -> None:
    session = handler.current_session()
    if session is None:
        handler.redirect("/login")
        return
    if session["stage"] == "auth":
        handler.redirect("/")
        return
    if handler.current_user(session) is None:
        handler.redirect("/login")
        return
    handler.send_page(200, render_verify(session))


def get_profile(handler: Handler) -> None:
    session = handler.current_session()
    if session is None:
        handler.redirect("/login")
        return
    user = handler.current_user(session)
    if user is None:
        handler.redirect("/login")
        return
    if session["stage"] != "auth":
        # 第二步未通过：403，且响应里没有任何资料字段。
        handler.send_page(403, render_verify(session, "请先完成第二步验证。"))
        return
    handler.send_page(200, render_profile(user, session))


def get_settings(handler: Handler) -> None:
    session, user = handler.require_authenticated()
    if session is None:
        return
    remaining = handler.app.remaining_backup_codes(user["id"])
    handler.send_page(200, render_settings(user, session, remaining))


def get_totp_confirm(handler: Handler) -> None:
    session, user = handler.require_authenticated()
    if session is None:
        return
    if not user["totp_pending_secret"]:
        handler.redirect("/settings")
        return
    # 生成后的第一次访问展示配置；刷新后不再回显，用户可重新生成。
    reveal = handler.app.take_reveal(session["id"], "totp_setup")
    handler.send_page(200, render_totp_setup(user, session, reveal))


def get_backup_codes(handler: Handler) -> None:
    session, user = handler.require_authenticated()
    if session is None:
        return
    remaining = handler.app.remaining_backup_codes(user["id"])
    reveal = handler.app.take_reveal(session["id"], "backup_codes")
    handler.send_page(200, render_backup_codes(user, session, reveal, remaining))


def get_healthz(handler: Handler) -> None:
    handler.send_page(200, "<!doctype html><title>ok</title>ok")


# ----- POST 路由 -----


def post_login(handler: Handler) -> None:
    form = handler.form()
    username = form.get("username", "").strip()
    password = form.get("password", "")
    current = handler.current_session()
    if current is not None and current["stage"] == "auth":
        handler.redirect("/")
        return
    user = handler.app.find_user(username) if username else None
    if user is None or not verify_password(password, user["password_hash"]):
        handler.app.logger.info("login.password.rejected user=%s", username[:32] or "-")
        handler.send_page(401, render_login("用户名或密码不正确。"))
        return
    stage = "mfa" if user["totp_enabled"] else "auth"
    token, _ = handler.app.create_session(
        user["id"], stage, replaces=current["id"] if current else None
    )
    handler.app.logger.info(
        "login.password.ok user=%s stage=%s", user["username"], stage
    )
    handler.redirect("/verify" if stage == "mfa" else "/", cookie=handler.session_cookie(token))


def post_verify(handler: Handler) -> None:
    session = handler.current_session()
    if session is None:
        handler.redirect("/login")
        return
    if session["stage"] == "auth":
        handler.redirect("/")
        return
    form = handler.form()
    if not handler.csrf_ok(session, form):
        handler.send_page(400, render_verify(session, "表单已过期，请重试。"))
        return
    user = handler.current_user(session)
    if user is None:
        handler.redirect("/login")
        return
    code = form.get("code", "").strip()
    method = None
    if otp.verify_totp(user["totp_secret"] or "", code):
        method = "totp"
    elif handler.app.consume_backup_code(user["id"], code):
        method = "backup_code"
    if method is None:
        handler.app.logger.info("login.mfa.rejected user=%s", user["username"])
        handler.send_page(401, render_verify(session, "验证码或备用码无效。"))
        return
    # 通过第二步：换一个全新的已认证会话，旧的待验证会话作废。
    token, _ = handler.app.create_session(user["id"], "auth", replaces=session["id"])
    handler.app.logger.info("login.mfa.ok user=%s method=%s", user["username"], method)
    handler.redirect("/", cookie=handler.session_cookie(token))


def post_logout(handler: Handler) -> None:
    session = handler.current_session()
    if session is not None and handler.csrf_ok(session, handler.form()):
        handler.app.delete_session(session["id"])
    handler.redirect("/login", cookie=handler.cleared_cookie())


def post_totp_setup(handler: Handler) -> None:
    session, user = handler.require_authenticated()
    if session is None:
        return
    if not handler.csrf_ok(session, handler.form()):
        handler.send_page(400, page("错误", "<h1>表单已过期</h1>", session=session))
        return
    pending = None if user["totp_enabled"] else handler.app.set_pending_totp(user["id"])
    if pending is None:
        handler.send_page(
            409,
            page(
                "安全设置",
                "<h1>安全设置</h1>" + error_banner("二次验证已经启用。"),
                session=session,
            ),
        )
        return
    secret, uri = pending
    handler.app.stash_reveal(session["id"], "totp_setup", {"secret": secret, "uri": uri})
    handler.app.logger.info("settings.totp.setup_created user=%s", user["username"])
    handler.redirect("/settings/totp/confirm")


def post_totp_confirm(handler: Handler) -> None:
    session, user = handler.require_authenticated()
    if session is None:
        return
    form = handler.form()
    if not handler.csrf_ok(session, form):
        handler.send_page(400, page("错误", "<h1>表单已过期</h1>", session=session))
        return
    if not user["totp_pending_secret"]:
        handler.redirect("/settings")
        return
    if not handler.app.confirm_pending_totp(
        user["id"], form.get("code", "").strip(), keep_session_id=session["id"]
    ):
        handler.app.logger.info("settings.totp.confirm_rejected user=%s", user["username"])
        handler.send_page(
            401, render_totp_setup(user, session, None, "一次性口令不正确，未启用。")
        )
        return
    handler.app.drop_reveal(session["id"], "totp_setup")
    codes = handler.app.generate_backup_batch(user["id"])
    handler.app.stash_reveal(session["id"], "backup_codes", {"codes": codes})
    handler.app.logger.info("settings.totp.enabled user=%s", user["username"])
    handler.redirect("/settings/backup-codes")


def post_totp_cancel(handler: Handler) -> None:
    session, user = handler.require_authenticated()
    if session is None:
        return
    if not handler.csrf_ok(session, handler.form()):
        handler.send_page(400, page("错误", "<h1>表单已过期</h1>", session=session))
        return
    handler.app.cancel_pending_totp(user["id"])
    handler.app.drop_reveal(session["id"], "totp_setup")
    handler.app.logger.info("settings.totp.setup_cancelled user=%s", user["username"])
    handler.redirect("/settings")


def post_backup_codes(handler: Handler) -> None:
    session, user = handler.require_authenticated()
    if session is None:
        return
    if not handler.csrf_ok(session, handler.form()):
        handler.send_page(400, page("错误", "<h1>表单已过期</h1>", session=session))
        return
    if not user["totp_enabled"]:
        handler.send_page(409, page("错误", "<h1>请先启用二次验证</h1>", session=session))
        return
    codes = handler.app.generate_backup_batch(user["id"])
    handler.app.stash_reveal(session["id"], "backup_codes", {"codes": codes})
    handler.app.logger.info("settings.backup_codes.rotated user=%s", user["username"])
    handler.redirect("/settings/backup-codes")


# ----- 路由表 -----

ROUTES = {
    ("GET", "/"): get_root,
    ("GET", "/login"): get_login,
    ("GET", "/verify"): get_verify,
    ("GET", "/profile"): get_profile,
    ("GET", "/settings"): get_settings,
    ("GET", "/settings/totp/confirm"): get_totp_confirm,
    ("GET", "/settings/backup-codes"): get_backup_codes,
    ("GET", "/healthz"): get_healthz,
    ("POST", "/login"): post_login,
    ("POST", "/verify"): post_verify,
    ("POST", "/logout"): post_logout,
    ("POST", "/settings/totp/setup"): post_totp_setup,
    ("POST", "/settings/totp/confirm"): post_totp_confirm,
    ("POST", "/settings/totp/cancel"): post_totp_cancel,
    ("POST", "/settings/backup-codes"): post_backup_codes,
}


def create_server(host: str = "127.0.0.1", port: int = 8765, center: AccountCenter | None = None):
    center = center or AccountCenter()
    server = ThreadingHTTPServer((host, port), Handler)
    server.app = center
    server.daemon_threads = True
    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="本地账号中心演示")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--db", default=DB_PATH)
    parser.add_argument("--reset", action="store_true", help="重置演示账号（密码、二次验证、备用码）")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    center = AccountCenter(db_path=args.db)
    if args.reset:
        center.ensure_demo_user(reset=True)
    center.logger.info(
        "server.start host=%s port=%s db=%s user=%s",
        args.host, args.port, args.db, DEMO_USERNAME,
    )
    server = create_server(args.host, args.port, center)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        center.logger.info("server.stop")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
