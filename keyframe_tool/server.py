"""本机操作页面的 HTTP 服务与 API（仅绑定 127.0.0.1）。

API：
  GET  /                      页面
  GET  /api/probe?path=       探测素材（带缓存）
  GET  /api/nearest?path&t    指定显示时间最近的前后关键帧
  GET  /api/thumb?path&n      抽取显示顺序第 n 帧 PNG
  POST /api/plan              两种裁切模式的计划范围（执行前预览）
  POST /api/cut               执行裁切 + 读回 + 出核对记录
  GET  /api/report?path       下载已生成的报告/成品
"""

from __future__ import annotations

import json
import os
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import cuts, genmedia, report, verify
from .ffmpeg_utils import FFmpegError
from .probe import ProbeResult, nearest_keyframes, probe_media

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")
DEFAULT_OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "outputs")

_cache_lock = threading.Lock()
_probe_cache: dict[str, ProbeResult] = {}


def get_probe(path: str) -> ProbeResult:
    real = os.path.realpath(os.path.abspath(path))
    with _cache_lock:
        cached = _probe_cache.get(real)
    if cached is None:
        pr = probe_media(real)
        with _cache_lock:
            _probe_cache[real] = pr
        cached = pr
    return cached


def _safe_join(base: str, name: str) -> str | None:
    base_real = os.path.realpath(base)
    target = os.path.realpath(os.path.join(base_real, name))
    if not target.startswith(base_real + os.sep) and target != base_real:
        return None
    return target


class Handler(BaseHTTPRequestHandler):
    server_version = "KeyframeCutTool/1.0"

    # ---------- 基础收发 ----------
    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, exc: Exception, status: int = 400) -> None:
        self._json({"ok": False, "error": str(exc)}, status)

    def _query(self) -> dict:
        parsed = urllib.parse.urlparse(self.path)
        return {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}, parsed.path

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def log_message(self, fmt, *args):  # 安静一点
        pass

    # ---------- 路由 ----------
    def do_GET(self) -> None:
        try:
            q, path = self._query()
            if path in ("/", "/index.html"):
                return self._serve_static("index.html", "text/html; charset=utf-8")
            if path == "/app.js":
                return self._serve_static("app.js", "application/javascript; charset=utf-8")
            if path == "/style.css":
                return self._serve_static("style.css", "text/css; charset=utf-8")
            if path == "/api/probe":
                return self._json({"ok": True, "data": get_probe(q["path"]).to_dict()})
            if path == "/api/nearest":
                pr = get_probe(q["path"])
                return self._json({"ok": True, "data": nearest_keyframes(pr.frames, float(q["t"]))})
            if path == "/api/thumb":
                return self._serve_thumb(q)
            if path == "/api/report":
                return self._serve_report(q)
            self._json({"ok": False, "error": "未知接口"}, 404)
        except KeyError as exc:
            self._error(ValueError(f"缺少参数: {exc}"))
        except (FFmpegError, ValueError, FileNotFoundError) as exc:
            self._error(exc)
        except Exception as exc:  # 页面上也要能看到意外错误
            self._error(exc, 500)

    def do_POST(self) -> None:
        try:
            _, path = self._query()
            body = self._body()
            if path == "/api/plan":
                return self._handle_plan(body)
            if path == "/api/cut":
                return self._handle_cut(body)
            if path == "/api/generate-samples":
                out_dir = body.get("out_dir") or os.path.join(
                    os.path.dirname(DEFAULT_OUT_DIR), "public", "samples")
                manifest = genmedia.generate(out_dir)
                return self._json({"ok": True, "data": {"out_dir": out_dir, "manifest": manifest}})
            self._json({"ok": False, "error": "未知接口"}, 404)
        except (FFmpegError, cuts.CutValidationError, ValueError, FileNotFoundError) as exc:
            self._error(exc)
        except Exception as exc:
            self._error(exc, 500)

    # ---------- 静态资源与缩略图 ----------
    def _serve_static(self, name: str, content_type: str) -> None:
        target = _safe_join(WEB_DIR, name)
        if not target or not os.path.isfile(target):
            return self._json({"ok": False, "error": f"静态资源缺失: {name}"}, 404)
        with open(target, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _serve_thumb(self, q: dict) -> None:
        pr = get_probe(q["path"])
        n = max(0, min(int(q["n"]), len(pr.frames) - 1))
        from .verify import _extract_frame
        png = _extract_frame(pr.path, n)
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(png)))
        self.end_headers()
        self.wfile.write(png)

    def _serve_report(self, q: dict) -> None:
        target = _safe_join(self.server.out_dir, q.get("name", ""))
        if not target or not os.path.isfile(target):
            return self._json({"ok": False, "error": "报告或成品不存在"}, 404)
        ctype = {
            ".md": "text/markdown; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".mp4": "video/mp4",
        }.get(os.path.splitext(target)[1], "application/octet-stream")
        with open(target, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ---------- 裁切 ----------
    def _handle_plan(self, body: dict) -> None:
        pr = get_probe(body["path"])
        in_t, out_t = float(body["in"]), float(body["out"])
        plans = {m: cuts.build_plan(pr, m, in_t, out_t).to_dict() for m in ("fast", "accurate")}
        self._json({"ok": True, "data": plans})

    def _handle_cut(self, body: dict) -> None:
        pr = get_probe(body["path"])
        mode = body.get("mode", "fast")
        plan = cuts.build_plan(pr, mode, float(body["in"]), float(body["out"]))
        out_dir = self.server.out_dir
        os.makedirs(out_dir, exist_ok=True)
        base = f"{os.path.splitext(os.path.basename(pr.path))[0]}_{mode}_{plan.target_in_idx}-{plan.target_out_idx}"
        output_path = os.path.join(out_dir, base + ".mp4")
        report_base = os.path.join(out_dir, base + "_report")
        cuts.execute(pr, plan, output_path)
        verify_data = verify.verify_cut(pr, plan.to_dict(), output_path)
        md_path, json_path = report.write_reports(pr, plan.to_dict(), verify_data, output_path, report_base)
        self._json({
            "ok": True,
            "data": {
                "plan": plan.to_dict(),
                "verify": verify_data,
                "files": {
                    "output": os.path.basename(output_path),
                    "report_md": os.path.basename(md_path),
                    "report_json": os.path.basename(json_path),
                },
            },
        })


def serve(host: str = "127.0.0.1", port: int = 8765, out_dir: str = DEFAULT_OUT_DIR) -> None:
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.out_dir = os.path.abspath(out_dir)
    print(f"关键帧裁切检查工具已启动: http://{host}:{port}")
    print(f"成品与核对记录输出目录: {httpd.out_dir}")
    print("按 Ctrl+C 停止")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
