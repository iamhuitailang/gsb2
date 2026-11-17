"""模拟身份提供方（IdP）。

实现一个极简 OAuth2 授权码流程：
  GET  /authorize  登录表单（携带 client_id / redirect_uri / state）
  POST /authorize  校验用户口令与客户端，签发一次性授权码并 302 回业务后台
  POST /token      用授权码换访问令牌（授权码一次性，校验 redirect_uri 与客户端密钥）
  GET  /userinfo   凭访问令牌返回该提供方体系内的用户标识 sub 与邮箱

每个提供方有自己独立的用户体系：sub 只在本提供方内唯一。
"""
import secrets
import threading

from flask import Flask, abort, jsonify, redirect, render_template_string, request

LOGIN_PAGE = """
<!doctype html><meta charset="utf-8">
<title>{{display}} 登录</title>
<h2>{{display}}（模拟身份提供方）</h2>
<p>应用 <code>{{client_id}}</code> 请求以你的身份登录。</p>
{% if error %}<p style="color:red">{{error}}</p>{% endif %}
<form method="post">
  <input type="hidden" name="client_id" value="{{client_id}}">
  <input type="hidden" name="redirect_uri" value="{{redirect_uri}}">
  <input type="hidden" name="state" value="{{state}}">
  <p>用户名 <input name="username" value="{{demo_user}}"></p>
  <p>密码 <input name="password" type="password" value="{{demo_pass}}"></p>
  <button type="submit">登录并授权</button>
</form>
<p style="color:#888">演示账号：{{demo_user}} / {{demo_pass}}</p>
"""


def create_idp_app(name, display, users, clients):
    """users: {username: {"password":..., "sub":..., "email":...}}
    clients: {client_id: {"secret":..., "redirect_uris": [...]}}
    """
    app = Flask(f"idp-{name}")
    app.config["JSON_AS_ASCII"] = False

    codes = {}    # code -> {client_id, redirect_uri, sub, used}
    tokens = {}   # access_token -> sub
    lock = threading.Lock()

    demo_username = next(iter(users))

    @app.route("/authorize", methods=["GET", "POST"])
    def authorize():
        client_id = request.values.get("client_id", "")
        redirect_uri = request.values.get("redirect_uri", "")
        state = request.values.get("state", "")
        error = None

        client = clients.get(client_id)
        if not client or redirect_uri not in client["redirect_uris"]:
            return "未注册的客户端或回调地址", 400

        if request.method == "POST":
            username = request.form.get("username", "")
            password = request.form.get("password", "")
            user = users.get(username)
            if user and user["password"] == password:
                code = secrets.token_urlsafe(16)
                with lock:
                    codes[code] = {
                        "client_id": client_id,
                        "redirect_uri": redirect_uri,
                        "sub": user["sub"],
                        "used": False,
                    }
                sep = "&" if "?" in redirect_uri else "?"
                return redirect(f"{redirect_uri}{sep}code={code}&state={state}")
            error = "用户名或密码错误"

        return render_template_string(
            LOGIN_PAGE,
            display=display,
            client_id=client_id,
            redirect_uri=redirect_uri,
            state=state,
            error=error,
            demo_user=demo_username,
            demo_pass=users[demo_username]["password"],
        )

    @app.route("/token", methods=["POST"])
    def token():
        code = request.form.get("code", "")
        client_id = request.form.get("client_id", "")
        client_secret = request.form.get("client_secret", "")
        redirect_uri = request.form.get("redirect_uri", "")

        with lock:
            grant = codes.get(code)
            if not grant or grant["used"]:
                return jsonify(error="invalid_grant"), 400
            client = clients.get(client_id)
            if not client or client["secret"] != client_secret:
                return jsonify(error="invalid_client"), 401
            if grant["client_id"] != client_id or grant["redirect_uri"] != redirect_uri:
                return jsonify(error="invalid_grant"), 400
            grant["used"] = True  # 授权码一次性
            access_token = secrets.token_urlsafe(24)
            tokens[access_token] = grant["sub"]

        return jsonify(access_token=access_token, token_type="Bearer")

    @app.route("/userinfo")
    def userinfo():
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            abort(401)
        sub = tokens.get(auth[7:])
        if not sub:
            abort(401)
        for user in users.values():
            if user["sub"] == sub:
                return jsonify(sub=sub, email=user["email"])
        abort(500)

    return app
