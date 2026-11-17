#!/usr/bin/env python3
"""业务服务（管理后台），演示来源检查。

来源判定规则：
- 仅当连接对端属于 policy.json 的 trusted_proxies，且携带正确的
  X-Proxy-Token 时，才认定该连接来自已配置的代理，采信它写入的
  X-Forwarded-For（取最右一个，即代理自己覆盖写入的值）；
- 其余连接（包括本机直连）一律使用实际连接地址，客户端自己附带
  的来源字段直接忽略——不会因为都来自本机就信任来源字段。

策略文件每次请求重新读取：修改策略后下一次请求即按新配置判断。
"""
import html
import json
import os
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from ipaddress import ip_address, ip_network

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
POLICY_PATH = os.environ.get("POLICY_PATH", os.path.join(BASE_DIR, "policy.json"))
LISTEN_HOST = os.environ.get("BACKEND_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("BACKEND_PORT", "18000"))
LOG_CAPACITY = 500

_lock = threading.Lock()
_logs = []  # 管理员日志（内存环形缓冲）


def load_policy():
    """每次请求都重新读取策略文件，保证修改即时生效。"""
    with open(POLICY_PATH, encoding="utf-8") as f:
        raw = json.load(f)
    return {
        "trusted_proxies": [ip_network(n) for n in raw.get("trusted_proxies", [])],
        "proxy_token": raw.get("proxy_token") or None,
        "allow_ranges": [(r, ip_network(r)) for r in raw.get("allow_ranges", [])],
        "raw": raw,
    }


def decide(handler):
    """判定本次请求是否允许访问，并记录管理员日志。返回 (allowed, entry)。"""
    policy = load_policy()
    peer = handler.client_address[0]
    xff = handler.headers.get("X-Forwarded-For")
    token = handler.headers.get("X-Proxy-Token")

    peer_ip = ip_address(peer)
    peer_is_proxy = any(peer_ip in n for n in policy["trusted_proxies"])
    token_ok = policy["proxy_token"] is None or token == policy["proxy_token"]
    from_configured_proxy = peer_is_proxy and token_ok

    if from_configured_proxy and xff:
        # 已配置的代理会覆盖客户端自带的来源字段，采信它写入的值
        adopted = xff.split(",")[-1].strip()
        via = "trusted-proxy"
    else:
        # 直连（或代理身份校验失败）：只信实际连接地址
        adopted = peer
        via = "direct"

    matched = None
    try:
        adopted_ip = ip_address(adopted)
    except ValueError:
        adopted_ip = None
    if adopted_ip is not None:
        for raw, net in policy["allow_ranges"]:
            if adopted_ip.version == net.version and adopted_ip in net:
                matched = raw
                break

    entry = {
        "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "path": handler.path,
        "peer": peer,
        "xff_header": xff or "-",
        "token_ok": token_ok,
        "via": via,
        "adopted": adopted,
        "matched_rule": matched or "-",
        "allowed": matched is not None,
    }
    with _lock:
        _logs.append(entry)
        del _logs[:-LOG_CAPACITY]
    return entry["allowed"], entry


class Handler(BaseHTTPRequestHandler):
    server_version = "AdminBackend/1.0"

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            self._admin_home()
        elif path == "/admin/logs":
            self._logs_page()
        else:
            self.send_error(404, "Not Found")

    def _admin_home(self):
        allowed, entry = decide(self)
        if allowed:
            body = (
                "管理后台\n\n"
                f"欢迎。采信来源 {entry['adopted']}，命中规则 "
                f"{entry['matched_rule']}（连接方式: {entry['via']}）。\n"
                "管理员日志: /admin/logs\n"
            ).encode()
            status = 200
        else:
            body = (
                "403 Forbidden\n\n"
                f"采信来源 {entry['adopted']} 不在允许范围内"
                f"（连接方式: {entry['via']}）。\n"
            ).encode()
            status = 403
        self._reply(status, body, "text/plain; charset=utf-8")

    def _logs_page(self):
        # 演示程序：日志页本身不做来源限制，方便从任何来源观察判定结果
        policy = load_policy()
        with _lock:
            rows = list(reversed(_logs))
        esc = html.escape
        trs = "".join(
            "<tr>"
            f"<td>{esc(e['time'])}</td><td>{esc(e['path'])}</td>"
            f"<td>{esc(e['peer'])}</td><td>{esc(e['xff_header'])}</td>"
            f"<td>{'✓' if e['token_ok'] else '✗'}</td>"
            f"<td>{esc(e['via'])}</td><td><b>{esc(e['adopted'])}</b></td>"
            f"<td>{esc(e['matched_rule'])}</td>"
            f"<td>{'允许' if e['allowed'] else '拒绝'}</td>"
            "</tr>"
            for e in rows
        )
        page = f"""<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="3">
<title>管理员日志</title>
<style>
body {{ font-family: -apple-system, monospace; margin: 2em; }}
table {{ border-collapse: collapse; }}
td, th {{ border: 1px solid #ccc; padding: 4px 10px; font-size: 13px; }}
</style></head><body>
<h1>管理员日志</h1>
<h2>当前策略（每次请求实时读取 {esc(os.path.basename(POLICY_PATH))}）</h2>
<ul>
<li>可信代理: {esc(', '.join(policy['raw'].get('trusted_proxies', [])))}
    （且须携带正确的 X-Proxy-Token）</li>
<li>允许范围: {esc(', '.join(policy['raw'].get('allow_ranges', []))) or '（空，全部拒绝）'}</li>
</ul>
<h2>访问判定记录</h2>
<table><tr><th>时间</th><th>路径</th><th>连接对端</th><th>收到的 XFF</th>
<th>令牌</th><th>采信方式</th><th>采信来源</th><th>命中规则</th><th>结果</th></tr>
{trs or '<tr><td colspan="9">暂无记录</td></tr>'}
</table></body></html>"""
        self._reply(200, page.encode(), "text/html; charset=utf-8")

    def _reply(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def main():
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    print(f"业务服务监听 http://{LISTEN_HOST}:{LISTEN_PORT}，策略文件 {POLICY_PATH}")
    server.serve_forever()


if __name__ == "__main__":
    main()
