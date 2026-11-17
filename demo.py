#!/usr/bin/env python3
"""端到端演示：工单系统为甲、乙两个本地应用授权。

场景：
  1. 用户登录，给甲应用“只读标题”——甲能查标题，不能更新状态
  2. 乙应用先获“只读标题”，再升级为“更新状态”——升级需重新确认，
     已发出的只读凭据仍按原范围处理
  3. 乙用新凭据成功更新一张工单
  4. 设置页能看到两个应用及各自范围
  5. 用户撤销乙——乙的访问凭据和续期能力一起失效，甲不受影响
"""
import http.cookiejar
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "clients"))

from ticket_client import ApiError, TicketClient

BASE = "http://localhost:5051"
PORT = 5051

passed = 0


def check(label, ok, detail=""):
    global passed
    if not ok:
        print(f"  ✗ {label} {detail}")
        sys.exit(1)
    passed += 1
    print(f"  ✓ {label} {detail}")


# ------------------------------------------------------------- 用户（浏览器）

class Browser:
    """模拟用户浏览器：带 cookie 会话，跟随重定向。"""

    def __init__(self):
        jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(jar))

    def get(self, path):
        return self.opener.open(BASE + path).read().decode()

    def post(self, path, data):
        body = urllib.parse.urlencode(data, doseq=True).encode()
        return self.opener.open(BASE + path, data=body).read().decode()

    def login(self, username, password):
        self.post("/login", {"username": username, "password": password})

    def authorize(self, client_id, scopes, confirm=None):
        """走 /authorize。confirm=None 表示期望直接发码；
        否则期望出现确认页，并以 confirm 列表勾选范围后提交。"""
        page = self.get(f"/authorize?client_id={client_id}"
                        f"&scope={urllib.parse.quote(' '.join(scopes))}")
        code = re.search(r'<pre id="auth-code">(\w+)</pre>', page)
        if confirm is None:
            assert code, "期望直接发码，却出现了确认页"
            return code.group(1)
        assert "授权确认" in page, "期望出现确认页，却被直接发码"
        page = self.post("/authorize/confirm", {
            "client_id": client_id,
            "requested": " ".join(sorted(scopes)),
            "scopes": confirm,
        })
        return re.search(r'<pre id="auth-code">(\w+)</pre>', page).group(1)


# ------------------------------------------------------------- 主流程


def wait_ready(proc):
    for _ in range(50):
        if proc.poll() is not None:
            sys.exit("服务器启动失败")
        try:
            urllib.request.urlopen(f"{BASE}/login", timeout=1)
            return
        except urllib.error.URLError:
            time.sleep(0.1)
    sys.exit("服务器未就绪")


def main():
    server = subprocess.Popen(
        [sys.executable, "-c",
         "import sys; sys.path.insert(0, 'server'); "
         "from app import app; app.run(port=%d)" % PORT],
        cwd=Path(__file__).resolve().parent,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_ready(server)
        user = Browser()
        user.login("alice", "alice123")
        jia = TicketClient(BASE, "app-jia", "jia-secret")
        yi = TicketClient(BASE, "app-yi", "yi-secret")

        print("\n【1】授权甲应用“只读标题”")
        code = user.authorize("app-jia", ["read:titles"], confirm=["read:titles"])
        jia_tokens = jia.exchange_code(code)
        jia_access = jia_tokens["access_token"]
        titles = [t["title"] for t in jia.list_titles(jia_access)]
        check("甲能查到两张工单的标题", len(titles) == 2, f"→ {titles}")
        try:
            jia.update_status(jia_access, 1, "done")
            check("甲更新状态被拒绝", False)
        except ApiError as e:
            check("甲更新状态被拒绝（403 缺少范围）", e.status == 403)

        print("\n【2】乙应用先只读，再升级为可更新")
        code = user.authorize("app-yi", ["read:titles"], confirm=["read:titles"])
        yi_ro = yi.exchange_code(code)
        check("乙只读凭据能查标题",
              len(yi.list_titles(yi_ro["access_token"])) == 2)
        try:
            yi.update_status(yi_ro["access_token"], 1, "done")
            check("乙只读凭据更新被拒绝", False)
        except ApiError as e:
            check("乙只读凭据更新被拒绝（403）", e.status == 403)

        # 升级：请求 update:status，必须重新经过用户确认
        code = user.authorize("app-yi", ["update:status"],
                              confirm=["update:status"])
        yi_tokens = yi.exchange_code(code)
        yi_access = yi_tokens["access_token"]

        print("\n【3】已发出的只读凭据仍按原范围处理")
        check("乙旧只读凭据仍能查标题",
              len(yi.list_titles(yi_ro["access_token"])) == 2)
        try:
            yi.update_status(yi_ro["access_token"], 1, "done")
            check("乙旧只读凭据仍不能更新", False)
        except ApiError as e:
            check("乙旧只读凭据仍不能更新（403）", e.status == 403)
        renewed = yi.refresh(yi_ro["refresh_token"])
        check("乙旧只读凭据续期后仍是只读范围",
              renewed["scope"] == "read:titles")
        try:
            yi.update_status(renewed["access_token"], 1, "done")
            check("续期后的只读凭据仍不能更新", False)
        except ApiError as e:
            check("续期后的只读凭据仍不能更新（403）", e.status == 403)

        print("\n【4】乙用新凭据更新工单 #1")
        ticket = yi.update_status(yi_access, 1, "done")
        check("更新成功", ticket["status"] == "done",
              f"→ #1 状态 = {ticket['status']}")

        print("\n【5】设置页展示已授权应用和范围")
        settings = user.get("/settings")
        check("显示甲应用及“只读标题”",
              "甲应用" in settings and "只读标题" in settings)
        check("显示乙应用及“更新状态”",
              "乙应用" in settings and "更新状态" in settings)

        print("\n【6】用户撤销乙应用")
        user.post("/settings/revoke", {"client_id": "app-yi"})
        try:
            yi.update_status(yi_access, 2, "done")
            check("撤销后乙旧凭据更新失败", False)
        except ApiError as e:
            check("撤销后乙旧凭据更新失败（401）", e.status == 401)
        try:
            yi.list_titles(yi_ro["access_token"])
            check("撤销后乙只读凭据也失效", False)
        except ApiError as e:
            check("撤销后乙只读凭据也失效（401）", e.status == 401)
        try:
            yi.refresh(yi_tokens["refresh_token"])
            check("撤销后乙续期能力失效", False)
        except ApiError as e:
            check("撤销后乙续期能力失效（401）", e.status == 401)

        print("\n【7】甲应用不受影响")
        titles = [t["title"] for t in jia.list_titles(jia_access)]
        check("甲仍能查原本可见的标题", len(titles) == 2, f"→ {titles}")
        renewed = jia.refresh(jia_tokens["refresh_token"])
        check("甲仍能续期", renewed["scope"] == "read:titles")

        print(f"\n全部 {passed} 项检查通过 ✅")
    finally:
        server.terminate()
        server.wait()


if __name__ == "__main__":
    main()
