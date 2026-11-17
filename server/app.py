"""工单系统 + OAuth 风格授权服务（本地演示）。

角色：
- 用户通过浏览器登录，确认/撤销第三方应用的授权，在设置页查看已授权应用和范围。
- 应用（客户端）使用自己的 client_id/client_secret，经用户确认后换取访问凭据，
  调用工单 API。凭据权限不超过用户授权的范围，也不超过用户当前还能访问的工单。
"""
import secrets
import time
from functools import wraps

from flask import (Flask, abort, jsonify, redirect, render_template_string,
                   request, session, url_for)

app = Flask(__name__)
app.secret_key = "demo-secret-key"  # 仅本地演示

# ---------------------------------------------------------------- 数据（内存）

SCOPE_READ = "read:titles"      # 只读标题
SCOPE_UPDATE = "update:status"  # 更新状态
ALL_SCOPES = {SCOPE_READ, SCOPE_UPDATE}
SCOPE_LABELS = {SCOPE_READ: "只读标题", SCOPE_UPDATE: "更新状态"}

USERS = {"alice": {"password": "alice123", "name": "Alice"}}

TICKETS = {
    1: {"id": 1, "title": "修复登录页 500 错误", "status": "open", "assignees": {"alice"}},
    2: {"id": 2, "title": "更新部署文档", "status": "open", "assignees": {"alice"}},
}

CLIENTS = {
    "app-jia": {"secret": "jia-secret", "name": "甲应用"},
    "app-yi": {"secret": "yi-secret", "name": "乙应用"},
}

GRANTS = {}          # (username, client_id) -> set(scopes)  用户已授权的范围
CODES = {}           # code -> {username, client_id, scopes, expires}
ACCESS_TOKENS = {}   # token -> {username, client_id, scopes, expires}
REFRESH_TOKENS = {}  # token -> {username, client_id, scopes}

CODE_TTL = 600
ACCESS_TTL = 3600

# ---------------------------------------------------------------- 工具


def current_user():
    return session.get("username")


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not current_user():
            return redirect(url_for("login", next=request.url))
        return view(*args, **kwargs)
    return wrapper


def issue_code(username, client_id, scopes):
    code = secrets.token_hex(16)
    CODES[code] = {
        "username": username,
        "client_id": client_id,
        "scopes": set(scopes),
        "expires": time.time() + CODE_TTL,
    }
    return code


def issue_tokens(username, client_id, scopes):
    access = secrets.token_hex(24)
    refresh = secrets.token_hex(24)
    ACCESS_TOKENS[access] = {
        "username": username,
        "client_id": client_id,
        "scopes": set(scopes),
        "expires": time.time() + ACCESS_TTL,
    }
    REFRESH_TOKENS[refresh] = {
        "username": username,
        "client_id": client_id,
        "scopes": set(scopes),
    }
    return {"access_token": access, "refresh_token": refresh,
            "token_type": "Bearer", "expires_in": ACCESS_TTL,
            "scope": " ".join(sorted(scopes))}


def authenticate_client():
    """支持 Basic 或表单方式提交 client_id/client_secret。"""
    auth = request.authorization
    if auth:
        client_id, secret = auth.username, auth.password
    else:
        client_id = request.form.get("client_id", "")
        secret = request.form.get("client_secret", "")
    client = CLIENTS.get(client_id)
    if not client or client["secret"] != secret:
        abort(401, "客户端认证失败")
    return client_id


def token_user_tickets(username):
    """用户当前还能访问的工单。"""
    return [t for t in TICKETS.values() if username in t["assignees"]]


def require_token(scope):
    """校验 Bearer 凭据：存在、未过期、且包含所需范围。"""
    header = request.headers.get("Authorization", "")
    token = header.removeprefix("Bearer ").strip()
    info = ACCESS_TOKENS.get(token)
    if not info or info["expires"] < time.time():
        abort(401, "访问凭据无效或已失效")
    if scope not in info["scopes"]:
        abort(403, f"缺少范围 {scope}")
    return info


# ---------------------------------------------------------------- 页面模板

BASE = """
<!doctype html><meta charset="utf-8"><title>工单系统</title>
<body style="font-family:sans-serif;max-width:640px;margin:2em auto">
<h2>工单系统</h2>
{% if user %}<p>当前用户：{{ user }} ｜ <a href="{{ url_for('index') }}">工单</a>
｜ <a href="{{ url_for('settings') }}">授权设置</a>
｜ <a href="{{ url_for('logout') }}">退出</a></p><hr>{% endif %}
{{ body | safe }}
</body>
"""


def page(body, user=None):
    return render_template_string(BASE, body=body, user=user or current_user())


# ---------------------------------------------------------------- 用户界面


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = request.form.get("username", "")
        user = USERS.get(username)
        if user and user["password"] == request.form.get("password"):
            session["username"] = username
            return redirect(request.args.get("next") or url_for("index"))
        return page("<p>登录失败</p>"), 401
    return page("""
      <form method="post">
        <p>用户名 <input name="username"></p>
        <p>密码 <input name="password" type="password"></p>
        <button>登录</button>
      </form>""")


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/")
@login_required
def index():
    rows = "".join(
        f"<li>#{t['id']} {t['title']} ［{t['status']}］</li>"
        for t in token_user_tickets(current_user()))
    return page(f"<h3>我的工单</h3><ul>{rows}</ul>")


@app.route("/settings")
@login_required
def settings():
    items = []
    for (username, client_id), scopes in sorted(GRANTS.items()):
        if username != current_user():
            continue
        labels = "、".join(SCOPE_LABELS[s] for s in sorted(scopes))
        items.append(f"""
          <li><b>{CLIENTS[client_id]['name']}</b>（{client_id}）— 范围：{labels}
            <form method="post" action="{url_for('revoke')}" style="display:inline">
              <input type="hidden" name="client_id" value="{client_id}">
              <button>撤销授权</button>
            </form></li>""")
    body = "<h3>已授权的应用</h3>" + ("<ul>" + "".join(items) + "</ul>"
                                      if items else "<p>暂无授权</p>")
    return page(body)


@app.route("/settings/revoke", methods=["POST"])
@login_required
def revoke():
    client_id = request.form.get("client_id", "")
    username = current_user()
    GRANTS.pop((username, client_id), None)
    # 该应用先前获得的凭据和续期能力一起失效
    for store in (ACCESS_TOKENS, REFRESH_TOKENS):
        for token in [t for t, i in store.items()
                      if i["username"] == username and i["client_id"] == client_id]:
            del store[token]
    return redirect(url_for("settings"))


# ---------------------------------------------------------------- OAuth 授权


@app.route("/authorize")
@login_required
def authorize():
    client_id = request.args.get("client_id", "")
    client = CLIENTS.get(client_id)
    if not client:
        abort(400, "未知应用")
    requested = set(request.args.get("scope", "").split()) & ALL_SCOPES
    if not requested:
        requested = {SCOPE_READ}

    username = current_user()
    granted = GRANTS.get((username, client_id), set())
    if requested <= granted:
        # 已授权范围覆盖本次请求，无需再次确认
        return show_code(issue_code(username, client_id, requested))

    # 新授权或范围升级：必须重新经过用户确认
    boxes = "".join(
        f'<label><input type="checkbox" name="scopes" value="{s}" checked> '
        f"{SCOPE_LABELS[s]}</label><br>" for s in sorted(requested))
    return page(f"""
      <h3>授权确认</h3>
      <p>应用 <b>{client['name']}</b>（{client_id}）请求以下权限，请勾选确认：</p>
      <form method="post" action="{url_for('confirm')}">
        <input type="hidden" name="client_id" value="{client_id}">
        <input type="hidden" name="requested" value="{' '.join(sorted(requested))}">
        {boxes}
        <button>确认授权</button>
      </form>""")


@app.route("/authorize/confirm", methods=["POST"])
@login_required
def confirm():
    client_id = request.form.get("client_id", "")
    if client_id not in CLIENTS:
        abort(400, "未知应用")
    requested = set(request.form.get("requested", "").split()) & ALL_SCOPES
    selected = set(request.form.getlist("scopes")) & requested
    if not selected:
        return page("<p>未选择任何权限，授权取消。</p>"), 400

    username = current_user()
    GRANTS.setdefault((username, client_id), set()).update(selected)
    return show_code(issue_code(username, client_id, selected))


def show_code(code):
    return page(f"""
      <h3>授权成功</h3>
      <p>请将授权码粘贴到应用中：</p>
      <pre id="auth-code">{code}</pre>""")


@app.route("/token", methods=["POST"])
def token():
    client_id = authenticate_client()
    grant_type = request.form.get("grant_type")

    if grant_type == "authorization_code":
        code = CODES.pop(request.form.get("code", ""), None)
        if not code or code["expires"] < time.time() or code["client_id"] != client_id:
            abort(400, "授权码无效")
        return jsonify(issue_tokens(code["username"], client_id, code["scopes"]))

    if grant_type == "refresh_token":
        info = REFRESH_TOKENS.get(request.form.get("refresh_token", ""))
        if not info or info["client_id"] != client_id:
            abort(401, "续期凭据无效或已失效")
        # 续期只发新访问凭据，范围与续期凭据一致（不随授权升级而扩大）
        access = secrets.token_hex(24)
        ACCESS_TOKENS[access] = {
            "username": info["username"],
            "client_id": client_id,
            "scopes": set(info["scopes"]),
            "expires": time.time() + ACCESS_TTL,
        }
        return jsonify({"access_token": access, "token_type": "Bearer",
                        "expires_in": ACCESS_TTL,
                        "scope": " ".join(sorted(info["scopes"]))})

    abort(400, "不支持的 grant_type")


# ---------------------------------------------------------------- 工单 API


@app.route("/api/tickets")
def api_tickets():
    info = require_token(SCOPE_READ)
    tickets = [{"id": t["id"], "title": t["title"]}
               for t in token_user_tickets(info["username"])]
    return jsonify({"tickets": tickets})


@app.route("/api/tickets/<int:ticket_id>/status", methods=["POST"])
def api_update_status(ticket_id):
    info = require_token(SCOPE_UPDATE)
    ticket = TICKETS.get(ticket_id)
    # 不超过当前用户还能访问的工单
    if not ticket or info["username"] not in ticket["assignees"]:
        abort(404, "工单不存在或当前用户无权访问")
    status = (request.get_json(silent=True) or {}).get("status")
    if not status:
        abort(400, "缺少 status")
    ticket["status"] = status
    return jsonify({"ticket": {"id": ticket["id"], "title": ticket["title"],
                               "status": ticket["status"]}})


@app.errorhandler(400)
@app.errorhandler(401)
@app.errorhandler(403)
@app.errorhandler(404)
def api_error(err):
    if request.path.startswith("/api/") or request.path == "/token":
        return jsonify({"error": err.description}), err.code
    return page(f"<p>错误 {err.code}：{err.description}</p>"), err.code


if __name__ == "__main__":
    app.run(port=5051)
