from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlparse

from .storage import Library

STATIC_DIR = Path(__file__).resolve().parent / "static"


def create_handler(library: Library):
    class CheckerHandler(BaseHTTPRequestHandler):
        server_version = "LocalSoundChecker/1.0"

        def log_message(self, fmt: str, *args: Any) -> None:
            if os.environ.get("SOUND_CHECKER_DEBUG"):
                super().log_message(fmt, *args)

        @property
        def library(self) -> Library:
            return library

        def _send_json(self, payload: Any, status: int = 200) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _send_error_json(self, status: int, message: str) -> None:
            self._send_json({"error": message}, status)

        def _local_host_allowed(self) -> bool:
            # Mitigate DNS-rebinding requests from arbitrary web pages.
            host_header = self.headers.get("Host", "")
            hostname = urlparse(f"http://{host_header}").hostname or ""
            return hostname in {"127.0.0.1", "localhost", "::1"}

        def _reject_if_remote_host(self) -> bool:
            if self._local_host_allowed():
                return False
            self._send_error_json(403, "只允许通过 localhost/127.0.0.1 访问")
            return True

        def _read_json(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            try:
                data = json.loads(raw.decode("utf-8") or "{}")
                return data if isinstance(data, dict) else {}
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                raise ValueError(f"请求 JSON 无效: {exc}") from exc

        def do_GET(self) -> None:  # noqa: N802
            if self._reject_if_remote_host():
                return
            parsed = urlparse(self.path)
            path = parsed.path
            query = parse_qs(parsed.query)
            try:
                if path == "/api/state":
                    self._send_json(self.library.public_state())
                elif path == "/api/analyze":
                    self._send_json(self.library.analyze())
                elif path == "/api/export":
                    self._handle_export(query)
                elif match := re.fullmatch(r"/api/files/([^/]+)/audio", path):
                    self._handle_audio(match.group(1))
                elif match := re.fullmatch(r"/api/files/([^/]+)/peaks", path):
                    self._send_json(self.library.get_peaks(match.group(1)))
                elif path == "/" or path == "/index.html":
                    self._serve_static("index.html")
                elif path.startswith("/static/"):
                    self._serve_static(path.removeprefix("/static/"))
                elif path == "/app.js":
                    self._serve_static("app.js")
                elif path == "/styles.css":
                    self._serve_static("styles.css")
                else:
                    self._send_error_json(404, "Not found")
            except KeyError:
                self._send_error_json(404, "文件不存在或已被彻底移除")
            except FileNotFoundError:
                self._send_error_json(404, "原始文件不存在")
            except Exception as exc:  # local tool: show actionable decoder/storage errors
                self._send_error_json(500, str(exc))

        def do_POST(self) -> None:  # noqa: N802
            if self._reject_if_remote_host():
                return
            parsed = urlparse(self.path)
            path = parsed.path
            query = parse_qs(parsed.query)
            try:
                if path == "/api/paths":
                    data = self._read_json()
                    raw_paths = data.get("paths") or []
                    if not isinstance(raw_paths, list):
                        raise ValueError("paths 必须是字符串数组")
                    self._send_json(self.library.add_paths([str(p) for p in raw_paths]))
                elif path == "/api/upload":
                    name = query.get("name", ["upload.wav"])[0]
                    length = int(self.headers.get("Content-Length", "0"))
                    if length <= 0:
                        raise ValueError("上传内容为空")
                    if length > 300 * 1024 * 1024:
                        raise ValueError("单个文件超过 300MB 限制")
                    content = self.rfile.read(length)
                    self._send_json(self.library.add_upload(name, content))
                elif path == "/api/samples":
                    self._send_json(self.library.add_generated_samples())
                elif path == "/api/analyze":
                    data = self._read_json()
                    params = data.get("params") if isinstance(data.get("params"), dict) else data
                    self._send_json(self.library.analyze(params))
                elif path == "/api/verdicts":
                    data = self._read_json()
                    key = str(data.get("key", ""))
                    if not key:
                        raise ValueError("缺少 verdict key")
                    result = self.library.set_verdict(key, data.get("status"), str(data.get("note", "")))
                    report = self.library.state.get("last_report")
                    if report:
                        for item in report.get("items", []):
                            if item.get("verdict_key") == key:
                                item["verdict"] = result["verdict"]
                    self.library.save()
                    self._send_json(result)
                elif match := re.fullmatch(r"/api/files/([^/]+)/restore", path):
                    ok = self.library.restore_file(match.group(1))
                    self._send_json({"ok": ok}, 200 if ok else 404)
                elif match := re.fullmatch(r"/api/files/([^/]+)/retry", path):
                    record = self.library.retry_file(match.group(1))
                    self._send_json(record or {"error": "not found"}, 200 if record else 404)
                else:
                    self._send_error_json(404, "Not found")
            except ValueError as exc:
                self._send_error_json(400, str(exc))
            except Exception as exc:
                self._send_error_json(500, str(exc))

        def do_DELETE(self) -> None:  # noqa: N802
            if self._reject_if_remote_host():
                return
            parsed = urlparse(self.path)
            if match := re.fullmatch(r"/api/files/([^/]+)", parsed.path):
                query = parse_qs(parsed.query)
                purge = query.get("purge", ["0"])[0] in {"1", "true", "yes"}
                ok = self.library.remove_file(match.group(1), purge=purge)
                self._send_json({"ok": ok}, 200 if ok else 404)
            else:
                self._send_error_json(404, "Not found")

        def _serve_static(self, relative: str) -> None:
            static_root = STATIC_DIR.resolve()
            file_path = (static_root / relative).resolve()
            if not file_path.is_relative_to(static_root) or not file_path.is_file():
                self._send_error_json(404, "静态资源不存在")
                return
            body = file_path.read_bytes()
            ctype = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", f"{ctype}; charset=utf-8" if ctype.startswith("text/") else ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _handle_export(self, query: dict[str, list[str]]) -> None:
            fmt = query.get("format", ["json"])[0].lower()
            if fmt == "csv":
                body = self.library.export_payload("csv").encode("utf-8-sig")  # Excel-friendly BOM
                self.send_response(200)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Content-Disposition", "attachment; filename=similarity-report.csv")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            body = self.library.export_payload("json")
            filename = "similarity-report.json"
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(filename)}")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _handle_audio(self, file_id: str) -> None:
            record = self.library.get_record(file_id, include_removed=True)
            if record is None:
                self._send_error_json(404, "文件不存在")
                return
            path = Path(record["path"])
            if not path.is_file():
                raise FileNotFoundError(str(path))
            size = path.stat().st_size
            suffix = path.suffix.lower()
            ctype = {
                ".wav": "audio/wav",
                ".wave": "audio/wav",
                ".mp3": "audio/mpeg",
                ".m4a": "audio/mp4",
                ".aac": "audio/aac",
                ".flac": "audio/flac",
                ".ogg": "audio/ogg",
                ".aiff": "audio/aiff",
                ".aif": "audio/aiff",
            }.get(suffix, mimetypes.guess_type(path.name)[0] or "application/octet-stream")

            range_header = self.headers.get("Range")
            if range_header and (m := re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())):
                start_s, end_s = m.groups()
                if not start_s and end_s:
                    suffix_length = int(end_s)
                    start = max(0, size - suffix_length)
                    end = size - 1
                else:
                    start = int(start_s) if start_s else 0
                    end = int(end_s) if end_s else size - 1
                end = min(end, size - 1)
                if start > end or start >= size:
                    self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.end_headers()
                    return
                length = end - start + 1
                self.send_response(206)
                self.send_header("Content-Type", ctype)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.send_header("Content-Length", str(length))
                self.end_headers()
                with path.open("rb") as f:
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = f.read(min(1024 * 1024, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
                return

            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(size))
            self.end_headers()
            with path.open("rb") as f:
                while chunk := f.read(1024 * 1024):
                    self.wfile.write(chunk)

    return CheckerHandler


def find_port(host: str, preferred: int) -> int:
    import socket

    for port in range(preferred, preferred + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind((host, port))
                return port
            except OSError:
                continue
    return 0


def serve(home: str | None = None, host: str = "127.0.0.1", port: int = 8765, open_browser: bool = False) -> None:
    library = Library(home)
    actual_port = find_port(host, port)
    if actual_port == 0:
        raise RuntimeError("8765-8784 端口均被占用，请用 --port 指定其他端口")
    httpd = ThreadingHTTPServer((host, actual_port), create_handler(library))
    url = f"http://{host}:{actual_port}/"
    print(f"本地相似片段检查器已启动: {url}")
    print(f"状态/索引目录: {library.home}")
    print("按 Ctrl+C 停止；不会修改原始音频文件。")
    if open_browser:
        import threading
        import webbrowser

        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="本地短音频相似片段检查器")
    parser.add_argument("--home", help="状态目录，默认 ~/.sound-similarity-checker")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", help="启动后打开浏览器")
    args = parser.parse_args()
    serve(args.home, args.host, args.port, args.open)


if __name__ == "__main__":
    main()
