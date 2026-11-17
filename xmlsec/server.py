"""本地 HTTP 服务：只监听 127.0.0.1，只提供静态页面与检查 API。

路由：
- GET  /                     检查台页面
- GET  /static/<file>        前端资源（web/ 目录）
- GET  /api/samples          样例列表
- GET  /api/samples/<name>   样例内容（仅限 samples/ 目录内）
- POST /api/inspect          提交 XML 文本，返回检查 JSON
"""

from __future__ import annotations

import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .inspector import LIMITS, inspect_xml

BASE_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = BASE_DIR / "web"
SAMPLES_DIR = BASE_DIR / "samples"

_SAMPLE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*\.xml$")
_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".xml": "text/xml; charset=utf-8",
    ".json": "application/json; charset=utf-8",
}
# JSON 包装等额外开销
_BODY_OVERHEAD = 64 * 1024


def _safe_join(base: Path, name: str) -> Path | None:
    """只允许读取 base 目录内的普通文件，拒绝路径穿越。"""
    candidate = (base / name).resolve()
    if not candidate.is_file() or base.resolve() not in candidate.parents:
        return None
    return candidate


class XmlSecHandler(BaseHTTPRequestHandler):
    server_version = "XmlSecBench/1.0"

    # --- 工具 ---
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path):
        ctype = _CONTENT_TYPES.get(path.suffix, "application/octet-stream")
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _not_found(self, message="not found"):
        self._send_json({"error": message}, status=404)

    def log_message(self, fmt, *args):  # 保持控制台安静，便于演示
        pass

    # --- GET ---
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            self._send_file(WEB_DIR / "index.html")
        elif path.startswith("/static/"):
            name = path[len("/static/"):]
            target = _safe_join(WEB_DIR, name)
            self._send_file(target) if target else self._not_found()
        elif path == "/api/samples":
            names = sorted(p.name for p in SAMPLES_DIR.glob("*.xml"))
            self._send_json({"samples": names})
        elif path.startswith("/api/samples/"):
            name = path[len("/api/samples/"):]
            if not _SAMPLE_NAME.match(name):
                self._not_found("invalid sample name")
                return
            target = _safe_join(SAMPLES_DIR, name)
            self._send_file(target) if target else self._not_found()
        else:
            self._not_found()

    # --- POST ---
    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path != "/api/inspect":
            self._not_found()
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > LIMITS["max_input_bytes"] + _BODY_OVERHEAD:
            self._send_json({"error": "request body too large or empty"}, status=413)
            return
        try:
            payload = json.loads(self.rfile.read(length))
            xml_text = payload["xml"]
            if not isinstance(xml_text, str):
                raise TypeError
        except (ValueError, TypeError, KeyError):
            self._send_json({"error": "invalid JSON body, expected {\"xml\": \"...\"}"}, status=400)
            return
        self._send_json(inspect_xml(xml_text))


def create_server(host="127.0.0.1", port=8321) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), XmlSecHandler)


def main():
    import argparse

    ap = argparse.ArgumentParser(description="本机 XML 安全检查台（不访问网络）")
    ap.add_argument("--host", default="127.0.0.1", help="监听地址，默认 127.0.0.1")
    ap.add_argument("--port", type=int, default=8321, help="监听端口，默认 8321")
    args = ap.parse_args()
    server = create_server(args.host, args.port)
    print(f"XML 安全检查台已启动: http://{args.host}:{args.port}/  (Ctrl+C 停止)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
