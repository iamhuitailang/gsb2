"""本地预览服务：只读托管一个工作区，并提供换档决策 API。

- 纯标准库 http.server，绑定 127.0.0.1，不监听外网；
- 所有文件访问都被限制在工作区目录内（防路径穿越）；
- /api/switch 复用 switching.decide_switch，播放器看到的规则与单测一致；
- 切换尝试（含被拒绝的）写入工作区 switch_log.json，失败绝不静默。
"""

from __future__ import annotations

import json
import threading
import time
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .build import load_manifest
from .switching import assert_no_replay, decide_switch
from .verify import verify_workspace


def _safe_resolve(root: Path, rel: str) -> Path | None:
    """把相对路径限制在 root 内；任何穿越尝试一律拒绝。"""
    if not rel or rel.startswith("/"):
        return None
    candidate = (root / rel).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError:
        return None
    return candidate


class PreviewHandler(BaseHTTPRequestHandler):
    server_version = "sebalign/0.1"

    def log_message(self, fmt: str, *args) -> None:  # 安静一点
        pass

    @property
    def root(self) -> Path:
        return self.server.root  # type: ignore[attr-defined]

    def _send_json(self, payload: dict, code: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path) -> None:
        ctype = {
            ".mp4": "video/mp4",
            ".m4a": "audio/mp4",
            ".png": "image/png",
            ".json": "application/json; charset=utf-8",
        }.get(path.suffix.lower(), "application/octet-stream")
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Accept-Ranges", "none")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        route, qs = parsed.path, parse_qs(parsed.query)

        if route == "/":
            self._send_file(Path(__file__).with_name("web") / "player.html")
            return
        if route == "/api/manifest":
            self._send_json(self.server.manifest)  # type: ignore[attr-defined]
            return
        if route == "/api/verify":
            report = verify_workspace(self.root, self.server.manifest)  # type: ignore[attr-defined]
            self._send_json(report.to_dict())
            return
        if route == "/api/markers":
            markers_path = _safe_resolve(self.root, "markers.json")
            if markers_path and markers_path.is_file():
                self._send_file(markers_path)
            else:
                self._send_json(self.server.manifest.get("markers", {}))  # type: ignore[attr-defined]
            return
        if route == "/api/switch":
            self._handle_switch(qs)
            return
        if route == "/api/switch-log":
            log_path = self.root / "switch_log.json"
            if log_path.is_file():
                self._send_file(log_path)
            else:
                self._send_json({"attempts": []})
            return
        if route.startswith("/media/"):
            rel = route[len("/media/"):]
            target = _safe_resolve(self.root, rel)
            if target and target.is_file():
                self._send_file(target)
                return
            self._send_json({"error": "非法或不存在的路径"}, 404)
            return
        self._send_json({"error": "unknown route"}, 404)

    def _handle_switch(self, qs: dict[str, list[str]]) -> None:
        try:
            from_tier = qs["from"][0]
            to_tier = qs["to"][0]
            source_time = float(qs["t"][0])
        except (KeyError, IndexError, ValueError):
            self._send_json({"error": "参数需要 from, to, t(秒)"}, 400)
            return
        manifest = self.server.manifest  # type: ignore[attr-defined]
        try:
            decision = decide_switch(manifest, from_tier, to_tier, source_time)
        except KeyError as exc:
            self._send_json({"error": str(exc).strip("'")}, 400)
            return
        payload = decision.to_dict()

        # 即使决策放行，也再过一道“禁止重播”闸门
        if decision.verdict == "switch_now" and decision.candidate_time is not None:
            reject = assert_no_replay(manifest, to_tier, source_time, decision.candidate_time)
            if reject:
                payload["verdict"] = "abort"
                payload["reason"] = reject
                payload["replay_rejected"] = True

        payload["logged_at"] = time.time()
        self._append_log(payload)
        self._send_json(payload)

    def _append_log(self, entry: dict) -> None:
        log_path = self.root / "switch_log.json"
        with self.server.log_lock:  # type: ignore[attr-defined]
            data = {"attempts": []}
            if log_path.is_file():
                try:
                    data = json.loads(log_path.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    data = {"attempts": []}
            data["attempts"].append(entry)
            log_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def serve(workspace: str | Path, host: str = "127.0.0.1", port: int = 8765) -> ThreadingHTTPServer:
    root = Path(workspace).resolve()
    manifest = load_manifest(root)
    handler = partial(PreviewHandler)
    httpd = ThreadingHTTPServer((host, port), handler)
    httpd.root = root  # type: ignore[attr-defined]
    httpd.manifest = manifest  # type: ignore[attr-defined]
    httpd.log_lock = threading.Lock()  # type: ignore[attr-defined]
    return httpd
