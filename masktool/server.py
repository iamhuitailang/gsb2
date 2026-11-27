"""Local-only HTTP server: static editor, uploads, demo generation and export."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import platform
import subprocess
import threading
import traceback
import uuid
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from .demo import demo_project, generate_demo
from .media import export_project, probe_video

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "masktool" / "web"
WORKSPACE = Path(os.environ.get("MASK_TOOL_HOME", ROOT / "workspace")).expanduser().resolve()
ASSETS_DIR = WORKSPACE / "assets"
EXPORTS_DIR = WORKSPACE / "exports"
ASSETS_DIR.mkdir(parents=True, exist_ok=True)
EXPORTS_DIR.mkdir(parents=True, exist_ok=True)

JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()

mimetypes.add_type("text/javascript; charset=utf-8", ".js")
mimetypes.add_type("text/css; charset=utf-8", ".css")
mimetypes.add_type("image/png", ".png")
mimetypes.add_type("video/mp4", ".mp4")
mimetypes.add_type("audio/mp4", ".m4a")


def json_default(data: Any) -> Any:
    if isinstance(data, Path):
        return str(data)
    raise TypeError(f"Object of type {type(data)} is not JSON serializable")


class Handler(SimpleHTTPRequestHandler):
    server_version = "NumberMaskWorkbench/1.0"
    protocol_version = "HTTP/1.1"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep the terminal useful but quiet for normal static requests.
        if "/api/" in (self.path or ""):
            print(f"[server] {self.address_string()} - {fmt % args}")

    # ---------- helpers ----------
    def send_json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2, default=json_default).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("请求体必须是 JSON 对象")
        return data

    def safe_workspace_path(self, relative: str) -> Path | None:
        candidate = (WORKSPACE / relative).resolve()
        if candidate == WORKSPACE or WORKSPACE not in candidate.parents:
            return None
        return candidate

    def serve_workspace_file(self, target: Path) -> None:
        """Serve media with single-range support for smooth scrubbing."""
        if not target.is_file():
            self.send_error(404)
            return

        file_size = target.stat().st_size
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        range_header = self.headers.get("Range")
        start = 0
        end = file_size - 1
        partial = False

        if range_header and range_header.startswith("bytes="):
            spec = range_header.strip()[6:].split(",", 1)[0]
            start_text, _, end_text = spec.partition("-")
            try:
                if start_text == "":
                    suffix = int(end_text)
                    start = max(0, file_size - suffix)
                else:
                    start = int(start_text)
                    if end_text:
                        end = int(end_text)
            except ValueError:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{file_size}")
                self.end_headers()
                return

            end = min(end, file_size - 1)
            if start < 0 or start >= file_size or end < start:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{file_size}")
                self.end_headers()
                return
            partial = True

        length = end - start + 1
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.end_headers()

        if self.command == "HEAD":
            return

        try:
            with target.open("rb") as handle:
                handle.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = handle.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            return

    # ---------- GET / HEAD ----------
    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            from .media import ffmpeg_bin

            try:
                ffmpeg = ffmpeg_bin()
            except Exception:
                ffmpeg = None
            self.send_json({"ok": True, "ffmpeg": ffmpeg, "workspace": str(WORKSPACE)})
            return

        if path.startswith("/api/jobs/"):
            job_id = path.rsplit("/", 1)[-1]
            with JOBS_LOCK:
                job = JOBS.get(job_id)
            if not job:
                self.send_json({"error": "任务不存在"}, 404)
            else:
                self.send_json(job)
            return

        if path.startswith("/files/"):
            relative = unquote(path[len("/files/") :])
            target = self.safe_workspace_path(relative)
            if target is None:
                self.send_error(403)
                return
            self.serve_workspace_file(target)
            return

        if path in {"/", "/index.html"}:
            self.directory = str(WEB_DIR)
            self.path = "/index.html"
            super().do_GET()
            return

        # Static files from web/.
        self.directory = str(WEB_DIR)
        super().do_GET()

    def do_HEAD(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path.startswith("/files/"):
            relative = unquote(parsed.path[len("/files/") :])
            target = self.safe_workspace_path(relative)
            if target is None:
                self.send_error(403)
                return
            self.serve_workspace_file(target)
            return
        self.directory = str(WEB_DIR)
        super().do_HEAD()

    # ---------- POST ----------
    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/demo":
                self.handle_demo()
                return
            if path == "/api/assets":
                self.handle_upload(parsed.query)
                return
            if path == "/api/export":
                self.handle_export()
                return
            if path.startswith("/api/jobs/") and path.endswith("/reveal"):
                job_id = path.split("/")[3]
                self.handle_reveal(job_id)
                return
            self.send_json({"error": f"未知接口：{path}"}, 404)
        except Exception as exc:  # noqa: BLE001 - local API boundary
            traceback.print_exc()
            self.send_json({"error": str(exc)}, 500)

    def handle_demo(self) -> None:
        asset_dir = ASSETS_DIR / "demo"
        source = generate_demo(asset_dir)
        info = probe_video(source)
        project = demo_project("demo")
        project["video"].update(
            {
                "width": info["width"],
                "height": info["height"],
                "duration": info["duration"],
                "fps": round(info["fps"], 3),
            }
        )
        self.send_json(
            {
                "asset": {
                    "assetId": "demo",
                    "name": source.name,
                    "url": "/files/assets/demo/source.mp4",
                    **info,
                },
                "project": project,
            }
        )

    def handle_upload(self, query: str) -> None:
        params = parse_qs(query)
        raw_name = (params.get("name") or ["video"])[0]
        safe_name = Path(raw_name).name.replace("\x00", "")
        suffix = Path(safe_name).suffix.lower()
        allowed_suffixes = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".ts", ".m2ts", ".wmv", ".flv"}
        if suffix not in allowed_suffixes:
            suffix = ".mp4"
        asset_id = "asset_" + uuid.uuid4().hex[:12]
        asset_dir = ASSETS_DIR / asset_id
        asset_dir.mkdir(parents=True, exist_ok=True)
        target = asset_dir / f"source{suffix}"

        length = int(self.headers.get("Content-Length", "0"))
        remaining = length
        with target.open("wb") as out:
            while remaining > 0:
                chunk = self.rfile.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                out.write(chunk)
                remaining -= len(chunk)
        if target.stat().st_size == 0:
            raise ValueError("没有收到视频文件")

        info = probe_video(target)
        (asset_dir / "asset.json").write_text(
            json.dumps({"originalName": safe_name, **info}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        self.send_json(
            {
                "assetId": asset_id,
                "name": safe_name,
                "url": f"/files/assets/{asset_id}/{target.name}",
                **info,
            }
        )

    def resolve_asset(self, asset_id: str) -> Path | None:
        if not asset_id or "/" in asset_id or ".." in asset_id:
            return None
        asset_dir = ASSETS_DIR / asset_id
        if not asset_dir.exists():
            return None
        candidates = sorted(asset_dir.glob("source.*"))
        candidates = [p for p in candidates if p.suffix.lower() not in {".json", ".txt"}]
        return candidates[0] if candidates else None

    def handle_export(self) -> None:
        project = self.read_json()
        asset_id = str(project.get("assetId") or (project.get("video") or {}).get("assetId") or "")
        source = self.resolve_asset(asset_id)
        if source is None:
            self.send_json(
                {"error": "找不到本机原始视频素材。请重新选择视频后再导出；配置文件本身不含视频。"},
                400,
            )
            return

        job_id = "export_" + uuid.uuid4().hex[:12]
        out_dir = EXPORTS_DIR / job_id
        out_dir.mkdir(parents=True, exist_ok=True)
        with JOBS_LOCK:
            JOBS[job_id] = {
                "id": job_id,
                "status": "queued",
                "progress": 0,
                "stage": "queued",
                "message": "排队中",
                "outputDir": str(out_dir),
            }

        def update(progress: float, stage: str, message: str) -> None:
            with JOBS_LOCK:
                JOBS[job_id].update(
                    {"status": "running", "progress": progress, "stage": stage, "message": message}
                )

        def worker() -> None:
            try:
                result = export_project(project, source, out_dir, update)
                with JOBS_LOCK:
                    JOBS[job_id].update(
                        {
                            "status": "done",
                            "progress": 1,
                            "stage": "done",
                            "message": "导出完成",
                            "result": result,
                            "resultUrls": {
                                "video": f"/files/exports/{job_id}/{result['video']}",
                                "config": f"/files/exports/{job_id}/{result['config']}",
                                "audio": (
                                    f"/files/exports/{job_id}/{result['audio']}"
                                    if result.get("audio")
                                    else None
                                ),
                                "manifest": f"/files/exports/{job_id}/{result['verificationManifest']}",
                                "directory": str(out_dir),
                            },
                        }
                    )
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                with JOBS_LOCK:
                    JOBS[job_id].update({"status": "error", "message": str(exc), "error": str(exc)})

        threading.Thread(target=worker, daemon=True).start()
        self.send_json({"jobId": job_id})

    def handle_reveal(self, job_id: str) -> None:
        with JOBS_LOCK:
            job = JOBS.get(job_id)
        if not job:
            self.send_json({"error": "任务不存在"}, 404)
            return
        path = Path(job["outputDir"]) / "masked.mp4"
        target = str(path if path.exists() else job["outputDir"])
        try:
            system = platform.system()
            if system == "Darwin":
                subprocess.Popen(["open", "-R", target])
            elif system == "Windows":
                os.startfile(str(Path(target).parent))  # type: ignore[attr-defined]
            else:
                subprocess.Popen(["xdg-open", str(Path(target).parent)])
        except Exception as exc:  # noqa: BLE001
            self.send_json({"ok": False, "error": str(exc)}, 200)
            return
        self.send_json({"ok": True})


def main() -> None:
    parser = argparse.ArgumentParser(description="本机号码牌遮盖工作台")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("MASK_TOOL_PORT", "8765")))
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    httpd: ThreadingHTTPServer | None = None
    actual_port = args.port
    for port in [args.port, args.port + 1, args.port + 2, 0]:
        try:
            httpd = ThreadingHTTPServer((args.host, port), Handler)
            actual_port = httpd.server_address[1]
            break
        except OSError:
            continue
    if httpd is None:
        raise SystemExit("无法启动本地服务端口")

    url = f"http://{args.host}:{actual_port}/"
    print("=" * 64)
    print("号码牌遮盖工作台已启动")
    print(f"  地址：{url}")
    print(f"  工作目录：{WORKSPACE}")
    print("  按 Ctrl+C 停止")
    print("=" * 64)
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
