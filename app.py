#!/usr/bin/env python3
"""业务服务（管理后台），监听 127.0.0.1:18081。

来源检查安全模型：
- 连接同时满足两个条件，才认为来自已配置的代理：
  1. TCP 对端地址属于 policy.json 中的 trusted_proxies；
  2. 携带与 proxy_secret 一致的 X-Proxy-Token 凭证。
  满足时才采信代理写入的 X-Forwarded-For（生产环境建议改用 mTLS）；
- 直连请求（含本机直连）一律使用实际连接地址，客户端自带的来源
  字段直接忽略——不会因为对方来自本机就信任它声称的来源；
- 采信来源与机构配置的 IPv4/IPv6 范围（allow_rules）按网段比较；
- 每次请求都重新读取 policy.json，策略修改后下一次请求即生效。
"""
import html
import ipaddress
import json
import threading
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

POLICY_PATH = Path(__file__).with_name("policy.json")
LISTEN_ADDR = ("127.0.0.1", 18081)

access_log = deque(maxlen=200)
log_lock = threading.Lock()


def load_policy():
    """每次请求重新加载策略文件：改完策略，下一次请求就按新配置判断。"""
    with open(POLICY_PATH, encoding="utf-8") as f:
        raw = json.load(f)
    trusted = [ipaddress.ip_network(c) for c in raw.get("trusted_proxies", [])]
    rules = [
        {"name": r["name"], "network": ipaddress.ip_network(r["cidr"])}
        for r in raw.get("allow_rules", [])
    ]
    return trusted, raw.get("proxy_secret", ""), rules


def decide(peer_ip, xff_header, proxy_token):
    """返回本次请求的判定结果字典。"""
    trusted, secret, rules = load_policy()
    result = {
        "peer": peer_ip,          # 实际 TCP 连接对端
        "via_trusted_proxy": False,
        "source": peer_ip,        # 最终采信的来源
        "rule": None,             # 命中的允许规则名
        "allowed": False,
        "note": "",
    }
    try:
        peer = ipaddress.ip_address(peer_ip)
    except ValueError:
        result["note"] = "无法解析连接地址"
        return result

    from_trusted_peer = any(peer in n for n in trusted)
    # 仅"来自可信网段"不够：本机直连与代理连接的对端地址相同，
    # 必须再校验代理凭证，才不会把本机直连误认成已配置的代理
    if from_trusted_peer and secret and proxy_token == secret:
        # 来自已配置的代理：采信代理写入的来源字段
        result["via_trusted_proxy"] = True
        token = (xff_header or "").split(",")[0].strip()
        try:
            source = ipaddress.ip_address(token)
            result["source"] = token
        except ValueError:
            result["source"] = token or "(缺失)"
            result["note"] = "可信代理未提供有效的 X-Forwarded-For"
            return result
    else:
        # 直连：只认实际连接地址，忽略客户端自带的来源字段
        source = peer
        if xff_header:
            result["note"] = "直连请求：忽略客户端自带的 X-Forwarded-For"
        if from_trusted_peer and proxy_token != secret:
            result["note"] = (result["note"] + "；" if result["note"] else "") \
                + "缺少有效代理凭证，按直连处理"

    for rule in rules:
        net = rule["network"]
        if source.version == net.version and source in net:
            result["rule"] = rule["name"]
            result["allowed"] = True
            break
    if not result["allowed"] and not result["note"]:
        result["note"] = "未命中任何允许规则"
    return result


def render_admin(decision):
    rows = []
    with log_lock:
        entries = list(access_log)
    for e in entries:
        rows.append(
            "<tr>"
            f"<td>{html.escape(e['time'])}</td>"
            f"<td>{html.escape(e['peer'])}</td>"
            f"<td>{'是' if e['via_trusted_proxy'] else '否'}</td>"
            f"<td>{html.escape(e['source'])}</td>"
            f"<td>{html.escape(e['rule'] or '-')}</td>"
            f"<td>{'允许' if e['allowed'] else '拒绝'}</td>"
            f"<td>{html.escape(e['note'])}</td>"
            "</tr>"
        )
    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>管理后台</title></head>
<body>
<h1>管理后台</h1>
<p>本次请求：采信来源 <b>{html.escape(decision['source'])}</b>，
命中规则 <b>{html.escape(decision['rule'] or '-')}</b>。</p>
<h2>管理员访问日志</h2>
<table border="1" cellspacing="0" cellpadding="4">
<tr><th>时间</th><th>连接对端</th><th>经可信代理</th><th>采信来源</th>
<th>命中规则</th><th>结果</th><th>备注</th></tr>
{''.join(rows)}
</table>
</body></html>"""


def render_denied(decision):
    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>403</title></head>
<body>
<h1>403 拒绝访问</h1>
<p>管理后台只允许从机构批准的网络进入。</p>
<ul>
<li>连接对端：{html.escape(decision['peer'])}</li>
<li>是否经可信代理：{'是' if decision['via_trusted_proxy'] else '否'}</li>
<li>采信来源：{html.escape(decision['source'])}</li>
<li>说明：{html.escape(decision['note'])}</li>
</ul>
</body></html>"""


class AdminHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        decision = decide(
            self.client_address[0],
            self.headers.get("X-Forwarded-For"),
            self.headers.get("X-Proxy-Token"),
        )
        with log_lock:
            access_log.appendleft(
                {"time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), **decision}
            )
        if decision["allowed"]:
            self._send(200, render_admin(decision), decision)
        else:
            self._send(403, render_denied(decision), decision)

    def _send(self, status, page, decision):
        body = page.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        # 便于演示程序读取判定结果
        self.send_header("X-Access-Decision", "allow" if decision["allowed"] else "deny")
        self.send_header("X-Access-Source", decision["source"])
        self.send_header("X-Access-Rule", decision["rule"] or "-")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(LISTEN_ADDR, AdminHandler)
    print(f"业务服务（管理后台）监听 http://{LISTEN_ADDR[0]}:{LISTEN_ADDR[1]}/admin")
    server.serve_forever()
