"""采集调度器。

- 每个来源一个 worker 线程：同来源的分页任务串行执行，共用该来源的一份额度
- 收到 429 时按响应里的等待时间把该来源重新排队（backoff），期间另一个来源的 worker 继续拉
- 计划任务与手动重跑通过 (venue_id, date) 唯一键合用同一条采集任务
"""
import threading
import time

from client import fetch_page
from config import ERROR_RETRY_SECONDS, SOURCES
from db import Database


class Scheduler:
    def __init__(self, db: Database):
        self.db = db
        self._stop = threading.Event()
        self._threads = []
        # 各来源的下一次可请求时间（内存态；重启后未完成任务仍在库里，worker 会继续）
        self._next_request_at = {s["id"]: 0.0 for s in SOURCES}

    def start(self):
        for source in SOURCES:
            t = threading.Thread(
                target=self._source_worker, args=(source["id"],),
                name=f"worker-{source['id']}", daemon=True,
            )
            t.start()
            self._threads.append(t)
        ticker = threading.Thread(target=self._schedule_loop, name="schedule-ticker", daemon=True)
        ticker.start()
        self._threads.append(ticker)

    def stop(self):
        self._stop.set()

    # ------------------------------------------------------------- source worker
    def _sleep(self, seconds):
        self._stop.wait(timeout=min(seconds, 0.5))

    def _source_worker(self, source_id):
        base_url = self._base_url(source_id)
        while not self._stop.is_set():
            page = self.db.claim_pending_page(source_id)
            if page is None:
                self.db.update_source_state(source_id, "idle", None)
                self._sleep(0.5)
                continue

            # 该来源处于 429 暂停期：让出线程，另一来源的 worker 不受影响
            wait = self._next_request_at[source_id] - time.time()
            if wait > 0:
                self.db.update_source_state(
                    source_id, "backoff", self._next_request_at[source_id]
                )
                self._sleep(wait)
                if self._stop.is_set():
                    return
                continue

            self.db.update_source_state(source_id, "running", time.time())
            self.db.mark_page_attempt(page["id"])
            result = fetch_page(
                base_url, source_id, page["venue_id"], page["date"], page["page_no"]
            )

            if result.status_code == 429:
                # 按响应里的等待时间重新排队本来源
                self._next_request_at[source_id] = time.time() + (result.retry_after or 5)
                self.db.update_source_state(
                    source_id, "backoff", self._next_request_at[source_id]
                )
                self.db.add_request_log(
                    source_id=source_id, venue_id=page["venue_id"], date=page["date"],
                    page_no=page["page_no"], job_id=page["job_id"],
                    request_at=result.request_at, response_at=result.response_at,
                    status_code=429, outcome="rate_limited",
                    retry_after=result.retry_after, detail=result.error,
                )
                continue

            if not result.ok:
                self._next_request_at[source_id] = time.time() + ERROR_RETRY_SECONDS
                self.db.update_source_state(
                    source_id, "error", self._next_request_at[source_id], result.error
                )
                self.db.add_request_log(
                    source_id=source_id, venue_id=page["venue_id"], date=page["date"],
                    page_no=page["page_no"], job_id=page["job_id"],
                    request_at=result.request_at, response_at=result.response_at,
                    status_code=result.status_code, outcome="error", detail=result.error,
                )
                self._sleep(ERROR_RETRY_SECONDS)
                continue

            data = result.data
            total_pages = max(1, (data["total"] + data["page_size"] - 1) // data["page_size"])

            if data.get("has_next"):
                self.db.ensure_next_page(page["job_id"], page["page_no"] + 1, total_pages)

            # 先把这一页数据写完并提交，再更新页面/任务进度
            written = self.db.complete_page(
                page["job_id"], page["id"], page["page_no"], total_pages,
                data.get("items", []), source_id,
            )
            self.db.add_request_log(
                source_id=source_id, venue_id=page["venue_id"], date=page["date"],
                page_no=page["page_no"], job_id=page["job_id"],
                request_at=result.request_at, response_at=result.response_at,
                status_code=result.status_code, outcome="success",
                rows_written=written,
                detail=f"本页 {len(data.get('items', []))} 条，新写入 {written} 条",
            )
            self.db.update_source_state(source_id, "idle", None)

    # ------------------------------------------------------------- schedule ticker
    def _schedule_loop(self):
        while not self._stop.is_set():
            try:
                for sch in self.db.due_schedules():
                    job, _created, _merged = self.db.create_or_get_job(
                        sch["venue_id"], sch["date"], "scheduled"
                    )
                    self.db.ensure_first_page(job["id"])
                    self.db.touch_schedule(sch["id"])
            except Exception as e:  # 计划任务异常不应杀死 ticker
                print(f"[scheduler] schedule tick error: {e}")
            self._sleep(0.5)

    def _base_url(self, source_id):
        row = self.db.conn.execute(
            "SELECT base_url FROM sources WHERE id=?", (source_id,)
        ).fetchone()
        return row["base_url"]
