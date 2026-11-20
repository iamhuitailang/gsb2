"""本地工作台 HTTP 服务。

安全约束：
- 只绑定 127.0.0.1，且校验 Host 头必须是本机回环地址，拒绝其他主机名访问。
- 纯标准库 http.server，不引入任何外部依赖；接口只收 JSON 源码文本。
- 请求体大小有限制；待检源码只进入 ast.parse，不会被导入或执行。
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .orchestrator import check_sources, summarize
from .rules import DECISION_BASIS, SANITIZER_RULES, SINK_RULES

_HERE = Path(__file__).resolve().parent
_WEB_DIR = _HERE / "web"
_SAMPLES_DIR = _HERE.parent / "samples"
MAX_REQUEST_BYTES = 2 * 1024 * 1024  # HTTP 请求体 2MB 上限


def load_samples() -> list[dict]:
    """读取内置示例（按文件名稳定排序）。"""
    samples = []
    if not _SAMPLES_DIR.exists():
        return samples
    for path in sorted(_SAMPLES_DIR.rglob("*.py")):
        rel = path.relative_to(_SAMPLES_DIR)
        samples.append({"name": str(rel), "code": path.read_text(encoding="utf-8")})
    return samples


def _rule_catalog() -> dict:
    return {
        "sinks": [
            {"rule_id": r.rule_id, "label": r.label, "kind": r.kind, "basis": r.basis}
            for r in SINK_RULES.values()
        ],
        "sanitizers": [
            {"rule_id": r.rule_id, "label": r.label, "basis": r.basis}
            for r in SANITIZER_RULES.values()
        ],
        "decisions": [{"rule_id": k, "basis": v} for k, v in DECISION_BASIS.items()],
    }


class _LocalOnlyHandler(BaseHTTPRequestHandler):
    server_version = "taintbench/1.0"

    # -------------------------------------------------- 基础响应

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path, content_type: str) -> None:
        if not path.exists():
            self._send_json({"error": "not found"}, status=404)
            return
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _reject(self, status: int, message: str) -> None:
        # 状态行必须是 latin-1 可编码文本，中文说明只放在 JSON 响应体里
        self.send_response(status, "Forbidden" if status == 403 else "Error")
        body = json.dumps({"error": message}, ensure_ascii=False).encode("utf-8")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _is_loopback_host(self) -> bool:
        host = self.headers.get("Host", "")
        hostname = host.split(":")[0].strip("[]").lower()
        return hostname in ("127.0.0.1", "localhost", "::1")

    # -------------------------------------------------- 路由

    def do_GET(self):  # noqa: N802 - http.server 命名约定
        if not self._is_loopback_host():
            self._reject(403, "本服务只允许本机回环地址（127.0.0.1 / localhost / ::1）访问")
            return
        if self.path in ("/", "/index.html"):
            self._send_file(_WEB_DIR / "index.html", "text/html; charset=utf-8")
        elif self.path == "/api/samples":
            self._send_json({"samples": load_samples()})
        elif self.path == "/api/rules":
            self._send_json(_rule_catalog())
        else:
            self._reject(404, "接口不存在")

    def do_POST(self):  # noqa: N802
        if not self._is_loopback_host():
            self._reject(403, "本服务只允许本机回环地址（127.0.0.1 / localhost / ::1）访问")
            return
        if self.path != "/api/check":
            self._reject(404, "接口不存在")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json({"error": "非法的 Content-Length"}, status=400)
            return
        if length <= 0 or length > MAX_REQUEST_BYTES:
            # 读完整个请求体再响应，避免客户端发送途中收到连接重置
            try:
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(remaining, 64 * 1024))
                    if not chunk:
                        break
                    remaining -= len(chunk)
            except OSError:
                pass
            self.close_connection = True
            self._send_json(
                {"error": f"请求体需在 1~{MAX_REQUEST_BYTES} 字节之间"}, status=413
            )
            return
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
            files = payload["files"]
            if not isinstance(files, list):
                raise ValueError("files 必须是数组")
            sources = []
            for item in files:
                name = str(item["name"])
                code = item["code"] if isinstance(item["code"], str) else str(item["code"])
                # 显示名只作展示，去掉路径穿越成分
                safe_name = name.replace("\\", "/").lstrip("/")
                if ".." in safe_name.split("/"):
                    safe_name = "editor.py"
                sources.append((safe_name or "editor.py", code))
        except (json.JSONDecodeError, KeyError, ValueError) as exc:
            self._send_json({"error": f"请求格式不正确：{exc}"}, status=400)
            return
        results = check_sources(sources)
        self._send_json(
            {
                "results": [r.to_dict() for r in results],
                "summary": summarize(results),
                "notice": "静态分析只能发现已知模式下的可疑数据流，不能证明源码绝对安全。",
            }
        )

    def log_message(self, fmt, *args):  # 安静日志，避免演示时刷屏
        return


def serve(host: str = "127.0.0.1", port: int = 8000) -> None:
    if host not in ("127.0.0.1", "::1", "localhost"):
        raise ValueError("工作台只允许绑定本机回环地址")
    server = ThreadingHTTPServer((host, port), _LocalOnlyHandler)
    print(f"taintbench 已启动（仅本机访问）: http://{host}:{port}")
    print("按 Ctrl+C 停止。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n正在停止……")
    finally:
        server.server_close()
