"""端到端冒烟测试：用脚本模拟浏览器验证全部验收场景。

运行前先启动服务：python3 run.py
然后执行：python3 smoke_test.py
"""
import http.cookiejar
import re
import urllib.error
import urllib.parse
import urllib.request

BASE = "http://localhost:9000"
DEMO = {"username": "demo", "password": "demo123"}


class Browser:
    """带 Cookie 的迷你浏览器，跟随重定向并记录每一次跳转地址。"""

    def __init__(self):
        self.redirects = []
        cookiejar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(cookiejar),
            self._recording_redirect_handler(),
        )

    def _recording_redirect_handler(self):
        redirects = self.redirects

        class Handler(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                redirects.append(newurl)
                return super().redirect_request(req, fp, code, msg, headers, newurl)

        return Handler()

    def _open(self, url, data=None):
        try:
            return self.opener.open(url, data).read().decode()
        except urllib.error.HTTPError as e:  # 4xx/5xx 也返回页面内容
            return e.read().decode()

    def get(self, url):
        return self._open(url)

    def post(self, url, data):
        return self._open(url, urllib.parse.urlencode(data).encode())

    def oauth_login(self, start_url):
        """从后台的登录/绑定入口开始，走完整个授权码流程，返回最终页面。"""
        self.redirects.clear()
        page = self.get(start_url)  # 302 到 IdP，拿到登录表单
        action = re.search(r'action="([^"]*)"', page)
        form_url = action.group(1) if action else self.redirects[-1]
        return self.post(form_url, {
            "client_id": "backend",
            "redirect_uri": re.search(r'name="redirect_uri" value="([^"]*)"', page).group(1),
            "state": re.search(r'name="state" value="([^"]*)"', page).group(1),
            **DEMO,
        })


def account_of(page):
    m = re.search(r"本地账号\s*<b>#(\d+)</b>", page)
    assert m, f"页面中未找到本地账号：{page[:200]}"
    return int(m.group(1))


passed = []


def check(name, ok, extra=""):
    assert ok, f"FAILED: {name} {extra}"
    passed.append(name)
    print(f"  PASS  {name}")


print("1) 通过甲登录，创建本地账号")
alice = Browser()
home = alice.oauth_login(f"{BASE}/login/alpha")
acc1 = account_of(home)
check("甲登录成功", "登录成功" in home)

print("2) 刷新已用过的回调地址，不得再次登录")
callback_url = next(u for u in alice.redirects if u.startswith(f"{BASE}/callback/"))
replay = alice.get(callback_url)
check("重放回调被拒绝", "已被消费" in replay)
check("重放未改变登录态", account_of(alice.get(BASE)) == acc1)

print("3) 只绑了甲时，从乙登录进入的是另一个账号（邮箱相同也不合并）")
other = Browser()
home_b = other.oauth_login(f"{BASE}/login/beta")
acc2 = account_of(home_b)
check("乙登录得到不同账号", acc2 != acc1, f"acc1={acc1} acc2={acc2}")

print("4) 乙身份已绑到账号 #{} 时，账号 #{} 不能再绑它".format(acc2, acc1))
conflict = alice.oauth_login(f"{BASE}/settings/bind/beta")
check("重复绑定被拒绝", "已绑定到另一个本地账号" in conflict)

print("5) 解绑后，账号 #{} 在设置中显式绑定乙身份".format(acc1))
other.post(f"{BASE}/settings/unbind/beta", {})
bound = alice.oauth_login(f"{BASE}/settings/bind/beta")
check("绑定成功", "绑定成功" in bound or "绑定成功" in alice.get(f"{BASE}/settings"))
settings_page = alice.get(f"{BASE}/settings")
check("设置页同时列出两个身份",
      "alpha-001" in settings_page and "beta-001" in settings_page)

print("6) 绑定完成后，从乙登录进入同一个本地账号")
third = Browser()
home_b2 = third.oauth_login(f"{BASE}/login/beta")
check("乙登录进入账号 #{}".format(acc1), account_of(home_b2) == acc1)

print("7) 换会话/伪造 state 的回调一律无效")
stranger = Browser()
for bad_url in (
    f"{BASE}/callback/alpha?code=x&state=forged",
    callback_url,  # 旧回调在别的会话里同样无效
):
    page = stranger.get(bad_url)
    check(f"非法回调被拒 ({bad_url[:60]}...)", "登录请求无效" in page)

print(f"\n全部 {len(passed)} 项检查通过。")
