"""采集后台 HTTP 服务：调度/任务 API、请求日志、来源管理代理和调度页面。"""
import json
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from client import admin_get, admin_post
from config import COLLECTOR_PORT, SOURCES, VENUE_SOURCE, VENUES
from db import Database
from scheduler import Scheduler

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


def make_handler(db: Database, scheduler: Scheduler):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            pass

        # ------------------------------------------------------------- helpers
        def _send_json(self, status, payload):
            body = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)

        def _read_json(self):
            length = int(self.headers.get("Content-Length") or 0)
            if not length:
                return {}
            try:
                return json.loads(self.rfile.read(length).decode())
            except json.JSONDecodeError:
                return {}

        def _source_base_url(self, source_id):
            row = db.conn.execute(
                "SELECT base_url FROM sources WHERE id=?", (source_id,)
            ).fetchone()
            if not row:
                raise ValueError(f"unknown source: {source_id}")
            return row["base_url"]

        # ---------------------------------------------------------------- GET
        def do_GET(self):
            parsed = urlparse(self.path)
            path = parsed.path
            qs = parse_qs(parsed.query)
            try:
                if path == "/health":
                    self._send_json(200, {"ok": True})
                elif path == "/api/state":
                    self._send_json(200, db.snapshot())
                elif path == "/api/logs":
                    source_id = qs.get("source_id", [None])[0]
                    limit = int(qs.get("limit", ["200"])[0])
                    self._send_json(200, {"logs": db.list_logs(source_id, limit)})
                elif path == "/api/source/quota":
                    source_id = qs.get("source_id", [""])[0]
                    self._send_json(200, admin_get(self._source_base_url(source_id), "/admin/quota"))
                elif path == "/" or path == "/index.html":
                    self._serve_file(WEB_DIR / "index.html", "text/html; charset=utf-8")
                elif path == "/app.js":
                    self._serve_file(WEB_DIR / "app.js", "application/javascript; charset=utf-8")
                elif path == "/styles.css":
                    self._serve_file(WEB_DIR / "styles.css", "text/css; charset=utf-8")
                else:
                    self._send_json(404, {"error": "not found"})
            except Exception as e:
                self._send_json(500, {"error": str(e)})

        # --------------------------------------------------------------- POST
        def do_POST(self):
            path = urlparse(self.path).path
            body = self._read_json()
            try:
                if path == "/api/jobs":
                    self._create_job(body)
                elif path == "/api/jobs/rerun":
                    self._rerun_job(body)
                elif path == "/api/schedules":
                    self._add_schedule(body)
                elif path == "/api/schedules/toggle":
                    db.set_schedule_enabled(int(body["id"]), bool(body.get("enabled", True)))
                    self._send_json(200, {"ok": True})
                elif path == "/api/source/start-cycle":
                    source_id = body["source_id"]
                    self._send_json(
                        200,
                        admin_post(self._source_base_url(source_id), "/admin/start-cycle"),
                    )
                else:
                    self._send_json(404, {"error": "not found"})
            except KeyError as e:
                self._send_json(400, {"error": f"missing field: {e}"})
            except ValueError as e:
                self._send_json(400, {"error": str(e)})
            except Exception as e:
                self._send_json(500, {"error": str(e)})

        # ------------------------------------------------------------- actions
        def _create_job(self, body):
            venue_id, date = body["venue_id"], body["date"]
            if venue_id not in VENUE_SOURCE:
                raise ValueError(f"unknown venue: {venue_id}")
            trigger = body.get("trigger", "manual")
            job, created, merged = db.create_or_get_job(venue_id, date, trigger)
            # 任务已跑完再点“立即采集”：重置后从头重拉（幂等，不重复写入）
            if not created and job["status"] == "done" and trigger == "manual":
                db.reset_job_for_rerun(job["id"])
                job = db.get_job(job["id"])
            db.ensure_first_page(job["id"])
            self._send_json(200, {"job": db.get_job(job["id"]), "created": created, "merged": merged})

        def _rerun_job(self, body):
            job = db.get_job(int(body["job_id"]))
            if not job:
                raise ValueError("job not found")
            db.reset_job_for_rerun(job["id"])
            db.ensure_first_page(job["id"])
            self._send_json(200, {"job": db.get_job(job["id"])})

        def _add_schedule(self, body):
            venue_id, date = body["venue_id"], body["date"]
            if venue_id not in VENUE_SOURCE:
                raise ValueError(f"unknown venue: {venue_id}")
            interval = int(body.get("interval_seconds", 60))
            if interval < 1:
                raise ValueError("interval_seconds must be >= 1")
            sid = db.add_schedule(venue_id, date, interval)
            self._send_json(200, {"schedule_id": sid})

        def _serve_file(self, file_path: Path, content_type):
            if not file_path.exists():
                self._send_json(404, {"error": "not found"})
                return
            data = file_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)

    return Handler


def run():
    db = Database()
    scheduler = Scheduler(db)
    scheduler.start()
    server = ThreadingHTTPServer(("127.0.0.1", COLLECTOR_PORT), make_handler(db, scheduler))
    print(f"采集后台已启动: http://127.0.0.1:{COLLECTOR_PORT}")
    print("调度页面:  http://127.0.0.1:%d/" % COLLECTOR_PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        scheduler.stop()
        server.shutdown()
        server.server_close()
        db.close()


if __name__ == "__main__":
    run()
