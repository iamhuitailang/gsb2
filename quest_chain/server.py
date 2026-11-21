"""本地 HTTP 服务: 托管 web 编辑器并提供 JSON API。

API 一览 (请求/响应均为 JSON):
    GET  /api/health
    GET  /api/samples
    GET  /api/samples/{name}
    POST /api/validate                body: 工程对象
    POST /api/impact     {project, quest_id}
    POST /api/diff       {before, after}
    POST /api/export     {project}            -> 运行时数据
    POST /api/import     {data}               -> {project, problems}
    POST /api/sim/create {project}            -> {session_id, summary}
    GET  /api/sim/{sid}                       -> 模拟器完整状态
    POST /api/sim/{sid}/step   {action, quest_id}
    POST /api/sim/{sid}/undo
    POST /api/sim/{sid}/reset
    GET  /api/sim/{sid}/progress                       -> 模拟进度 JSON
    POST /api/sim/{sid}/progress  body: 进度文件内容    -> {warnings}
"""

from __future__ import annotations

import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict
from urllib.parse import urlparse

from .analysis import analyze_project, compare_projects, downstream_impact
from .model import Project, ProjectError, export_runtime, import_runtime
from .simulator import Simulator

_WEB_ROOT = Path(__file__).resolve().parent.parent / "web"
_SAMPLE_ROOT = Path(__file__).resolve().parent.parent / "samples"

_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}

# 会话保存在内存; 编辑器单用户使用足够
_SESSIONS: Dict[str, Simulator] = {}
_SESSION_LOCK = threading.Lock()


class _Handler(BaseHTTPRequestHandler):
    server_version = "QuestChain/1.0"

    # -- 基础工具 --------------------------------------------------------

    def _send_json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> Any:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def log_message(self, fmt: str, *args: Any) -> None:  # 安静一点
        pass

    # -- 路由 ------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 - http.server 约定
        path = urlparse(self.path).path
        if path == "/api/health":
            self._send_json({"ok": True})
            return
        if path == "/api/samples":
            samples = sorted(p.name for p in _SAMPLE_ROOT.glob("*.json"))
            self._send_json({"samples": samples})
            return
        if path.startswith("/api/samples/"):
            name = path.split("/", 3)[-1]
            self._send_sample(name)
            return
        if path.startswith("/api/sim/"):
            parts = path.strip("/").split("/")
            # /api/sim/{sid} 或 /api/sim/{sid}/progress
            if len(parts) not in (3, 4):
                self._send_json({"error": "非法会话路径"}, 404)
                return
            sid = parts[2]
            sim = _SESSIONS.get(sid)
            if sim is None:
                self._send_json({"error": "会话不存在或已过期"}, 404)
                return
            if len(parts) == 4 and parts[3] == "progress":
                self._send_json(sim.export_progress())
                return
            self._send_json(self._sim_state(sim))
            return
        self._send_static(path)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            body = self._read_json()
        except json.JSONDecodeError as exc:
            self._send_json({"error": f"请求体不是合法 JSON: {exc}"}, 400)
            return
        try:
            self._route_post(path, body)
        except ProjectError as exc:
            self._send_json({"error": str(exc)}, 400)
        except Exception as exc:  # noqa: BLE001 - API 层兜底, 前端统一展示
            self._send_json({"error": f"服务器内部错误: {exc}"}, 500)

    def _route_post(self, path: str, body: Dict[str, Any]) -> None:
        if path == "/api/validate":
            project = Project.from_dict(body)
            issues = [i.to_dict() for i in analyze_project(project)]
            self._send_json({"issues": issues})
            return
        if path == "/api/impact":
            project = Project.from_dict(body["project"])
            self._send_json(downstream_impact(project, body["quest_id"]))
            return
        if path == "/api/diff":
            before = Project.from_dict(body["before"])
            after = Project.from_dict(body["after"])
            self._send_json(compare_projects(before, after))
            return
        if path == "/api/export":
            project = Project.from_dict(body)
            self._send_json(export_runtime(project))
            return
        if path == "/api/import":
            project, problems = import_runtime(body)
            self._send_json({"project": project.to_dict(), "problems": problems})
            return
        if path == "/api/sim/create":
            project = Project.from_dict(body)
            sim = Simulator(project)
            sid = uuid.uuid4().hex
            with _SESSION_LOCK:
                _SESSIONS[sid] = sim
            self._send_json({"session_id": sid, **self._sim_state(sim)})
            return

        if path.startswith("/api/sim/"):
            parts = path.strip("/").split("/")
            # /api/sim/{sid}/{action}
            if len(parts) != 4:
                self._send_json({"error": "非法会话路径"}, 404)
                return
            sid, action = parts[2], parts[3]
            sim = _SESSIONS.get(sid)
            if sim is None:
                self._send_json({"error": "会话不存在或已过期"}, 404)
                return
            if action == "step":
                diff = sim.step(body.get("action", ""), body.get("quest_id", ""))
                self._send_json({"diff": diff.to_dict(), **self._sim_state(sim)})
            elif action == "undo":
                ok = sim.undo()
                self._send_json({"ok": ok, **self._sim_state(sim)})
            elif action == "reset":
                sim.reset()
                self._send_json(self._sim_state(sim))
            elif action == "progress":
                warnings = sim.load_progress(body)
                self._send_json({"warnings": warnings, **self._sim_state(sim)})
            else:
                self._send_json({"error": f"未知操作 {action}"}, 404)
            return
        self._send_json({"error": "未知 API 路径"}, 404)

    # -- 响应拼装 --------------------------------------------------------

    @staticmethod
    def _sim_state(sim: Simulator) -> Dict[str, Any]:
        return {
            "project": sim.project.to_dict(),
            "quest_states": sim.quest_states,
            "blocked_reasons": sim.blocked_reasons,
            "summary": sim.summary(),
            "log": sim.log,
        }

    def _send_sample(self, name: str) -> None:
        safe_name = Path(name).name  # 防止路径穿越
        target = _SAMPLE_ROOT / safe_name
        if not target.exists():
            self._send_json({"error": f"样例 {name} 不存在"}, 404)
            return
        self._send_json(json.loads(target.read_text(encoding="utf-8")))

    def _send_static(self, url_path: str) -> None:
        relative = "index.html" if url_path in ("", "/") else url_path.lstrip("/")
        target = (_WEB_ROOT / relative).resolve()
        if not str(target).startswith(str(_WEB_ROOT.resolve())) or not target.is_file():
            self.send_error(404, "Not Found")
            return
        body = target.read_bytes()
        self.send_response(200)
        self.send_header(
            "Content-Type", _CONTENT_TYPES.get(target.suffix, "application/octet-stream")
        )
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def run_server(host: str = "127.0.0.1", port: int = 8765) -> None:
    server = ThreadingHTTPServer((host, port), _Handler)
    print(f"任务链编辑器已启动: http://{host}:{port}/  (Ctrl+C 退出)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止")
    finally:
        server.server_close()
