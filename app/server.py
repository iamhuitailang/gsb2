"""停车记录配对处理台 —— HTTP 服务。

仅依赖标准库。静态页面在 static/，数据接口统一挂在 /api/ 下，
导入接口接收 {"filename": ..., "content": ...}（前端读取 CSV 文本后提交），
避免 multipart 依赖。
"""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .importer import CsvFormatError, parse_csv
from .storage import Storage

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
}


def create_handler(storage: Storage):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ParkingDesk/1.0"

        def log_message(self, fmt, *args):  # 安静一点
            pass

        # ------------------------------ 基础工具 ------------------------------ #
        def _send_json(self, payload, status: int = 200):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_error(self, message: str, status: int = 400):
            self._send_json({"error": message}, status)

        def _read_json(self) -> dict:
            length = int(self.headers.get("Content-Length", 0))
            if not length:
                return {}
            return json.loads(self.rfile.read(length).decode("utf-8"))

        def _filters(self) -> dict:
            query = parse_qs(urlparse(self.path).query)
            return {
                "lot": (query.get("lot") or [None])[0],
                "plate": (query.get("plate") or [None])[0],
            }

        # ------------------------------ GET ------------------------------ #
        def do_GET(self):
            parsed = urlparse(self.path)
            path = parsed.path

            if path.startswith("/api/"):
                return self._handle_api_get(path)

            # 静态资源
            if path == "/":
                path = "/index.html"
            safe = os.path.normpath(path).lstrip("/")
            full = os.path.join(STATIC_DIR, safe)
            if not os.path.isfile(full) or not full.startswith(STATIC_DIR):
                self.send_error(404)
                return
            ext = os.path.splitext(full)[1]
            self.send_response(200)
            self.send_header(
                "Content-Type", CONTENT_TYPES.get(ext, "application/octet-stream")
            )
            with open(full, "rb") as f:
                body = f.read()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _handle_api_get(self, path: str):
            f = self._filters()
            try:
                if path == "/api/pairs":
                    return self._send_json(storage.list_pairs(**f))
                if path == "/api/unpaired":
                    return self._send_json(storage.list_unpaired(**f))
                if path == "/api/events":
                    return self._send_json(storage.list_events(**f))
                if path == "/api/stats":
                    return self._send_json(storage.daily_stats())
                if path == "/api/batches":
                    return self._send_json(storage.list_batches())
                if path == "/api/lots":
                    lots = sorted(
                        {r["lot"] for r in storage.list_events()}
                    )
                    return self._send_json(lots)
                if path.startswith("/api/events/"):
                    event_id = int(path.rsplit("/", 1)[-1])
                    return self._send_json(storage.get_event(event_id))
            except KeyError as exc:
                return self._send_error(str(exc), 404)
            except ValueError as exc:
                return self._send_error(str(exc), 400)
            self._send_error("未知接口", 404)

        # ------------------------------ POST ------------------------------ #
        def do_POST(self):
            path = urlparse(self.path).path
            try:
                if path == "/api/import":
                    payload = self._read_json()
                    filename = payload.get("filename") or "未命名文件.csv"
                    content = payload.get("content", "")
                    rows = parse_csv(content)
                    result = storage.import_rows(filename, rows)
                    return self._send_json(
                        {
                            "filename": filename,
                            "total_rows": result.total_rows,
                            "inserted": result.inserted,
                            "duplicates": result.duplicates,
                        }
                    )
                if path.endswith("/correct"):
                    # /api/events/<id>/correct
                    parts = path.strip("/").split("/")
                    event_id = int(parts[2])
                    payload = self._read_json()
                    new_plate = payload.get("new_plate", "")
                    reason = payload.get("reason") or None
                    updated = storage.correct_plate(event_id, new_plate, reason)
                    return self._send_json(updated)
            except CsvFormatError as exc:
                return self._send_error(str(exc), 400)
            except KeyError as exc:
                return self._send_error(str(exc), 404)
            except (ValueError, json.JSONDecodeError) as exc:
                return self._send_error(str(exc), 400)
            self._send_error("未知接口", 404)

    return Handler


def serve(db_path: str, host: str = "127.0.0.1", port: int = 8000):
    storage = Storage(db_path)
    httpd = ThreadingHTTPServer((host, port), create_handler(storage))
    print(f"停车配对处理台已启动: http://{host}:{port}  (数据库: {db_path})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        storage.close()
