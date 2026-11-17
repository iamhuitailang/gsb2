#!/usr/bin/env python3
"""机构成员管理（本地内部工具）

规则：
- 每个机构至少保留 1 名「有效管理员」：角色为管理员且账号未停用（停用账号不计入）。
- 降级 / 停用 / 移除 / 退出机构前，先在同一事务内检查操作后剩余的有效管理员数。
- 检查与写入放在同一个 BEGIN IMMEDIATE 事务里，并发请求被串行化，
  两名管理员同时退出时只有一人能成功。
- 所有操作（包括被拒绝的）都会写入审计日志，成功操作记录实际变化（before → after）。

运行：python3 app.py [--port 8000] [--db app.db]
首次启动会自动写入演示数据（见 seed()，密码均为 pass123）。
"""

import argparse
import hashlib
import hmac
import html
import re
import secrets
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote, parse_qs, urlparse

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled'))
);
CREATE TABLE IF NOT EXISTS orgs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships(
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('admin','member')),
  PRIMARY KEY(org_id, user_id)
);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('成功','已拒绝')),
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
"""

ACTION_NAMES = {
    'promote': '升为管理员',
    'demote': '降为成员',
    'disable': '停用账号',
    'enable': '启用账号',
    'remove': '移出机构',
    'leave': '退出机构',
}
ROLE_NAMES = {'admin': '管理员', 'member': '成员'}
STATUS_NAMES = {'active': '正常', 'disabled': '已停用'}


# ---------------------------------------------------------------- 存储层

class Store:
    def __init__(self, path):
        self.path = path

    def connect(self):
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        return conn


def init_db(store):
    conn = store.connect()
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 100_000).hex()
    return f"{salt}${digest}"


def verify_password(password, stored):
    salt, digest = stored.split('$', 1)
    candidate = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 100_000).hex()
    return hmac.compare_digest(candidate, digest)


def seed(store, password='pass123'):
    """写入演示数据：机构一（甲/乙管理员、丙成员）、机构二（丁管理员、戊成员）、机构三（赵/钱管理员、孙成员）。"""
    conn = store.connect()
    if conn.execute("SELECT COUNT(*) c FROM users").fetchone()['c']:
        conn.close()
        return
    users, orgs, memberships = [], [], []

    def user(username, name):
        users.append((username, name, hash_password(password)))
        return len(users)

    def org(name):
        orgs.append((name,))
        return len(orgs)

    jia, yi, bing = user('jia', '甲'), user('yi', '乙'), user('bing', '丙')
    ding, wu = user('ding', '丁'), user('wu', '戊')
    zhao, qian, sun = user('zhao', '赵'), user('qian', '钱'), user('sun', '孙')
    org1, org2, org3 = org('机构一'), org('机构二'), org('机构三')
    memberships += [
        (org1, jia, 'admin'), (org1, yi, 'admin'), (org1, bing, 'member'),
        (org2, ding, 'admin'), (org2, wu, 'member'),
        (org3, zhao, 'admin'), (org3, qian, 'admin'), (org3, sun, 'member'),
    ]
    conn.executemany("INSERT INTO users(username, display_name, password_hash) VALUES(?,?,?)", users)
    conn.executemany("INSERT INTO orgs(name) VALUES(?)", orgs)
    conn.executemany("INSERT INTO memberships(org_id, user_id, role) VALUES(?,?,?)", memberships)
    conn.commit()
    conn.close()


# ---------------------------------------------------------------- 核心业务

def active_admin_count(conn, org_id):
    """有效管理员 = 机构内角色为 admin 且账号未停用的成员数。"""
    row = conn.execute(
        """SELECT COUNT(*) c FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.org_id = ? AND m.role = 'admin' AND u.status = 'active'""",
        (org_id,)).fetchone()
    return row['c']


def _audit(conn, org_id, actor_name, action, target_name, result, detail):
    conn.execute(
        "INSERT INTO audit_log(org_id, actor, action, target, result, detail) VALUES(?,?,?,?,?,?)",
        (org_id, actor_name, ACTION_NAMES[action], target_name, result, detail))


def mutate(store, org_id, actor_id, action, target_id=None):
    """执行一次成员变更，返回 (ok, message)。

    整个「校验权限 → 检查剩余有效管理员数 → 写入 → 记审计」在同一个
    BEGIN IMMEDIATE 事务中完成：并发请求在写锁上排队，后到者读到的是
    前一个事务提交后的最新状态，因此不会出现两名管理员同时退出成功。
    """
    conn = store.connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            ok, msg = _mutate_tx(conn, org_id, actor_id, action, target_id)
        except Exception:
            conn.execute("ROLLBACK")
            raise
        conn.execute("COMMIT")  # 被拒绝的操作也已写入审计日志，一并提交
        return ok, msg
    finally:
        conn.close()


def _mutate_tx(conn, org_id, actor_id, action, target_id):
    org = conn.execute("SELECT * FROM orgs WHERE id = ?", (org_id,)).fetchone()
    if not org:
        return False, "机构不存在"
    actor = conn.execute("SELECT * FROM users WHERE id = ?", (actor_id,)).fetchone()
    actor_m = conn.execute(
        "SELECT * FROM memberships WHERE org_id = ? AND user_id = ?",
        (org_id, actor_id)).fetchone()

    def reject(reason, target_name='-'):
        _audit(conn, org_id, actor['display_name'], action, target_name, '已拒绝', reason)
        return False, reason

    if action == 'leave':
        if not actor_m:
            return reject("你不是该机构成员")
        target, target_m = actor, actor_m
    else:
        if not (actor_m and actor_m['role'] == 'admin' and actor['status'] == 'active'):
            return reject("只有该机构的有效管理员才能执行此操作")
        target = conn.execute("SELECT * FROM users WHERE id = ?", (target_id,)).fetchone()
        if not target:
            return reject("目标用户不存在")
        target_m = conn.execute(
            "SELECT * FROM memberships WHERE org_id = ? AND user_id = ?",
            (org_id, target_id)).fetchone()
        if not target_m:
            return reject("目标用户不是该机构成员", target['display_name'])
        if target['id'] == actor['id'] and action == 'remove':
            return reject("不能把自己移出机构；如需退出请使用「退出机构」", target['display_name'])

    # 动作本身是否合法
    if action == 'promote' and target_m['role'] == 'admin':
        return reject("目标已经是管理员", target['display_name'])
    if action == 'demote' and target_m['role'] != 'admin':
        return reject("目标不是管理员，无需降级", target['display_name'])
    if action == 'disable' and target['status'] == 'disabled':
        return reject("目标账号已处于停用状态", target['display_name'])
    if action == 'enable' and target['status'] == 'active':
        return reject("目标账号未停用，无需启用", target['display_name'])

    # 关键检查：该操作是否会减少有效管理员，减少后必须至少还剩 1 名
    reduces_admin = (target_m['role'] == 'admin' and target['status'] == 'active'
                     and action in ('demote', 'disable', 'remove', 'leave'))
    if reduces_admin and active_admin_count(conn, org_id) - 1 < 1:
        return reject(
            f"无法{ACTION_NAMES[action]}：{target['display_name']}是机构「{org['name']}」仅剩的 1 名有效管理员"
            f"（停用账号不计入），操作后机构将无人能登录管理。请先将其他成员升为管理员。",
            target['display_name'])

    # 执行写入并记录实际变化
    if action == 'promote':
        conn.execute("UPDATE memberships SET role='admin' WHERE org_id=? AND user_id=?",
                     (org_id, target['id']))
        detail = "角色：成员 → 管理员"
    elif action == 'demote':
        conn.execute("UPDATE memberships SET role='member' WHERE org_id=? AND user_id=?",
                     (org_id, target['id']))
        detail = "角色：管理员 → 成员"
    elif action == 'disable':
        conn.execute("UPDATE users SET status='disabled' WHERE id=?", (target['id'],))
        detail = "账号状态：正常 → 停用（停用期间不计入有效管理员）"
    elif action == 'enable':
        conn.execute("UPDATE users SET status='active' WHERE id=?", (target['id'],))
        detail = "账号状态：停用 → 正常"
    elif action == 'remove':
        conn.execute("DELETE FROM memberships WHERE org_id=? AND user_id=?",
                     (org_id, target['id']))
        detail = f"移出机构（原角色：{ROLE_NAMES[target_m['role']]}）"
    elif action == 'leave':
        conn.execute("DELETE FROM memberships WHERE org_id=? AND user_id=?",
                     (org_id, target['id']))
        detail = f"退出机构（原角色：{ROLE_NAMES[target_m['role']]}）"
    else:
        return reject(f"未知操作：{action}")

    _audit(conn, org_id, actor['display_name'], action, target['display_name'], '成功', detail)
    return True, f"已{ACTION_NAMES[action]}：{target['display_name']}（{detail}）"


# ---------------------------------------------------------------- 页面

PAGE = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>{title}</title>
<style>
 body {{ font-family: -apple-system, "PingFang SC", sans-serif; margin: 2rem auto; max-width: 960px; color: #222; }}
 table {{ border-collapse: collapse; width: 100%; margin: 1rem 0; }}
 th, td {{ border: 1px solid #ddd; padding: 6px 10px; text-align: left; font-size: 14px; }}
 th {{ background: #f5f5f5; }}
 button {{ margin: 1px 2px; padding: 3px 10px; cursor: pointer; }}
 .ok {{ background: #e7f6e7; border: 1px solid #8c8; padding: 8px 12px; border-radius: 4px; }}
 .err {{ background: #fdecec; border: 1px solid #c88; padding: 8px 12px; border-radius: 4px; }}
 .muted {{ color: #888; font-size: 13px; }}
 .tag {{ padding: 1px 8px; border-radius: 8px; font-size: 12px; }}
 .tag.admin {{ background: #e3effd; }} .tag.member {{ background: #f0f0f0; }}
 .tag.disabled {{ background: #fde3e3; }}
</style></head><body>{body}</body></html>"""


def esc(s):
    return html.escape(str(s), quote=True)


def flash_html(msg, ok):
    if not msg:
        return ''
    return f'<p class="{"ok" if ok else "err"}">{esc(msg)}</p>'


def login_page(msg=''):
    return PAGE.format(title='登录', body=f"""
<h2>机构成员管理 · 登录</h2>
{flash_html(msg, False)}
<form method="post" action="/login">
  <p>账号 <input name="username" required></p>
  <p>密码 <input name="password" type="password" required></p>
  <p><button type="submit">登录</button></p>
</form>
<p class="muted">演示账号：jia / yi / bing（机构一），ding / wu（机构二），zhao / qian / sun（机构三），密码均为 pass123</p>
""")


def home_page(user, rows):
    lines = []
    for r in rows:
        manage = (f' · <a href="/org/{r["org_id"]}/members">成员管理</a>'
                  if r['role'] == 'admin' and user['status'] == 'active' else '')
        lines.append(f'<li>{esc(r["org_name"])} — 我的角色：{ROLE_NAMES[r["role"]]}{manage}</li>')
    return PAGE.format(title='我的机构', body=f"""
<p>{esc(user['display_name'])}（{esc(user['username'])}） · <a href="/logout">退出登录</a></p>
<h2>我的机构</h2>
<ul>{''.join(lines) or '<li class="muted">尚未加入任何机构</li>'}</ul>
""")


def members_page(org, user, members, admins, logs, msg, ok):
    rows = []
    for m in members:
        is_self = m['id'] == user['id']
        btns = []
        if m['role'] == 'member':
            btns.append(('promote', '升为管理员'))
        else:
            btns.append(('demote', '降为成员'))
        btns.append(('disable', '停用') if m['status'] == 'active' else ('enable', '启用'))
        if not is_self:
            btns.append(('remove', '移除'))
        if is_self:
            btns.append(('leave', '退出机构'))
        forms = ''.join(
            f'<form method="post" action="/org/{org["id"]}/action" style="display:inline"'
            f' onsubmit="return confirm(\'确认{ACTION_NAMES[a]}？\')">'
            f'<input type="hidden" name="action" value="{a}">'
            f'<input type="hidden" name="target" value="{m["id"]}">'
            f'<button>{label}</button></form>'
            for a, label in btns)
        status = (f'<span class="tag disabled">{STATUS_NAMES[m["status"]]}</span>'
                  if m['status'] == 'disabled' else STATUS_NAMES[m['status']])
        rows.append(
            f'<tr><td>{esc(m["display_name"])}</td><td>{esc(m["username"])}</td>'
            f'<td><span class="tag {m["role"]}">{ROLE_NAMES[m["role"]]}</span></td>'
            f'<td>{status}</td><td>{forms}</td></tr>')
    log_rows = ''.join(
        f'<tr><td>{esc(l["created_at"])}</td><td>{esc(l["actor"])}</td><td>{esc(l["action"])}</td>'
        f'<td>{esc(l["target"])}</td><td>{esc(l["result"])}</td><td>{esc(l["detail"])}</td></tr>'
        for l in logs)
    return PAGE.format(title=f'{org["name"]} · 成员管理', body=f"""
<p><a href="/">← 我的机构</a> · {esc(user['display_name'])} · <a href="/logout">退出登录</a></p>
<h2>{esc(org['name'])} · 成员管理</h2>
<p class="muted">当前有效管理员：<b>{admins}</b> 名（机构至少保留 1 名；停用账号不计入）。
降级 / 停用 / 移除 / 退出若会使有效管理员归零，将被拒绝。</p>
{flash_html(msg, ok)}
<h3>成员列表</h3>
<table><tr><th>姓名</th><th>账号</th><th>角色</th><th>状态</th><th>操作</th></tr>{''.join(rows)}</table>
<h3>操作记录</h3>
<table><tr><th>时间</th><th>操作人</th><th>动作</th><th>目标</th><th>结果</th><th>说明</th></tr>
{log_rows or '<tr><td colspan="6" class="muted">暂无记录</td></tr>'}</table>
""")


def error_page(status, msg):
    return status, PAGE.format(title='提示', body=f'<h2>{status}</h2><p class="err">{esc(msg)}</p><p><a href="/">返回首页</a></p>')


# ---------------------------------------------------------------- HTTP 层

class App(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, addr, store):
        super().__init__(addr, Handler)
        self.store = store
        self.sessions = {}          # sid -> user_id（本地工具，内存会话即可）
        self.sessions_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    # ---- 工具 ----
    def _send(self, body, status=200, ctype='text/html; charset=utf-8', headers=None):
        data = body.encode()
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _redirect(self, location, headers=None):
        self.send_response(303)
        self.send_header('Location', location)
        self.send_header('Content-Length', '0')
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()

    def _form(self):
        length = int(self.headers.get('Content-Length') or 0)
        return {k: v[0] for k, v in parse_qs(self.rfile.read(length).decode()).items()}

    def _current_user(self):
        cookie = self.headers.get('Cookie') or ''
        m = re.search(r'(?:^|;\s*)sid=([0-9a-f]+)', cookie)
        if not m:
            return None
        with self.server.sessions_lock:
            uid = self.server.sessions.get(m.group(1))
        if not uid:
            return None
        conn = self.server.store.connect()
        row = conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
        conn.close()
        return row

    def _require_user(self):
        user = self._current_user()
        if not user:
            self._redirect('/login')
        return user

    def log_message(self, fmt, *args):
        pass  # 静默访问日志

    # ---- GET ----
    def do_GET(self):
        path = urlparse(self.path).path
        query = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}

        if path == '/login':
            self._send(login_page())
            return
        if path == '/logout':
            cookie = self.headers.get('Cookie') or ''
            m = re.search(r'(?:^|;\s*)sid=([0-9a-f]+)', cookie)
            if m:
                with self.server.sessions_lock:
                    self.server.sessions.pop(m.group(1), None)
            self._redirect('/login', {'Set-Cookie': 'sid=; Max-Age=0; Path=/; HttpOnly'})
            return

        user = self._require_user()
        if not user:
            return

        if path == '/':
            conn = self.server.store.connect()
            rows = conn.execute(
                """SELECT o.id org_id, o.name org_name, m.role FROM memberships m
                   JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY o.id""",
                (user['id'],)).fetchall()
            conn.close()
            self._send(home_page(user, rows))
            return

        m = re.fullmatch(r'/org/(\d+)/members', path)
        if m:
            org_id = int(m.group(1))
            conn = self.server.store.connect()
            org = conn.execute("SELECT * FROM orgs WHERE id = ?", (org_id,)).fetchone()
            me = conn.execute("SELECT * FROM memberships WHERE org_id=? AND user_id=?",
                              (org_id, user['id'])).fetchone()
            if not org:
                conn.close()
                self._send(error_page(404, '机构不存在')[1], 404)
                return
            if not (me and me['role'] == 'admin' and user['status'] == 'active'):
                conn.close()
                self._send(error_page(403, '你不是该机构的有效管理员，无法打开成员管理页。')[1], 403)
                return
            members = conn.execute(
                """SELECT u.id, u.username, u.display_name, u.status, m.role
                   FROM memberships m JOIN users u ON u.id = m.user_id
                   WHERE m.org_id = ? ORDER BY m.role = 'admin' DESC, u.id""", (org_id,)).fetchall()
            admins = active_admin_count(conn, org_id)
            logs = conn.execute(
                "SELECT * FROM audit_log WHERE org_id = ? ORDER BY id DESC LIMIT 50",
                (org_id,)).fetchall()
            conn.close()
            self._send(members_page(org, user, members, admins, logs,
                                    unquote(query.get('msg', '')),
                                    query.get('ok') == '1'))
            return

        self._send(error_page(404, '页面不存在')[1], 404)

    # ---- POST ----
    def do_POST(self):
        path = urlparse(self.path).path

        if path == '/login':
            form = self._form()
            conn = self.server.store.connect()
            user = conn.execute("SELECT * FROM users WHERE username = ?",
                                (form.get('username', ''),)).fetchone()
            conn.close()
            if not user or not verify_password(form.get('password', ''), user['password_hash']):
                self._send(login_page('账号或密码错误'), 401)
                return
            if user['status'] != 'active':
                self._send(login_page('账号已停用，无法登录'), 403)
                return
            sid = secrets.token_hex(16)
            with self.server.sessions_lock:
                self.server.sessions[sid] = user['id']
            self._redirect('/', {'Set-Cookie': f'sid={sid}; Path=/; HttpOnly'})
            return

        m = re.fullmatch(r'/org/(\d+)/action', path)
        if m:
            user = self._require_user()
            if not user:
                return
            org_id = int(m.group(1))
            form = self._form()
            action = form.get('action', '')
            target = form.get('target')
            ok, msg = mutate(self.server.store, org_id, user['id'], action,
                             int(target) if target and target.isdigit() else None)
            self._redirect(f'/org/{org_id}/members?ok={"1" if ok else "0"}&msg={quote(msg)}')
            return

        self._send(error_page(404, '页面不存在')[1], 404)


# ---------------------------------------------------------------- 入口

def main():
    parser = argparse.ArgumentParser(description='机构成员管理（本地内部工具）')
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--db', default='app.db')
    args = parser.parse_args()

    store = Store(args.db)
    init_db(store)
    seed(store)
    app = App(('127.0.0.1', args.port), store)
    print(f'成员管理页已启动: http://127.0.0.1:{args.port}  （演示账号密码均为 pass123）')
    try:
        app.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
