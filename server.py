"""本地 HTTP 服务：仅绑定 127.0.0.1，纯标准库，不发起任何外部请求。

启动：python3 server.py [--port 8000] [--data data/csp-console.json]
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from csp.parser import parse_policy
from csp.samples import SAMPLES, run_samples
from csp.storage import Storage, StorageError

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
}


class Handler(BaseHTTPRequestHandler):
    storage: Storage = None  # 由 main 注入

    def log_message(self, fmt, *args):  # 安静一点
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    # ---------- 基础工具 ----------
    def _send_json(self, payload, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # 本地工具：不引入任何外部缓存/追踪
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"请求体不是合法 JSON：{exc}") from exc
        if not isinstance(data, dict):
            raise ValueError("请求体必须是 JSON 对象")
        return data

    def _send_static(self, rel_path: str):
        # 防目录穿越
        safe = os.path.normpath(os.path.join(STATIC_DIR, rel_path))
        if not safe.startswith(STATIC_DIR + os.sep) and safe != STATIC_DIR:
            self.send_error(403)
            return
        if os.path.isdir(safe):
            safe = os.path.join(safe, "index.html")
        if not os.path.isfile(safe):
            self.send_error(404)
            return
        ext = os.path.splitext(safe)[1]
        with open(safe, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ---------- 路由 ----------
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/health":
                return self._send_json({"ok": True, "offline": True})
            if path == "/api/policies":
                return self._send_json({"policies": self.storage.list_policies()})
            if path == "/api/records":
                q = parse_qs(parsed.query)
                records = self.storage.list_records(
                    decision=q.get("decision", [None])[0],
                    resource_type=q.get("resource_type", [None])[0],
                    policy_id=q.get("policy_id", [None])[0],
                    mode=q.get("mode", [None])[0],
                    keyword=q.get("keyword", [None])[0],
                )
                return self._send_json({"records": records})
            if path == "/api/records/export":
                return self._export_records(parse_qs(parsed.query))
            if path == "/api/samples":
                return self._send_json(
                    {"samples": [
                        {"key": s.key, "title": s.title, "description": s.description,
                         "policies": s.policies, "requests": s.requests, "expected": s.expected}
                        for s in SAMPLES
                    ]}
                )
            if path == "/api/samples/run":
                return self._send_json(run_samples())
            if path == "/" or path.startswith("/static/") or path.endswith((".html", ".css", ".js")):
                rel = "index.html" if path == "/" else path.lstrip("/").removeprefix("static/")
                return self._send_static(rel)
            self.send_error(404)
        except StorageError as exc:
            self._send_json({"error": str(exc)}, status=409)
        except ValueError as exc:
            self._send_json({"error": str(exc)}, status=400)
        except Exception as exc:  # 本地工具：把错误原样返回便于排查
            self._send_json({"error": f"{type(exc).__name__}: {exc}"}, status=500)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            data = self._read_json()
            if path == "/api/parse":
                parsed = parse_policy(data.get("text", ""))
                return self._send_json(parsed.to_dict())
            if path == "/api/policies":
                policy = self.storage.add_policy(
                    data.get("name", ""), data.get("text", ""), data.get("mode", "enforce")
                )
                return self._send_json({"policy": policy}, status=201)
            if path == "/api/analyze":
                record = self.storage.analyze(data.get("policy_ids", []), data.get("request", {}))
                return self._send_json({"record": record}, status=201)
            if path == "/api/samples/import":
                return self._import_sample(data.get("key", ""))
            self.send_error(404)
        except StorageError as exc:
            self._send_json({"error": str(exc)}, status=409)
        except ValueError as exc:
            self._send_json({"error": str(exc)}, status=400)
        except Exception as exc:
            self._send_json({"error": f"{type(exc).__name__}: {exc}"}, status=500)

    def do_PUT(self):
        path = urlparse(self.path).path
        try:
            data = self._read_json()
            if path.startswith("/api/policies/"):
                pid = path.rsplit("/", 1)[-1]
                policy = self.storage.replace_policy(
                    pid, data.get("name", ""), data.get("text", ""), data.get("mode", "enforce")
                )
                return self._send_json({"policy": policy})
            self.send_error(404)
        except StorageError as exc:
            self._send_json({"error": str(exc)}, status=409)
        except ValueError as exc:
            self._send_json({"error": str(exc)}, status=400)

    def do_DELETE(self):
        path = urlparse(self.path).path
        try:
            if path.startswith("/api/policies/"):
                pid = path.rsplit("/", 1)[-1]
                self.storage.delete_policy(pid)
                return self._send_json({"ok": True})
            if path == "/api/records":
                self.storage.clear_records()
                return self._send_json({"ok": True})
            self.send_error(404)
        except StorageError as exc:
            self._send_json({"error": str(exc)}, status=409)

    # ---------- 业务辅助 ----------
    def _import_sample(self, key: str):
        sample = next((s for s in SAMPLES if s.key == key), None)
        if sample is None:
            raise ValueError(f"样例 {key!r} 不存在")
        created = []
        for p in sample.policies:
            created.append(self.storage.add_policy(p["name"], p["text"], p["mode"]))
        return self._send_json({"imported": created}, status=201)

    def _export_records(self, q: dict):
        records = self.storage.list_records(
            decision=q.get("decision", [None])[0],
            resource_type=q.get("resource_type", [None])[0],
            policy_id=q.get("policy_id", [None])[0],
            mode=q.get("mode", [None])[0],
            keyword=q.get("keyword", [None])[0],
        )
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow([
            "记录ID", "时间(UTC)", "最终判定", "资源类别", "页面地址", "资源地址",
            "内联", "nonce", "发起方", "父脚本受信任", "命中策略(快照名/模式/指令)",
            "逐策略判定", "判定依据", "策略快照全文",
        ])
        from datetime import datetime, timezone
        for r in records:
            req = r["request"]
            decisions = []
            snapshot_texts = []
            for d in r["policy_decisions"]:
                decisions.append(
                    f"{d['policy_name']}[{d['mode']}]={d['decision']}"
                    f"({d.get('matched_directive') or '无指令'})"
                )
            for s in r["policy_snapshots"]:
                snapshot_texts.append(f"--- {s['name']} [{s['mode']}] ---\n{s['text']}")
            writer.writerow([
                r["id"],
                datetime.fromtimestamp(r["time"], tz=timezone.utc).isoformat(),
                r["decision"],
                req["resource_type"],
                req["page_url"],
                req.get("resource_url", ""),
                "是" if req.get("is_inline") else "否",
                req.get("nonce") or "",
                req.get("initiator"),
                "是" if req.get("parent_trusted") else "否",
                " | ".join(decisions),
                " | ".join(decisions),
                r["reason_summary"],
                "\n".join(snapshot_texts),
            ])
        body = ("﻿" + buf.getvalue()).encode("utf-8")  # BOM 方便 Excel 识别 UTF-8
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", 'attachment; filename="csp-analysis.csv"')
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser(description="本地网页资源安全策略分析台")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--data", default=os.path.join(BASE_DIR, "data", "csp-console.json"))
    args = parser.parse_args()

    Handler.storage = Storage(args.data)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"分析台已启动（仅本地访问，不连接外网）: http://{args.host}:{args.port}/")
    print(f"数据文件: {args.data}")
    print("按 Ctrl+C 停止")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
        server.shutdown()


if __name__ == "__main__":
    main()
