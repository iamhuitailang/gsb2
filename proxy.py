#!/usr/bin/env python3
"""本地反向代理。

转发时覆盖客户端自己附带的来源信息：丢弃入站的 X-Forwarded-* /
X-Proxy-Token，写入代理自己看到的连接对端地址，并附加与业务服务
约定的 X-Proxy-Token，供业务服务识别"这是已配置的代理"。
"""
import http.client
import json
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
POLICY_PATH = os.environ.get("POLICY_PATH", os.path.join(BASE_DIR, "policy.json"))
BACKEND_HOST = os.environ.get("BACKEND_HOST", "127.0.0.1")
BACKEND_PORT = int(os.environ.get("BACKEND_PORT", "18000"))
V4_PORT = int(os.environ.get("PROXY_V4_PORT", "18080"))
V6_PORT = int(os.environ.get("PROXY_V6_PORT", "18081"))

# 逐跳头部与所有客户端可伪造的来源字段，一律不向后转发
DROP_HEADERS = {"connection", "keep-alive", "transfer-encoding", "host",
                "x-proxy-token"}


def proxy_token():
    with open(POLICY_PATH, encoding="utf-8") as f:
        return json.load(f).get("proxy_token", "")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "DemoProxy/1.0"

    def do_GET(self):
        peer = self.client_address[0]
        headers = {
            k: v for k, v in self.headers.items()
            if k.lower() not in DROP_HEADERS
            and not k.lower().startswith("x-forwarded")
        }
        # 覆盖客户端自带的来源信息：只写代理实际看到的对端地址
        headers["X-Forwarded-For"] = peer
        headers["X-Proxy-Token"] = proxy_token()
        try:
            conn = http.client.HTTPConnection(BACKEND_HOST, BACKEND_PORT, timeout=10)
            conn.request("GET", self.path, headers=headers)
            resp = conn.getresponse()
            body = resp.read()
            status = resp.status
            content_type = resp.getheader("Content-Type")
            conn.close()
        except OSError as e:
            body = f"502 Bad Gateway: {e}\n".encode()
            status, content_type = 502, "text/plain; charset=utf-8"
        self.send_response(status)
        if content_type:
            self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class V6Server(ThreadingHTTPServer):
    address_family = socket.AF_INET6


def main():
    servers = [ThreadingHTTPServer(("0.0.0.0", V4_PORT), Handler)]
    print(f"代理 IPv4 监听 0.0.0.0:{V4_PORT}")
    try:
        servers.append(V6Server(("::", V6_PORT), Handler))
        print(f"代理 IPv6 监听 :::{V6_PORT}")
    except OSError as e:
        print(f"IPv6 监听不可用，跳过: {e}")
    for s in servers:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print(f"转发目标 {BACKEND_HOST}:{BACKEND_PORT}")
    threading.Event().wait()


if __name__ == "__main__":
    main()
