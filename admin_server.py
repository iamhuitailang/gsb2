#!/usr/bin/env python3
"""预约后台站点（端口 8001）。

功能：
- 会话登录（alice / bob），会话 Cookie 为 HttpOnly + SameSite=Lax
- 登录后可在后台修改自己的预约时间，修改必须经过"确认"两步流程
- 所有改预约接口在会话与请求层核对：会话有效性、提交来源（Origin/Referer）、
  每会话一次性校验值（csrf_token，登录时重新签发，切换账号即失效）
- 普通查看链接 /booking 为只读 GET，不改变任何状态
- 拒绝原因记录为安全事件，审计页可见；校验值原文绝不落日志
"""
import html
import re
import secrets
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = 8001
ADMIN_ORIGINS = {"http://localhost:8001", "http://127.0.0.1:8001"}

USERS = {"alice": "alice123", "bob": "bob123"}
appointments = {"alice": "10:00", "bob": "10:00"}  # 样例数据：10:00 的预约
sessions = {}   # sid -> {"user", "csrf", "pending": {"new_time", "nonce"} | None}
audit_log = []  # {"time", "category", "actor", "action", "detail"}
lock = threading.Lock()

TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def log_event(category, actor, action, detail):
    with lock:
        audit_log.append({
            "time": time.strftime("%Y-%m-%d %H:%M:%S"),
            "category": category,
            "actor": actor,
            "action": action,
            "detail": detail,
        })


def esc(s):
    return html.escape(str(s), quote=True)


PAGE = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>{title} - 预约后台</title>
<style>
body {{ font-family: -apple-system, "PingFang SC", sans-serif; max-width: 720px;
       margin: 2rem auto; padding: 0 1rem; color: #222; }}
header {{ display: flex; justify-content: space-between; align-items: center;
          border-bottom: 1px solid #ddd; padding-bottom: .5rem; }}
a {{ color: #0b5fff; }}
table {{ border-collapse: collapse; width: 100%; margin-top: 1rem; }}
th, td {{ border: 1px solid #ddd; padding: .4rem .6rem; text-align: left;
          font-size: .9rem; vertical-align: top; }}
th {{ background: #f5f5f5; }}
.badge {{ display: inline-block; padding: .1rem .5rem; border-radius: .7rem;
          font-size: .8rem; }}
.b-security {{ background: #fde2e2; color: #a40000; }}
.b-booking  {{ background: #e2f3de; color: #1d6b1d; }}
.b-auth     {{ background: #e2e8fd; color: #2a3fa0; }}
.card {{ border: 1px solid #ddd; border-radius: .5rem; padding: 1rem;
         margin-top: 1rem; }}
button {{ padding: .4rem 1rem; cursor: pointer; }}
.msg {{ padding: .5rem .8rem; border-radius: .4rem; margin-top: 1rem; }}
.ok {{ background: #e2f3de; }}
.err {{ background: #fde2e2; }}
</style></head><body>{body}</body></html>"""


def header(sess):
    if sess:
        return (f"<header><strong>预约后台</strong><span>当前用户：{esc(sess['user'])}"
                f" ｜ <a href='/'>首页</a> ｜ <a href='/audit'>审计</a> ｜ "
                f"<form method='post' action='/logout' style='display:inline'>"
                f"<button>退出登录</button></form></span></header>")
    return "<header><strong>预约后台</strong><span><a href='/login'>登录</a></span></header>"


def page(title, body, sess=None):
    return PAGE.format(title=esc(title), body=header(sess) + body)


class Handler(BaseHTTPRequestHandler):
    server_version = "BookingAdmin/1.0"

    # ---------- 基础工具 ----------
    def log_message(self, fmt, *args):  # 静默默认访问日志
        pass

    def send_html(self, body, status=200, extra_headers=None):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (extra_headers or []):
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def redirect(self, location, extra_headers=None):
        self.send_response(303)
        self.send_header("Location", location)
        for k, v in (extra_headers or []):
            self.send_header(k, v)
        self.end_headers()

    def current_session(self):
        cookie = self.headers.get("Cookie", "")
        for part in cookie.split(";"):
            part = part.strip()
            if part.startswith("sid="):
                return sessions.get(part[4:])
        return None

    def read_form(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8", "replace")
        return {k: v[0] for k, v in urllib.parse.parse_qs(raw).items()}

    def request_origin(self):
        origin = self.headers.get("Origin")
        if origin:
            return origin
        ref = self.headers.get("Referer")
        if ref:
            p = urllib.parse.urlsplit(ref)
            return f"{p.scheme}://{p.netloc}"
        return None

    # ---------- 改预约请求的会话与请求层核对 ----------
    def check_change_request(self, sess, form):
        """返回 (ok, reason)。reason 只描述原因，绝不包含校验值原文。"""
        if sess is None:
            return False, "无有效会话（未登录，或浏览器未随请求发送会话 Cookie）"
        origin = self.request_origin()
        if origin not in ADMIN_ORIGINS:
            return False, f"提交来源异常：Origin/Referer={origin or '(缺失)'}，不属于后台站点"
        token = form.get("csrf_token", "")
        if not token:
            return False, "缺少校验值（csrf_token）"
        if not secrets.compare_digest(token, sess["csrf"]):
            return False, "校验值不匹配（可能已过期、属于其他会话或系伪造）"
        return True, ""

    def reject_change(self, sess, reason, endpoint):
        actor = sess["user"] if sess else "(匿名)"
        # 安全事件：只记录原因，不记录任何校验值内容
        log_event("security", actor, "改预约被拒绝", f"接口 {endpoint}：{reason}")
        body = (f"<h1>请求被拒绝</h1><p class='msg err'>{esc(reason)}</p>"
                f"<p>该事件已记入安全审计。</p><p><a href='/'>返回后台首页</a></p>")
        self.send_html(page("请求被拒绝", body, sess), status=403)

    # ---------- GET ----------
    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        sess = self.current_session()

        if path == "/login":
            self.send_html(page("登录", """
<h1>登录预约后台</h1>
<form method="post" action="/login" class="card">
  <p>账号：<input name="username" required></p>
  <p>密码：<input name="password" type="password" required></p>
  <p><button>登录</button></p>
  <p>演示账号：alice / alice123，bob / bob123</p>
</form>""", sess))
            return

        if path == "/":
            if not sess:
                self.redirect("/login")
                return
            user = sess["user"]
            notice = query.get("notice", [""])[0]
            notice_html = f"<p class='msg ok'>{esc(notice)}</p>" if notice else ""
            body = f"""
<h1>我的预约</h1>{notice_html}
<div class="card">
  <p>当前预约时间：<strong>{esc(appointments[user])}</strong></p>
  <form method="post" action="/change/prepare">
    <input type="hidden" name="csrf_token" value="{esc(sess['csrf'])}">
    <p>修改为：<input name="new_time" pattern="^([01]\\d|2[0-3]):[0-5]\\d$"
       placeholder="HH:MM" required></p>
    <p><button>提交修改（进入确认）</button></p>
  </form>
</div>
<p>只读查看链接（可分享给通知页）：
   <a href="/booking?user={esc(user)}">/booking?user={esc(user)}</a></p>"""
            self.send_html(page("首页", body, sess))
            return

        if path == "/booking":
            # 只读查看：GET 不改变任何状态，无需登录
            user = query.get("user", ["alice"])[0]
            if user not in appointments:
                self.send_html(page("查看预约", "<h1>预约不存在</h1>", sess), status=404)
                return
            body = f"""
<h1>预约详情（只读）</h1>
<div class="card">
  <p>用户：<strong>{esc(user)}</strong></p>
  <p>预约时间：<strong>{esc(appointments[user])}</strong></p>
</div>
<p>本页面为只读视图，打开它不会改变任何数据。修改预约请登录后台。</p>"""
            self.send_html(page("查看预约", body, sess))
            return

        if path == "/audit":
            if not sess:
                self.redirect("/login")
                return
            with lock:
                events = list(reversed(audit_log))
            self.send_html(page("安全审计", self.render_audit(events), sess))
            return

        self.send_html(page("404", "<h1>页面不存在</h1>", sess), status=404)

    def render_audit(self, events):
        label = {"security": "安全事件", "booking": "预约变更", "auth": "登录"}
        rows = []
        for e in events:
            rows.append(
                f"<tr><td>{esc(e['time'])}</td>"
                f"<td><span class='badge b-{esc(e['category'])}'>"
                f"{esc(label.get(e['category'], e['category']))}</span></td>"
                f"<td>{esc(e['actor'])}</td><td>{esc(e['action'])}</td>"
                f"<td>{esc(e['detail'])}</td></tr>")
        return ("<h1>安全审计</h1><table><tr><th>时间</th><th>类别</th>"
                "<th>操作者</th><th>动作</th><th>详情</th></tr>"
                + ("".join(rows) or "<tr><td colspan='5'>暂无记录</td></tr>")
                + "</table>")

    # ---------- POST ----------
    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        sess = self.current_session()
        form = self.read_form()

        if path == "/login":
            user = form.get("username", "")
            password = form.get("password", "")
            if USERS.get(user) != password:
                log_event("auth", user or "(空)", "登录失败", "账号或密码错误")
                self.send_html(page("登录失败",
                                    "<h1>登录失败</h1><p class='msg err'>账号或密码错误</p>"
                                    "<p><a href='/login'>返回登录</a></p>"),
                               status=403)
                return
            sid = secrets.token_urlsafe(24)
            sessions[sid] = {"user": user,
                             "csrf": secrets.token_urlsafe(24),  # 每次登录重新签发
                             "pending": None}
            log_event("auth", user, "登录成功", "签发新会话与新校验值")
            self.redirect("/", [("Set-Cookie",
                                 f"sid={sid}; HttpOnly; Path=/; SameSite=Lax")])
            return

        if path == "/logout":
            cookie = self.headers.get("Cookie", "")
            for part in cookie.split(";"):
                part = part.strip()
                if part.startswith("sid="):
                    old = sessions.pop(part[4:], None)
                    if old:
                        log_event("auth", old["user"], "退出登录",
                                  "会话与校验值已作废")
            self.redirect("/login", [("Set-Cookie",
                                      "sid=; HttpOnly; Path=/; Max-Age=0")])
            return

        if path == "/change/prepare":
            ok, reason = self.check_change_request(sess, form)
            if not ok:
                self.reject_change(sess, reason, "/change/prepare")
                return
            new_time = form.get("new_time", "")
            if not TIME_RE.match(new_time):
                self.reject_change(sess, f"时间格式非法：{new_time!r}",
                                   "/change/prepare")
                return
            nonce = secrets.token_urlsafe(16)
            sess["pending"] = {"new_time": new_time, "nonce": nonce}
            body = f"""
<h1>确认修改预约</h1>
<div class="card">
  <p>当前时间：<strong>{esc(appointments[sess['user']])}</strong></p>
  <p>修改为：<strong>{esc(new_time)}</strong></p>
  <form method="post" action="/change/confirm">
    <input type="hidden" name="csrf_token" value="{esc(sess['csrf'])}">
    <input type="hidden" name="nonce" value="{esc(nonce)}">
    <p><button>确认修改</button>
       <a href="/">取消</a></p>
  </form>
</div>"""
            self.send_html(page("确认修改", body, sess))
            return

        if path == "/change/confirm":
            ok, reason = self.check_change_request(sess, form)
            if not ok:
                self.reject_change(sess, reason, "/change/confirm")
                return
            pending = sess.get("pending")
            if not pending or form.get("nonce") != pending["nonce"]:
                self.reject_change(sess, "缺少有效的确认步骤（未经后台确认页提交）",
                                   "/change/confirm")
                return
            sess["pending"] = None
            user = sess["user"]
            old = appointments[user]
            appointments[user] = pending["new_time"]
            log_event("booking", user, "改预约成功",
                      f"预约时间 {old} → {pending['new_time']}（经确认流程）")
            self.redirect("/?notice=" + urllib.parse.quote(
                f"预约已修改：{old} → {pending['new_time']}"))
            return

        self.send_html(page("404", "<h1>接口不存在</h1>", sess), status=404)


if __name__ == "__main__":
    print(f"预约后台运行在 http://localhost:{PORT} （演示账号 alice/alice123）")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
