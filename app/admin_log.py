"""管理员日志。

对外响应不区分失败原因（见 http_server），但管理员日志会明确标出本次请求
是被哪一层限制拦下：``account``（账号窗口）或 ``source``（来源窗口），
两层同时命中时按检查顺序记录生效层。日志同时写 SQLite 表和本地日志文件。
"""
from __future__ import annotations

import json

from .clock import DemoClock
from .storage import Storage


class AdminLogger:
    def __init__(self, storage: Storage, clock: DemoClock, log_path: str) -> None:
        self._storage = storage
        self._clock = clock
        self._log_path = log_path

    def log(
        self,
        kind: str,
        username: str | None = None,
        source: str | None = None,
        layer: str | None = None,
        detail: str | None = None,
    ) -> None:
        ts = self._clock.now()
        with self._storage.lock:
            self._storage.conn.execute(
                "INSERT INTO admin_log(ts, kind, username, source, layer, detail) "
                "VALUES(?, ?, ?, ?, ?, ?)",
                (ts, kind, username, source, layer, detail),
            )
            self._storage.conn.commit()
        record = {
            "ts": ts,
            "kind": kind,
            "username": username,
            "source": source,
            "layer": layer,
            "detail": detail,
        }
        with open(self._log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

    def recent(self, limit: int = 100) -> list[dict]:
        rows = self._storage.conn.execute(
            "SELECT ts, kind, username, source, layer, detail "
            "FROM admin_log ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in reversed(rows)]
