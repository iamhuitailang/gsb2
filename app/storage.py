"""SQLite 存储层。

只负责连接与建表；限流的判定与计数由 :mod:`app.rate_limit` 在一把进程内
互斥锁内完成，SQLite 的单事务 + 进程锁共同保证并发请求不会重复计数。
所有时间戳都存为整数秒，窗口截止时间落库，服务重启后仍按原截止时间判断。
"""
from __future__ import annotations

import os
import sqlite3
import threading
from contextlib import contextmanager
from typing import Iterator


SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    username   TEXT PRIMARY KEY,
    salt       TEXT NOT NULL,
    pwd_hash   TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS failure_counters (
    scope      TEXT NOT NULL,           -- 'account' | 'source'
    key        TEXT NOT NULL,           -- account: 用户名；source: 来源标识
    failures   INTEGER NOT NULL,
    deadline   INTEGER NOT NULL,       -- 该窗口的截止时间（演示时钟秒）
    PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS kv (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    kind      TEXT NOT NULL,
    username  TEXT,
    source    TEXT,
    layer     TEXT,
    detail    TEXT
);
"""


class Storage:
    def __init__(self, db_path: str) -> None:
        os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
        self.db_path = db_path
        # check_same_thread=False：连接由上层互斥锁串行化使用
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        # 写操作立即落盘，保证重启后计数与截止时间仍在
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=FULL")
        self._lock = threading.RLock()
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    @property
    def lock(self) -> threading.RLock:
        return self._lock

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """在进程锁内开启一个即时事务；异常回滚，正常提交。"""
        with self._lock:
            try:
                self._conn.execute("BEGIN IMMEDIATE")
                yield self._conn
            except Exception:
                self._conn.rollback()
                raise
            else:
                self._conn.commit()

    @property
    def conn(self) -> sqlite3.Connection:
        return self._conn

    def close(self) -> None:
        with self._lock:
            self._conn.close()
