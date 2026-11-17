#!/usr/bin/env python3
"""本地反向代理，监听 127.0.0.1:18080，转发到业务服务 127.0.0.1:18081。

职责：
- 丢弃客户端自己附带的来源信息（X-Forwarded-For 等），
  由代理根据实际客户端地址重新写入，客户端无法伪造；
- 附上与业务服务约定的代理凭证（policy.json 中的 proxy_secret），
  业务服务据此识别连接确实来自已配置的代理，而非本机直连；
- 演示模式：本机回环上无法模拟不同来源 IP，因此允许用
  X-Demo-Client-IP 指定模拟的客户端地址（生产环境应删除该逻辑，
  直接使用 TCP 对端地址 self.client_address[0]）。
"""
import http.client
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LISTEN_ADDR = ("127.0.0.1", 18080)
BACKEND = ("127.0.0.1", 18081)
POLICY_PATH = Path(__file__).with_name("policy.json")

HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
}
# 客户端自带、必须由代理覆盖/丢弃的字段
STRIP_HEADERS = HOP_BY_HOP | {
    "x-forwarded-for", "x-real-ip", "x-proxy-token", "x-demo-client-ip",
}


def load_proxy_secret():
    with open(POLICY_PATH, encoding="utf-8") as f:
        return json.load(f).get("proxy_secret", "")


class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _client_ip(self):
        # 演示模式：优先使用模拟地址；生产环境直接用 TCP 对端地址
        demo = self.headers.get("X-Demo-Client-IP")
        return demo.strip() if demo else self.client_address[0]

    def _forward(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        out_headers = {}
        for key, value in self.headers.items():
            if key.lower() in STRIP_HEADERS:
                continue  # 覆盖客户端自己附带的来源信息
            out_headers[key] = value
        out_headers["X-Forwarded-For"] = self._client_ip()
        out_headers["X-Proxy-Token"] = load_proxy_secret()  # 代理凭证

        conn = http.client.HTTPConnection(*BACKEND, timeout=10)
        conn.request(self.command, self.path, body=body, headers=out_headers)
        resp = conn.getresponse()
        data = resp.read()

        self.send_response(resp.status)
        for key, value in resp.getheaders():
            if key.lower() in HOP_BY_HOP or key.lower() == "content-length":
                continue
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        conn.close()

    do_GET = _forward
    do_POST = _forward

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(LISTEN_ADDR, ProxyHandler)
    print(f"反向代理监听 http://{LISTEN_ADDR[0]}:{LISTEN_ADDR[1]} ，转发到 {BACKEND[0]}:{BACKEND[1]}")
    server.serve_forever()
