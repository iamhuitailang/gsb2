"""业务后台。

通过选定的身份提供方完成登录（OAuth2 授权码流程）。

账号模型：
  - 本地账号只通过 (provider, sub) 二元组绑定外部身份；
    邮箱仅作展示，绝不用于合并账号。
  - 同一个外部身份 (provider, sub) 全站只能绑到一个本地账号。

回调安全：
  - 每次登录/绑定请求先在后端登记 state -> {提供方, 会话, 模式, 过期时间, 是否已消费}；
  - 回调必须落在与发起时相同的提供方路径、相同的浏览器会话上；
  - state 一经消费立即作废，刷新已用过的回调地址不会再次登录。
"""
import json
import secrets
import threading
import time
import urllib.parse
import urllib.request

from flask import Flask, redirect, render_template_string, request, session, url_for

BACKEND_ORIGIN = "http://localhost:9000"

PROVIDERS = {
    "alpha": {
        "display": "甲（Alpha）",
        "url": "http://localhost:9001",
        "client_id": "backend",
        "client_secret": "secret-alpha",
    },
    "beta": {
        "display": "乙（Beta）",
        "url": "http://localhost:9002",
        "client_id": "backend",
        "client_secret": "secret-beta",
    },
}

STATE_TTL = 600  # 登录请求 10 分钟内有效

app = Flask(__name__)
app.secret_key = "demo-secret-key"  # 演示用，生产应来自环境变量

lock = threading.Lock()
users = {}        # user_id -> {"id":..., "created_at":...}
identities = {}   # (provider, sub) -> {"user_id":..., "email":...}
pending = {}      # state -> {provider, mode, sid, user_id?, expires, used}
next_user_id = [1]

HOME_PAGE = """
<!doctype html><meta charset="utf-8">
<title>业务后台</title>
<h2>业务后台</h2>
{% if user %}
  <p>已登录本地账号 <b>#{{user.id}}</b></p>
  <p><a href="{{url_for('settings')}}">账号设置</a> ·
     <a href="{{url_for('logout')}}" onclick="event.preventDefault();document.getElementById('lo').submit()">退出登录</a></p>
  <form id="lo" method="post" action="{{url_for('logout')}}"></form>
{% else %}
  <p>请选择身份提供方登录：</p>
  {% for key, p in providers.items() %}
    <p><a href="{{url_for('login', provider=key)}}">通过 {{p.display}} 登录</a></p>
  {% endfor %}
{% endif %}
{% if message %}<p style="color:{{color}}">{{message}}</p>{% endif %}
"""

SETTINGS_PAGE = """
<!doctype html><meta charset="utf-8">
<title>账号设置</title>
<h2>账号设置 — 本地账号 #{{user.id}}</h2>
<p>已绑定的外部身份（邮箱仅展示，不作为合并依据）：</p>
<table border="1" cellpadding="6">
  <tr><th>提供方</th><th>外部用户标识 sub</th><th>邮箱</th><th></th></tr>
  {% for idn in bound %}
  <tr>
    <td>{{idn.display}}</td><td>{{idn.sub}}</td><td>{{idn.email}}</td>
    <td>
      <form method="post" action="{{url_for('unbind', provider=idn.provider)}}" style="display:inline">
        <button type="submit">解绑</button>
      </form>
    </td>
  </tr>
  {% endfor %}
</table>
{% for key, p in unbound_providers.items() %}
  <p><a href="{{url_for('bind', provider=key)}}">绑定 {{p.display}} 身份</a></p>
{% endfor %}
{% if message %}<p style="color:{{color}}">{{message}}</p>{% endif %}
<p><a href="{{url_for('home')}}">返回首页</a></p>
"""

ERROR_PAGE = """
<!doctype html><meta charset="utf-8">
<title>错误</title>
<h2 style="color:red">{{title}}</h2>
<p>{{detail}}</p>
<p><a href="{{url_for('home')}}">返回首页</a></p>
"""


def current_user():
    uid = session.get("uid")
    return users.get(uid) if uid else None


def get_session_id():
    """标识当前浏览器会话，用于把回调绑定到发起它的会话。"""
    if "sid" not in session:
        session["sid"] = secrets.token_urlsafe(16)
    return session["sid"]


def new_state(provider, mode, user_id=None):
    state = secrets.token_urlsafe(16)
    with lock:
        pending[state] = {
            "provider": provider,
            "mode": mode,               # "login" 或 "bind"
            "sid": get_session_id(),
            "user_id": user_id,         # bind 模式下要绑到的本地账号
            "expires": time.time() + STATE_TTL,
            "used": False,
        }
    return state


def consume_state(state, provider):
    """取出并作废一次登录请求。任何不匹配都返回错误信息。"""
    with lock:
        req = pending.get(state)
        if req is None:
            return None, "未知的登录请求（state 不存在或已被清理）"
        if req["used"]:
            return None, "该登录请求已被消费，不能重复使用"
        if req["provider"] != provider:
            return None, "回调的提供方与发起时不一致"
        if req["sid"] != session.get("sid"):
            return None, "回调会话与发起登录的会话不一致"
        if req["expires"] < time.time():
            return None, "登录请求已过期，请重新发起"
        req["used"] = True  # 立即作废：一次登录请求只能消费一次
    return req, None


def exchange_code(provider, code):
    p = PROVIDERS[provider]
    redirect_uri = f"{BACKEND_ORIGIN}{url_for('callback', provider=provider)}"
    data = urllib.parse.urlencode({
        "code": code,
        "client_id": p["client_id"],
        "client_secret": p["client_secret"],
        "redirect_uri": redirect_uri,
    }).encode()
    req = urllib.request.Request(f"{p['url']}/token", data=data)
    with urllib.request.urlopen(req) as resp:
        token = json.load(resp)["access_token"]
    req = urllib.request.Request(
        f"{p['url']}/userinfo", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)  # {"sub":..., "email":...}


def create_user():
    with lock:
        uid = next_user_id[0]
        next_user_id[0] += 1
        users[uid] = {"id": uid, "created_at": time.time()}
    return uid


def bind_identity(provider, sub, email, user_id):
    """绑定外部身份。同一外部身份不能绑到两个本地账号。"""
    key = (provider, sub)
    with lock:
        existing = identities.get(key)
        if existing:
            if existing["user_id"] != user_id:
                return "该外部身份已绑定到另一个本地账号，无法重复绑定"
            return None  # 已绑在本账号，幂等
        identities[key] = {"user_id": user_id, "email": email}
    return None


@app.route("/")
def home():
    return render_template_string(
        HOME_PAGE, user=current_user(), providers=PROVIDERS,
        message=request.args.get("msg"), color=request.args.get("color", "green"))


@app.route("/login/<provider>")
def login(provider):
    if provider not in PROVIDERS:
        return "未知提供方", 404
    state = new_state(provider, "login")
    p = PROVIDERS[provider]
    redirect_uri = f"{BACKEND_ORIGIN}{url_for('callback', provider=provider)}"
    return redirect(
        f"{p['url']}/authorize?client_id={p['client_id']}"
        f"&redirect_uri={urllib.parse.quote(redirect_uri)}&state={state}")


@app.route("/settings/bind/<provider>")
def bind(provider):
    if provider not in PROVIDERS:
        return "未知提供方", 404
    user = current_user()
    if not user:
        return redirect(url_for("home"))
    state = new_state(provider, "bind", user_id=user["id"])
    p = PROVIDERS[provider]
    redirect_uri = f"{BACKEND_ORIGIN}{url_for('callback', provider=provider)}"
    return redirect(
        f"{p['url']}/authorize?client_id={p['client_id']}"
        f"&redirect_uri={urllib.parse.quote(redirect_uri)}&state={state}")


@app.route("/callback/<provider>")
def callback(provider):
    if provider not in PROVIDERS:
        return "未知提供方", 404
    req, error = consume_state(request.args.get("state", ""), provider)
    if error:
        return render_template_string(
            ERROR_PAGE, title="登录请求无效", detail=error), 400

    try:
        info = exchange_code(provider, request.args.get("code", ""))
    except Exception:
        return render_template_string(
            ERROR_PAGE, title="令牌交换失败",
            detail="授权码无效或已被使用"), 400

    sub, email = info["sub"], info["email"]
    key = (provider, sub)

    if req["mode"] == "login":
        existing = identities.get(key)
        uid = existing["user_id"] if existing else create_user()
        if not existing:
            bind_identity(provider, sub, email, uid)
        session["uid"] = uid
        return redirect(url_for("home", msg=f"通过 {PROVIDERS[provider]['display']} 登录成功"))

    # bind 模式：把外部身份绑到发起绑定时的本地账号
    error = bind_identity(provider, sub, email, req["user_id"])
    if error:
        return render_template_string(ERROR_PAGE, title="绑定失败", detail=error), 409
    return redirect(url_for("settings", msg="绑定成功"))


@app.route("/settings")
def settings():
    user = current_user()
    if not user:
        return redirect(url_for("home"))
    bound = [
        {"provider": prov, "display": PROVIDERS[prov]["display"],
         "sub": sub, "email": idn["email"]}
        for (prov, sub), idn in identities.items()
        if idn["user_id"] == user["id"]
    ]
    bound_providers = {b["provider"] for b in bound}
    unbound = {k: p for k, p in PROVIDERS.items() if k not in bound_providers}
    return render_template_string(
        SETTINGS_PAGE, user=user, bound=bound, unbound_providers=unbound,
        message=request.args.get("msg"), color="green")


@app.route("/settings/unbind/<provider>", methods=["POST"])
def unbind(provider):
    user = current_user()
    if not user:
        return redirect(url_for("home"))
    bound_keys = [k for k, v in identities.items() if v["user_id"] == user["id"]]
    with lock:
        for key in bound_keys:
            if key[0] == provider:
                # 解绑最后一个身份后，该本地账号将无法再登录（演示允许此状态）
                del identities[key]
    return redirect(url_for("settings", msg="已解绑"))


@app.route("/logout", methods=["POST"])
def logout():
    session.pop("uid", None)
    return redirect(url_for("home"))
