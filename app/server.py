"""HTTP 服务：来源模拟台 + 接收台 + 查询库，单文件无第三方依赖。

启动：
    python3 -m app.server --port 8765 --data-dir ./data/state
打开 http://127.0.0.1:8765/
"""
import argparse
import json
import mimetypes
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

from . import source
from .receiver import Receiver, ReceiverError

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")


def make_handler(receiver: Receiver):
    class Handler(BaseHTTPRequestHandler):
        server_version = "CsTicketReceiver/1.0"

        def log_message(self, fmt, *args):
            print("[http]", self.address_string(), fmt % args, flush=True)

        # ---------- helpers ----------
        def _send(self, status, body, ctype="application/json; charset=utf-8"):
            if isinstance(body, (dict, list)):
                body = json.dumps(body, ensure_ascii=False, indent=1).encode("utf-8")
            elif isinstance(body, str):
                body = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _read_json(self):
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b"{}"
            try:
                return json.loads(raw.decode("utf-8"))
            except Exception as exc:
                raise ReceiverError(400, f"请求体不是合法 JSON：{exc}")

        # ---------- routes ----------
        def do_GET(self):
            try:
                u = urlparse(self.path)
                path = u.path
                qs = parse_qs(u.query)
                if path == "/api/source/deliveries":
                    return self._send(200, {"batches": source.all_delivery_specs()})
                if path == "/api/receiver/state":
                    return self._send(200, receiver.status())
                if path == "/api/tickets":
                    return self._send(200, {"tickets": receiver.list_tickets(qs.get("q", [None])[0], qs.get("status", [None])[0])})
                if path.startswith("/api/tickets/"):
                    tid = unquote(path[len("/api/tickets/"):])
                    # 已删除的工单返回 200 + exists=false，仍然带完整历史
                    return self._send(200, receiver.ticket_detail(tid))
                if path == "/api/history":
                    return self._send(200, {"history": receiver.history_list()})
                if path == "/api/source/pull":
                    # 模拟「来源推送到接收台」：便于脚本化测试，网页亦可直接调用
                    batch_no = int(qs.get("batch_no", ["0"])[0])
                    which = qs.get("which", ["all"])[0]
                    order = qs.get("order", ["normal"])[0]
                    return self._send(200, self._pull(batch_no, which, order))
                if path in ("/", "/index.html"):
                    return self._static("index.html")
                if path.startswith("/static/"):
                    return self._static(path[len("/static/"):])
                return self._send(404, {"error": "not found"})
            except ReceiverError as exc:
                return self._send(exc.status, {"error": exc.message})
            except Exception as exc:  # pragma: no cover - 兜底
                return self._send(500, {"error": str(exc)})

        def do_POST(self):
            try:
                u = urlparse(self.path)
                if u.path == "/api/receiver/intake":
                    payload = self._read_json()
                    result = receiver.ingest(
                        payload.get("batch_no"),
                        payload.get("kind") or "shard",
                        payload.get("filename") or "",
                        json.dumps(payload.get("body"), ensure_ascii=False, separators=(",", ":"))
                        if not isinstance(payload.get("body"), str)
                        else payload.get("body"),
                    )
                    return self._send(200, result)
                if u.path == "/api/source/push":
                    payload = self._read_json()
                    return self._send(200, self._push(payload))
                if u.path == "/api/receiver/reset":
                    self._read_json()  # 必须读干请求体，否则 keep-alive 连接上会污染下一个请求
                    receiver.reset()
                    return self._send(200, {"ok": True, "state": receiver.status()})
                return self._send(404, {"error": "not found"})
            except ReceiverError as exc:
                return self._send(exc.status, {"error": exc.message})
            except Exception as exc:  # pragma: no cover
                return self._send(500, {"error": str(exc)})

        # ---------- source actions ----------
        def _pull(self, batch_no, which, order):
            try:
                items = source.deliveries(batch_no)
            except KeyError:
                raise ReceiverError(404, f"来源没有第 {batch_no} 批")
            if which == "manifest":
                items = [d for d in items if d.kind == "manifest"]
            elif which == "shards":
                items = [d for d in items if d.kind == "shard"]
            if order == "reverse":
                items = list(reversed(items))
            results = []
            for d in items:
                results.append(
                    receiver.ingest(d.batch_no, d.kind, d.filename, d.body)
                )
            return {"results": results, "state": receiver.status()}

        def _push(self, payload):
            try:
                batch_no = int(payload["batch_no"])
            except (KeyError, TypeError, ValueError):
                raise ReceiverError(400, "缺少合法的 batch_no")
            which = payload.get("which", "all")
            order = payload.get("order", "normal")
            filename = payload.get("filename")
            if filename:
                try:
                    items = [d for d in source.deliveries(batch_no) if d.filename == filename]
                except KeyError:
                    raise ReceiverError(404, f"来源没有第 {batch_no} 批")
                if not items:
                    raise ReceiverError(404, f"来源没有该文件：{filename}")
                results = [receiver.ingest(d.batch_no, d.kind, d.filename, d.body) for d in items]
                return {"results": results, "state": receiver.status()}
            return self._pull(batch_no, which, order)

        # ---------- static ----------
        def _static(self, name):
            name = os.path.basename(name)
            full = os.path.join(STATIC_DIR, name)
            if not os.path.isfile(full):
                return self._send(404, {"error": "not found"})
            with open(full, "rb") as fh:
                data = fh.read()
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
                ctype += "; charset=utf-8"
            return self._send(200, data, ctype)

    return Handler


def main(argv=None):
    ap = argparse.ArgumentParser(description="客服工单分片交付模拟台")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--data-dir", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "state"))
    args = ap.parse_args(argv)

    receiver = Receiver(args.data_dir)

    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(receiver))
    print(f"客服工单接收台已启动: http://{args.host}:{args.port}/  (数据目录: {args.data_dir})", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止", flush=True)
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
