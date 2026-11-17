"""一键启动演示：两个模拟身份提供方 + 业务后台。

  业务后台      http://localhost:9000
  提供方 甲     http://localhost:9001   演示用户 demo / demo123（sub=alpha-001）
  提供方 乙     http://localhost:9002   演示用户 demo / demo123（sub=beta-001）

两个提供方的演示用户邮箱相同（demo@example.com），但 sub 分属各自体系。
"""
import threading
from werkzeug.serving import make_server

from backend import BACKEND_ORIGIN, app as backend_app
from idp import create_idp_app

BACKEND_CLIENT_REDIRECTS = [
    f"{BACKEND_ORIGIN}/callback/alpha",
    f"{BACKEND_ORIGIN}/callback/beta",
]

# 甲、乙两套旧身份系统：各有一个相同邮箱的演示用户
ALPHA_USERS = {
    "demo": {"password": "demo123", "sub": "alpha-001", "email": "demo@example.com"},
}
BETA_USERS = {
    "demo": {"password": "demo123", "sub": "beta-001", "email": "demo@example.com"},
}

alpha_app = create_idp_app(
    "alpha", "提供方 甲（Alpha）", ALPHA_USERS,
    clients={"backend": {"secret": "secret-alpha",
                         "redirect_uris": [f"{BACKEND_ORIGIN}/callback/alpha"]}},
)
beta_app = create_idp_app(
    "beta", "提供方 乙（Beta）", BETA_USERS,
    clients={"backend": {"secret": "secret-beta",
                         "redirect_uris": [f"{BACKEND_ORIGIN}/callback/beta"]}},
)


def serve(app, port):
    make_server("127.0.0.1", port, app).serve_forever()


if __name__ == "__main__":
    for app, port in [(backend_app, 9000), (alpha_app, 9001), (beta_app, 9002)]:
        threading.Thread(target=serve, args=(app, port), daemon=True).start()
    print("业务后台:      http://localhost:9000")
    print("提供方 甲:     http://localhost:9001  (demo / demo123)")
    print("提供方 乙:     http://localhost:9002  (demo / demo123)")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass
