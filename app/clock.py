"""演示时钟。

页面与本地测试入口可以把时钟整体推进/回拨；偏移量持久化在 kv 表中，
服务重启后「现在」依旧是被推进后的时间，因此窗口截止时间判断不受重启影响。
时间全部为整数秒。
"""
from __future__ import annotations

import time
from typing import Callable

from .storage import Storage

_OFFSET_KEY = "clock_offset_seconds"


class DemoClock:
    def __init__(self, storage: Storage, time_func: Callable[[], float] | None = None) -> None:
        self._storage = storage
        # 生产环境用墙钟；测试可注入冻结/可控时间源，避免窗口在断言中途自然过期
        self._time_func = time_func or time.time
        row = storage.conn.execute("SELECT v FROM kv WHERE k = ?", (_OFFSET_KEY,)).fetchone()
        self._offset = int(row["v"]) if row else 0

    def now(self) -> int:
        return int(self._time_func()) + self._offset

    def advance(self, seconds: int) -> int:
        """把演示时钟推进（正数）或回拨（负数）若干秒，返回新的当前时间。"""
        with self._storage.lock:
            self._offset += int(seconds)
            self._storage.conn.execute(
                "INSERT INTO kv(k, v) VALUES(?, ?) "
                "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                (_OFFSET_KEY, str(self._offset)),
            )
            self._storage.conn.commit()
        return self.now()

    def reset(self) -> int:
        """时钟归零（偏移清零），不影响任何失败计数与截止时间。"""
        with self._storage.lock:
            self._offset = 0
            self._storage.conn.execute("DELETE FROM kv WHERE k = ?", (_OFFSET_KEY,))
            self._storage.conn.commit()
        return self.now()
