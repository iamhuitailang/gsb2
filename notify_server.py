#!/usr/bin/env python3
"""通知页站点（端口 8002，与后台 8001 属于不同来源）。

- 提供预约详情的只读链接（跳到后台的 /booking，GET 不改变状态）
- 提供一个"演示变更"按钮：跨站 POST 到后台的改预约接口，
  模拟恶意/伪造请求 —— 应被后台拒绝并记入安全审计
"""
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = 8002
ADMIN = "http://localhost:8001"

PAGE = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>预约通知</title>
<style>
body {{ font-family: -apple-system, "PingFang SC", sans-serif; max-width: 720px;
       margin: 2rem auto; padding: 0 1rem; color: #222; }}
.card {{ border: 1px solid #ddd; border-radius: .5rem; padding: 1rem;
         margin-top: 1rem; }}
button, a.btn {{ padding: .4rem 1rem; }}
.warn {{ background: #fff7e0; border: 1px solid #e0c060; border-radius: .4rem;
         padding: .6rem .8rem; }}
</style></head><body>
<h1>预约通知</h1>
<p>本站点运行在 <code>http://localhost:8002</code>，与预约后台
（<code>http://localhost:8001</code>）是<strong>不同来源</strong>。</p>

<div class="card">
  <h2>你的预约</h2>
  <p>用户 alice 有一条预约，点击下方链接查看详情（只读，不改变状态）：</p>
  <p><a class="btn" href="{admin}/booking?user=alice">查看预约详情</a></p>
</div>

<div class="card">
  <h2>演示：跨站伪造变更请求</h2>
  <p class="warn">下面这个按钮会从本站（8002）向后台（8001）的改预约接口
  直接发起 POST，试图把预约改到 12:00，并附带一个猜测的校验值。
  由于缺少有效会话、来源不符、校验值无效，该请求应被后台拒绝，
  并作为安全事件记入审计，原有预约保持不变。</p>
  <form method="post" action="{admin}/change/confirm">
    <input type="hidden" name="new_time" value="12:00">
    <input type="hidden" name="csrf_token" value="guessed-by-attacker">
    <p><button>发送演示变更（应被拒绝）</button></p>
  </form>
</div>

<p>对照：登录 <a href="{admin}/login">预约后台</a>（alice / alice123）
走确认流程修改预约，才会真正生效。</p>
</body></html>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "BookingNotify/1.0"

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path != "/":
            self.send_response(404)
            self.end_headers()
            return
        data = PAGE.format(admin=ADMIN).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    print(f"通知页运行在 http://localhost:{PORT}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
