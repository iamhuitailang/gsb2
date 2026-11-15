"""模拟场馆预约来源。

每个来源各自维护一份请求额度（令牌）：
- 每个成功的 /reservations 请求消耗 1 个令牌
- 令牌耗尽后返回 HTTP 429，带 Retry-After 头和 retry_after_seconds（等待秒数）
- 等待结束后整轮额度自动重置；也可在页面上通过管理接口手动启动一轮预设周期

管理接口：
  POST /admin/start-cycle   按预设配置重新开始一轮额度周期
  GET  /admin/quota         查看当前额度状态
"""
import json
import threading
import time
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from config import PAGE_SIZE, SOURCES


class QuotaState:
    """单个来源的额度状态，线程安全，落盘以便重启后仍能看到暂停状态。"""

    def __init__(self, source, data, state_path):
        self.source_id = source["id"]
        self.capacity = source["capacity"]
        self.retry_after = source["retry_after"]
        self.data = data
        self.state_path = Path(state_path)
        self.lock = threading.Lock()
        now = time.time()
        self.remaining = self.capacity
        self.reset_at = None  # 处于暂停时，额度重新放开的时间戳
        self.cycle_started_at = now
        self.cycle_seq = 0
        self._load()

    def _load(self):
        if self.state_path.exists():
            try:
                saved = json.loads(self.state_path.read_text())
                if saved.get("source_id") == self.source_id:
                    self.remaining = saved["remaining"]
                    self.reset_at = saved["reset_at"]
                    self.cycle_started_at = saved["cycle_started_at"]
                    self.cycle_seq = saved.get("cycle_seq", 0)
            except (json.JSONDecodeError, KeyError, OSError):
                pass

    def _persist(self):
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(json.dumps({
            "source_id": self.source_id,
            "remaining": self.remaining,
            "reset_at": self.reset_at,
            "cycle_started_at": self.cycle_started_at,
            "cycle_seq": self.cycle_seq,
        }))

    def start_cycle(self):
        """启动一轮新的预设额度周期：额度回满，解除暂停。"""
        with self.lock:
            self.cycle_seq += 1
            self.remaining = self.capacity
            self.reset_at = None
            self.cycle_started_at = time.time()
            self._persist()
            return self.snapshot_locked()

    def _refresh_locked(self):
        """暂停时间已到则整轮重置（读取侧惰性恢复，不依赖后台定时器）。"""
        if self.reset_at is not None and self.reset_at <= time.time():
            self.remaining = self.capacity
            self.reset_at = None
            self.cycle_started_at = time.time()
            self._persist()

    def acquire(self):
        """尝试消耗一个令牌。返回 (ok, retry_after_seconds)。"""
        with self.lock:
            self._refresh_locked()
            if self.reset_at is not None:
                wait = self.reset_at - time.time()
                self._persist()
                return False, max(1, int(wait + 0.999))
            if self.remaining > 0:
                self.remaining -= 1
                if self.remaining == 0:
                    # 额度用尽：进入暂停，等待 retry_after 秒后整轮重置
                    self.reset_at = time.time() + self.retry_after
                self._persist()
                return True, 0
            self.reset_at = time.time() + self.retry_after
            self._persist()
            return False, self.retry_after

    def snapshot(self):
        with self.lock:
            self._refresh_locked()
            return self.snapshot_locked()

    def snapshot_locked(self):
        now = time.time()
        paused = self.reset_at is not None and self.reset_at > now
        return {
            "source_id": self.source_id,
            "capacity": self.capacity,
            "remaining": self.remaining,
            "retry_after": self.retry_after,
            "paused": paused,
            "reset_at": self.reset_at,
            "next_request_at": self.reset_at if paused else now,
            "cycle_seq": self.cycle_seq,
            "cycle_started_at": self.cycle_started_at,
            "server_time": now,
        }


def make_handler(state: QuotaState):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _send(self, status, payload, extra_headers=None):
            body = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            for k, v in (extra_headers or {}).items():
                self.send_header(k, str(v))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt, *args):
            pass  # 采集侧会记录真实请求日志，来源侧不刷屏

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/health":
                self._send(200, {"ok": True, "source_id": state.source_id})
            elif path == "/admin/quota":
                self._send(200, state.snapshot())
            elif path == "/reservations":
                self._handle_reservations()
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            path = self.path.split("?", 1)[0]
            if path == "/admin/start-cycle":
                self._send(200, state.start_cycle())
            else:
                self._send(404, {"error": "not found"})

        def _handle_reservations(self):
            from urllib.parse import parse_qs, urlparse
            qs = parse_qs(urlparse(self.path).query)
            venue_id = qs.get("venue_id", [""])[0]
            date = qs.get("date", [""])[0]
            try:
                page = int(qs.get("page", ["1"])[0])
            except ValueError:
                page = 1
            if page < 1:
                self._send(400, {"error": "page must be >= 1"})
                return

            ok, wait = state.acquire()
            if not ok:
                # 429：等待时间同时放在响应头和响应体里
                self._send(429, {
                    "error": "rate_limited",
                    "retry_after_seconds": wait,
                    "message": f"来源 {state.source_id} 额度已用尽，{wait} 秒后重试",
                }, {"Retry-After": wait})
                return

            rows = state.data.get(venue_id, {}).get(date, [])
            total = len(rows)
            start = (page - 1) * PAGE_SIZE
            page_rows = rows[start:start + PAGE_SIZE]
            if page > 1 and start >= total and total > 0:
                self._send(404, {"error": "page out of range"})
                return
            self._send(200, {
                "venue_id": venue_id,
                "date": date,
                "page": page,
                "page_size": PAGE_SIZE,
                "total": total,
                "has_next": (start + PAGE_SIZE) < total,
                "items": page_rows,
            })

    return Handler


def run(source_id, data_home):
    source = next(s for s in SOURCES if s["id"] == source_id)
    data_path = Path(__file__).with_name("sample_data.json")
    data = json.loads(data_path.read_text())
    state = QuotaState(source, data, Path(data_home) / f"{source_id}_quota.json")
    server = ThreadingHTTPServer(("127.0.0.1", source["port"]), make_handler(state))
    print(f"[{source_id}] 模拟来源已启动: http://127.0.0.1:{source['port']} "
          f"(额度 {source['capacity']} 次/轮, 暂停等待 {source['retry_after']}s)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    import sys
    from config import DATA_HOME
    sid = sys.argv[1] if len(sys.argv) > 1 else "source-a"
    home = sys.argv[2] if len(sys.argv) > 2 else str(DATA_HOME)
    run(sid, home)
