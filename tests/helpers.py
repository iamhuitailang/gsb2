"""测试公共工具：每个用例独立临时数据库，互不污染。"""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from secbench import ingestion, rules, storage  # noqa: E402


class TempDB:
    def __init__(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "test_secbench.db")
        os.environ["SECBENCH_DB"] = self.path
        self.conn: sqlite3.Connection = storage.connect(self.path)
        storage.init_db(self.conn)

    def close(self) -> None:
        self.conn.close()
        self.tmp.cleanup()
        os.environ.pop("SECBENCH_DB", None)

    def import_text(self, text: str, filename: str = "t.jsonl") -> dict:
        return ingestion.import_jsonl_bytes(self.conn, text.encode("utf-8"), filename)

    def evaluate(self) -> list[dict]:
        return rules.evaluate(self.conn)

    def alerts(self, **filters) -> list[sqlite3.Row]:
        return storage.list_alerts(self.conn, **filters)

    def events(self) -> list[sqlite3.Row]:
        return storage.all_event_rows(self.conn)
