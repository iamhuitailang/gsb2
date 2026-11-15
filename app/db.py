"""采集后台的 SQLite 存储层。

关键设计：
- reservations 以来源侧记录 id 为唯一键，INSERT OR IGNORE 保证同一页重拉不重复写入
- (venue_id, date) 上的唯一约束保证手动重跑与计划任务合用同一条采集任务
- 每页数据先落库（含 reservations），提交成功后才把页面/任务进度推进
"""
import sqlite3
import threading
import time

from config import COLLECTOR_DB, SOURCES, VENUE_SOURCE, VENUES


def now_ts():
    return time.time()


class Database:
    def __init__(self, db_path=COLLECTOR_DB):
        self.path = str(db_path)
        self.lock = threading.RLock()
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA busy_timeout=5000")
        self._init_schema()
        self._seed_sources()

    def _init_schema(self):
        with self.lock:
            self.conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS sources (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    base_url TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'idle',
                    next_request_at REAL,
                    last_error TEXT
                );

                CREATE TABLE IF NOT EXISTS jobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    venue_id TEXT NOT NULL,
                    venue_name TEXT NOT NULL,
                    date TEXT NOT NULL,
                    source_id TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',   -- pending/running/done/failed
                    total_pages INTEGER,
                    done_pages INTEGER NOT NULL DEFAULT 0,
                    triggers TEXT NOT NULL DEFAULT 'manual',
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    UNIQUE(venue_id, date)
                );

                CREATE TABLE IF NOT EXISTS pages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id INTEGER NOT NULL,
                    page_no INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',   -- pending/done
                    rows_written INTEGER NOT NULL DEFAULT 0,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    updated_at REAL,
                    UNIQUE(job_id, page_no),
                    FOREIGN KEY(job_id) REFERENCES jobs(id)
                );

                CREATE TABLE IF NOT EXISTS reservations (
                    record_id TEXT PRIMARY KEY,              -- 来源侧记录 id，幂等键
                    venue_id TEXT NOT NULL,
                    venue_name TEXT NOT NULL,
                    date TEXT NOT NULL,
                    source_id TEXT NOT NULL,
                    job_id INTEGER NOT NULL,
                    page_no INTEGER NOT NULL,
                    payload TEXT NOT NULL,
                    created_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS request_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_id TEXT NOT NULL,
                    venue_id TEXT,
                    date TEXT,
                    page_no INTEGER,
                    job_id INTEGER,
                    request_at REAL NOT NULL,
                    response_at REAL,
                    status_code INTEGER,
                    outcome TEXT NOT NULL,                   -- success/rate_limited/error
                    rows_written INTEGER NOT NULL DEFAULT 0,
                    retry_after REAL,
                    detail TEXT
                );

                CREATE TABLE IF NOT EXISTS schedules (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    venue_id TEXT NOT NULL,
                    date TEXT NOT NULL,
                    interval_seconds INTEGER NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    last_run_at REAL,
                    next_run_at REAL NOT NULL,
                    created_at REAL NOT NULL
                );
                """
            )
            self.conn.commit()

    def _seed_sources(self):
        from config import SOURCE_BASE_URL
        with self.lock:
            for s in SOURCES:
                self.conn.execute(
                    "INSERT INTO sources(id, name, base_url, status, next_request_at) "
                    "VALUES (?, ?, ?, 'idle', NULL) "
                    "ON CONFLICT(id) DO UPDATE SET name=excluded.name, base_url=excluded.base_url",
                    (s["id"], s["name"], SOURCE_BASE_URL[s["id"]]),
                )
            self.conn.commit()

    # ------------------------------------------------------------------ sources
    def update_source_state(self, source_id, status, next_request_at=None, last_error=None):
        with self.lock:
            self.conn.execute(
                "UPDATE sources SET status=?, next_request_at=?, last_error=? WHERE id=?",
                (status, next_request_at, last_error, source_id),
            )
            self.conn.commit()

    # --------------------------------------------------------------------- jobs
    def create_or_get_job(self, venue_id, date, trigger):
        """手动重跑 / 计划任务共用一个 (venue_id, date) 任务。

        返回 (job_row, created, merged)。已存在时把触发方式合并进 triggers。
        """
        source_id = VENUE_SOURCE[venue_id]
        venue_name = next(v["name"] for v in VENUES if v["id"] == venue_id)
        ts = now_ts()
        with self.lock:
            cur = self.conn.execute(
                "SELECT * FROM jobs WHERE venue_id=? AND date=?", (venue_id, date)
            )
            row = cur.fetchone()
            if row is not None:
                triggers = [t for t in (row["triggers"] or "").split(",") if t]
                if trigger not in triggers:
                    triggers.append(trigger)
                self.conn.execute(
                    "UPDATE jobs SET triggers=?, updated_at=? WHERE id=?",
                    (",".join(triggers), ts, row["id"]),
                )
                self.conn.commit()
                return self.get_job(row["id"]), False, True

            cur = self.conn.execute(
                "INSERT INTO jobs(venue_id, venue_name, date, source_id, status, "
                "total_pages, done_pages, triggers, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, 'pending', NULL, 0, ?, ?, ?)",
                (venue_id, venue_name, date, source_id, trigger, ts, ts),
            )
            self.conn.commit()
            return self.get_job(cur.lastrowid), True, False

    def reset_job_for_rerun(self, job_id):
        """手动重跑：页面状态回到 pending 重新拉取，但保留已入库记录。

        reservations 以 record_id 为幂等键，重拉时 INSERT OR IGNORE 跳过已有记录，
        因此从头重拉不会重复写入；抓取中途失败也不会丢掉已入库的数据。
        """
        with self.lock:
            self.conn.execute("DELETE FROM pages WHERE job_id=?", (job_id,))
            self.conn.execute(
                "UPDATE jobs SET status='pending', total_pages=NULL, done_pages=0, updated_at=? "
                "WHERE id=?",
                (now_ts(), job_id),
            )
            self.conn.commit()

    def get_job(self, job_id):
        with self.lock:
            row = self.conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            return dict(row) if row else None

    def find_job(self, venue_id, date):
        with self.lock:
            row = self.conn.execute(
                "SELECT * FROM jobs WHERE venue_id=? AND date=?", (venue_id, date)
            ).fetchone()
            return dict(row) if row else None

    def claim_pending_page(self, source_id):
        """按 FIFO 取出该来源下一个待拉页面（同来源任务串行，共享一份额度）。"""
        with self.lock:
            row = self.conn.execute(
                """
                SELECT p.*, j.venue_id, j.date, j.source_id
                FROM pages p JOIN jobs j ON j.id = p.job_id
                WHERE j.source_id=? AND p.status='pending' AND j.status IN ('pending','running')
                ORDER BY p.job_id, p.page_no
                LIMIT 1
                """,
                (source_id,),
            ).fetchone()
            if row is None:
                return None
            job = self.conn.execute(
                "SELECT * FROM jobs WHERE id=?", (row["job_id"],)
            ).fetchone()
            if job["status"] == "pending":
                self.conn.execute(
                    "UPDATE jobs SET status='running', updated_at=? WHERE id=?",
                    (now_ts(), row["job_id"]),
                )
                self.conn.commit()
            return dict(row)

    def has_pending_work(self, source_id):
        with self.lock:
            row = self.conn.execute(
                """
                SELECT 1 FROM pages p JOIN jobs j ON j.id = p.job_id
                WHERE j.source_id=? AND p.status='pending'
                  AND j.status IN ('pending','running')
                LIMIT 1
                """,
                (source_id,),
            ).fetchone()
            return row is not None

    def ensure_first_page(self, job_id):
        """任务创建后先挂上第 1 页；后续页由第 1 页响应里的 has_next 动态发现。"""
        with self.lock:
            exists = self.conn.execute(
                "SELECT 1 FROM pages WHERE job_id=? AND page_no=1", (job_id,)
            ).fetchone()
            if not exists:
                self.conn.execute(
                    "INSERT INTO pages(job_id, page_no, status, attempt_count) VALUES (?, 1, 'pending', 0)",
                    (job_id,),
                )
                self.conn.commit()

    def mark_page_attempt(self, page_id):
        with self.lock:
            self.conn.execute(
                "UPDATE pages SET attempt_count=attempt_count+1 WHERE id=?", (page_id,)
            )
            self.conn.commit()

    def complete_page(self, job_id, page_id, page_no, total_pages, records, source_id):
        """一页的数据整体落库；提交成功后才更新页面与任务进度。

        返回实际新写入的记录数（重拉同一页时为 0，不会重复）。
        """
        import json
        ts = now_ts()
        with self.lock:
            written = 0
            for rec in records:
                cur = self.conn.execute(
                    "INSERT OR IGNORE INTO reservations(record_id, venue_id, venue_name, "
                    "date, source_id, job_id, page_no, payload, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        rec["id"], rec["venue_id"], rec.get("venue_name", ""),
                        rec["date"], source_id, job_id, page_no,
                        json.dumps(rec, ensure_ascii=False), ts,
                    ),
                )
                written += cur.rowcount

            self.conn.execute(
                "UPDATE pages SET status='done', rows_written=?, updated_at=? WHERE id=?",
                (written, ts, page_id),
            )
            done = self.conn.execute(
                "SELECT COUNT(*) AS c FROM pages WHERE job_id=? AND status='done'", (job_id,)
            ).fetchone()["c"]
            self.conn.execute(
                "UPDATE jobs SET status=CASE WHEN ? >= ? THEN 'done' ELSE 'running' END, "
                "total_pages=?, done_pages=?, updated_at=? WHERE id=?",
                (done, total_pages, total_pages, done, ts, job_id),
            )
            self.conn.commit()
            return written

    def ensure_next_page(self, job_id, next_page_no, total_pages):
        """根据 has_next 挂上后续页；已存在（重拉场景）则不动。"""
        with self.lock:
            self.conn.execute(
                "INSERT INTO pages(job_id, page_no, status, attempt_count) "
                "VALUES (?, ?, 'pending', 0) ON CONFLICT(job_id, page_no) DO NOTHING",
                (job_id, next_page_no),
            )
            self.conn.execute(
                "UPDATE jobs SET total_pages=? WHERE id=? AND total_pages IS NULL",
                (total_pages, job_id),
            )
            self.conn.commit()

    def list_pages(self, job_id):
        with self.lock:
            rows = self.conn.execute(
                "SELECT * FROM pages WHERE job_id=? ORDER BY page_no", (job_id,)
            ).fetchall()
            return [dict(r) for r in rows]

    def count_reservations(self, venue_id, date):
        with self.lock:
            return self.conn.execute(
                "SELECT COUNT(*) AS c FROM reservations WHERE venue_id=? AND date=?",
                (venue_id, date),
            ).fetchone()["c"]

    # -------------------------------------------------------------------- logs
    def add_request_log(self, **kw):
        with self.lock:
            self.conn.execute(
                "INSERT INTO request_logs(source_id, venue_id, date, page_no, job_id, "
                "request_at, response_at, status_code, outcome, rows_written, retry_after, detail) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    kw.get("source_id"), kw.get("venue_id"), kw.get("date"),
                    kw.get("page_no"), kw.get("job_id"), kw["request_at"],
                    kw.get("response_at"), kw.get("status_code"), kw["outcome"],
                    kw.get("rows_written", 0), kw.get("retry_after"), kw.get("detail"),
                ),
            )
            self.conn.commit()

    def list_logs(self, source_id=None, limit=200):
        with self.lock:
            if source_id:
                rows = self.conn.execute(
                    "SELECT * FROM request_logs WHERE source_id=? ORDER BY id DESC LIMIT ?",
                    (source_id, limit),
                ).fetchall()
            else:
                rows = self.conn.execute(
                    "SELECT * FROM request_logs ORDER BY id DESC LIMIT ?", (limit,)
                ).fetchall()
            return [dict(r) for r in rows]

    # --------------------------------------------------------------- schedules
    def add_schedule(self, venue_id, date, interval_seconds):
        ts = now_ts()
        with self.lock:
            cur = self.conn.execute(
                "INSERT INTO schedules(venue_id, date, interval_seconds, enabled, "
                "last_run_at, next_run_at, created_at) VALUES (?, ?, ?, 1, NULL, ?, ?)",
                (venue_id, date, interval_seconds, ts + interval_seconds, ts),
            )
            self.conn.commit()
            return cur.lastrowid

    def list_schedules(self):
        with self.lock:
            rows = self.conn.execute("SELECT * FROM schedules ORDER BY id").fetchall()
            return [dict(r) for r in rows]

    def set_schedule_enabled(self, schedule_id, enabled):
        with self.lock:
            self.conn.execute(
                "UPDATE schedules SET enabled=?, next_run_at=? WHERE id=?",
                (1 if enabled else 0, now_ts(), schedule_id),
            )
            self.conn.commit()

    def due_schedules(self):
        with self.lock:
            rows = self.conn.execute(
                "SELECT * FROM schedules WHERE enabled=1 AND next_run_at<=?", (now_ts(),)
            ).fetchall()
            return [dict(r) for r in rows]

    def touch_schedule(self, schedule_id):
        ts = now_ts()
        with self.lock:
            self.conn.execute(
                "UPDATE schedules SET last_run_at=?, next_run_at=? WHERE id=?",
                (ts, ts + self.conn.execute(
                    "SELECT interval_seconds AS v FROM schedules WHERE id=?", (schedule_id,)
                ).fetchone()["v"], schedule_id),
            )
            self.conn.commit()

    # ------------------------------------------------------------------ snapshot
    def snapshot(self):
        """给调度页面用的全量状态。"""
        with self.lock:
            sources = [dict(r) for r in self.conn.execute(
                "SELECT * FROM sources ORDER BY id").fetchall()]
            jobs = [dict(r) for r in self.conn.execute(
                "SELECT * FROM jobs ORDER BY id DESC").fetchall()]
            schedules = [dict(r) for r in self.conn.execute(
                "SELECT * FROM schedules ORDER BY id").fetchall()]
            pages_by_job = {}
            for r in self.conn.execute("SELECT * FROM pages ORDER BY job_id, page_no").fetchall():
                pages_by_job.setdefault(r["job_id"], []).append(dict(r))
            for j in jobs:
                j["pages"] = pages_by_job.get(j["id"], [])
                j["reservation_count"] = self.conn.execute(
                    "SELECT COUNT(*) AS c FROM reservations WHERE venue_id=? AND date=?",
                    (j["venue_id"], j["date"]),
                ).fetchone()["c"]
            return {
                "server_time": now_ts(),
                "sources": sources,
                "jobs": jobs,
                "schedules": schedules,
                "venues": VENUES,
            }

    def close(self):
        with self.lock:
            self.conn.close()
