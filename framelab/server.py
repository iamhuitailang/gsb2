"""本地 HTTP 服务：标准库 http.server，无第三方框架。

仅绑定 127.0.0.1；所有文件路径经 _safe_join 限制在允许的根目录内。
"""

from __future__ import annotations

import json
import mimetypes
import os
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .core import pipeline
from .core.ffmpeg_tools import FFmpegError
from .core.project_store import (
    ProjectError,
    list_projects,
    load_project,
    new_project,
    project_dir,
    save_project,
)


class AppState:
    def __init__(self, workspace: str, web_root: str, samples_dir: str | None):
        self.workspace = os.path.abspath(workspace)
        self.web_root = os.path.abspath(web_root)
        self.samples_dir = os.path.abspath(samples_dir) if samples_dir else None
        os.makedirs(self.workspace, exist_ok=True)


def _safe_join(root: str, *parts: str) -> str:
    root = os.path.abspath(root)
    target = os.path.abspath(os.path.join(root, *parts))
    if target != root and not target.startswith(root + os.sep):
        raise PermissionError(f"路径越界: {target}")
    return target


class Handler(BaseHTTPRequestHandler):
    server_version = "FrameLab/1.0"
    state: AppState = None  # type: ignore[assignment]

    # ---------- 基础工具 ----------
    def _json(self, obj: Any, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, msg: str, status: int = 400) -> None:
        self._json({"ok": False, "error": msg}, status)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def _file(self, path: str, download_name: str | None = None) -> None:
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Connection", "close")
        if download_name:
            self.send_header(
                "Content-Disposition",
                f"attachment; filename*=UTF-8''{urllib.parse.quote(download_name)}",
            )
        self.end_headers()
        with open(path, "rb") as f:
            while chunk := f.read(64 * 1024):
                self.wfile.write(chunk)
                self.wfile.flush()

    def log_message(self, fmt: str, *args) -> None:  # 安静一点
        pass

    # ---------- 路由 ----------
    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)
        try:
            if route == "/api/health":
                return self._json({"ok": True})
            if route == "/api/projects":
                return self._json({"ok": True, "projects": list_projects(self.state.workspace)})
            if route == "/api/samples":
                return self._handle_samples()
            if route == "/api/frame":
                return self._handle_frame(qs)
            if route == "/api/download":
                return self._handle_download(qs)
            if route == "/api/raw-media":
                return self._handle_raw_media(qs)
            return self._serve_static(route)
        except (PermissionError, FileNotFoundError, ProjectError, FFmpegError, RuntimeError) as e:
            return self._error(str(e), 404 if isinstance(e, FileNotFoundError) else 400)

    def do_POST(self) -> None:
        route = urllib.parse.urlparse(self.path).path
        try:
            if route == "/api/projects":
                return self._handle_create()
            if route == "/api/analyze":
                return self._handle_analyze()
            if route == "/api/mapping":
                return self._handle_mapping()
            if route == "/api/settings":
                return self._handle_settings()
            if route == "/api/export/video":
                return self._handle_export_video()
            if route == "/api/preview":
                return self._handle_preview()
            if route == "/api/export/manifest":
                return self._handle_export_manifest()
            return self._error("未知接口", 404)
        except (PermissionError, ProjectError, FFmpegError, RuntimeError, ValueError) as e:
            return self._error(str(e), 400)

    # ---------- 业务处理 ----------
    def _load(self, pid: str) -> dict:
        if not pid or "/" in pid or ".." in pid:
            raise ProjectError("非法项目 id")
        return load_project(self.state.workspace, pid)

    def _handle_create(self) -> None:
        body = self._body()
        path = body.get("path", "")
        if not path:
            return self._error("缺少 path")
        path = os.path.abspath(os.path.expanduser(path))
        if not os.path.isfile(path):
            return self._error(f"素材不存在: {path}", 404)
        project = new_project(path)
        save_project(self.state.workspace, project)
        self._json({"ok": True, "project": _project_summary(project)})

    def _handle_analyze(self) -> None:
        body = self._body()
        project = self._load(body.get("id", ""))
        try:
            info = pipeline.analyze_source(project)
        finally:
            # 无论成功失败都落盘：失败时保留已完成部分与错误信息
            save_project(self.state.workspace, project)
        self._json({"ok": True, "probe": info, "project": _project_summary(project)})

    def _handle_settings(self) -> None:
        body = self._body()
        project = self._load(body.get("id", ""))
        s = project["settings"]
        allowed = {"dst_fps": float, "speed": float, "method": str,
                   "keep_pitch": bool, "video_codec": str, "crf": int, "preset": str}
        for key, cast in allowed.items():
            if key in body:
                value = body[key]
                if key == "method" and value not in ("nearest", "blend"):
                    return self._error("method 只能是 nearest 或 blend")
                s[key] = cast(value)
        if s["dst_fps"] <= 0 or s["speed"] <= 0:
            return self._error("帧率与速度必须为正数")
        save_project(self.state.workspace, project)
        mapping = pipeline.compute_mapping(project)
        save_project(self.state.workspace, project)
        self._json({"ok": True, "settings": s,
                    "stats": mapping["stats"], "project": _project_summary(project)})

    def _handle_mapping(self) -> None:
        body = self._body()
        project = self._load(body.get("id", ""))
        mapping = pipeline.compute_mapping(project)
        save_project(self.state.workspace, project)
        offset = max(0, int(body.get("offset", 0)))
        limit = min(int(body.get("limit", 200)), 2000)
        kind_filter = body.get("kind")  # exact/duplicate/drop/blend 或 None
        rows = mapping["rows"]
        if kind_filter:
            rows = [r for r in rows if r["kind"] == kind_filter]
        page = rows[offset:offset + limit]
        self._json({
            "ok": True,
            "stats": mapping["stats"],
            "rows": page,
            "total": len(rows),
            "offset": offset,
            "limit": limit,
            "src_to_out": mapping.get("src_to_out", {}),
        })

    def _handle_frame(self, qs: dict) -> None:
        pid = qs.get("id", [""])[0]
        project = self._load(pid)
        src_index = int(qs.get("src", ["0"])[0])
        rel = pipeline.frame_preview(self.state.workspace, project, src_index)
        full = _safe_join(project_dir(self.state.workspace, pid), "frames", rel)
        self._file(full)

    def _handle_preview(self) -> None:
        body = self._body()
        project = self._load(body.get("id", ""))
        seconds = float(body.get("seconds", 2.0))
        path = pipeline.make_preview(self.state.workspace, project, seconds)
        self._json({"ok": True, "path": path})

    def _handle_export_manifest(self) -> None:
        body = self._body()
        project = self._load(body.get("id", ""))
        mapping = pipeline.compute_mapping(project)
        csv_path, json_path = pipeline.export_manifest(self.state.workspace, project, mapping)
        save_project(self.state.workspace, project)
        chosen = json_path if body.get("format") == "json" else csv_path
        self._json({
            "ok": True,
            "download": f"/api/download?id={project['id']}&kind=export&name={os.path.basename(chosen)}",
            "csv": os.path.basename(csv_path),
            "json": os.path.basename(json_path),
        })

    def _handle_export_video(self) -> None:
        body = self._body()
        project = self._load(body.get("id", ""))
        record = pipeline.export_video(self.state.workspace, project)
        self._json({
            "ok": True,
            "record": record,
            "download": f"/api/download?id={project['id']}&kind=export&name={record['output']}",
        })

    def _handle_download(self, qs: dict) -> None:
        pid = qs.get("id", [""])[0]
        kind = qs.get("kind", ["export"])[0]
        name = qs.get("name", [""])[0]
        sub = "export" if kind == "export" else "frames"
        full = _safe_join(project_dir(self.state.workspace, pid), sub, name)
        if not os.path.isfile(full):
            raise FileNotFoundError(name)
        if qs.get("probe", ["0"])[0] == "1":
            return self._json({"ok": True, "path": full})
        self._file(full, download_name=name)

    def _handle_raw_media(self, qs: dict) -> None:
        """提供源视频/样片/导出视频的播放流（仅限白名单根目录或常见媒体后缀）。"""
        raw = qs.get("path", [""])[0]
        full = os.path.abspath(urllib.parse.unquote(raw))
        ws_root = os.path.abspath(self.state.workspace)
        allowed_roots = [ws_root]
        if self.state.samples_dir:
            allowed_roots.append(self.state.samples_dir)
        in_allowed = any(
            full == root or full.startswith(root + os.sep) for root in allowed_roots
        )
        if not in_allowed:
            # 项目外的源素材：要求文件存在且为常见媒体后缀（本地单机工具，用户自选文件）
            if not os.path.isfile(full) or not full.lower().endswith(
                    (".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".mpg", ".mpeg")):
                raise PermissionError("不允许的媒体路径")
        if not os.path.isfile(full):
            raise FileNotFoundError(full)
        self._file(full)

    def _handle_samples(self) -> None:
        d = self.state.samples_dir
        if not d or not os.path.isdir(d):
            return self._json({"ok": True, "samples": []})
        items = []
        for name in sorted(os.listdir(d)):
            if name.lower().endswith((".mp4", ".mov", ".mkv", ".webm")):
                items.append({
                    "name": name,
                    "path": os.path.join(d, name),
                    "size": os.path.getsize(os.path.join(d, name)),
                })
        self._json({"ok": True, "samples": items})

    def _serve_static(self, route: str) -> None:
        if route == "/":
            route = "/index.html"
        full = _safe_join(self.state.web_root, route.lstrip("/"))
        if not os.path.isfile(full):
            self.send_error(404)
            return
        self._file(full)


def _project_summary(project: dict) -> dict:
    return {
        "id": project["id"],
        "source": project["source"]["path"],
        "analyzed": project["source"]["analyzed"],
        "analyze_error": project["source"].get("analyze_error"),
        "settings": project["settings"],
        "exports": project.get("exports", [])[-5:],
        "probe": project["source"].get("probe"),
    }


def create_server(host: str, port: int, workspace: str,
                  web_root: str, samples_dir: str | None) -> ThreadingHTTPServer:
    state = AppState(workspace, web_root, samples_dir)
    Handler.state = state
    httpd = ThreadingHTTPServer((host, port), Handler)
    return httpd
