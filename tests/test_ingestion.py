"""导入层测试：乱序、重复、冲突编号、坏行、限额与时间规范化。"""
from __future__ import annotations

import unittest

from secbench import storage
from secbench.ingestion import ImportRejected

from helpers import TempDB

BASE = (
    '{"source": "auth", "event_id": "A1", "event_time": "2026-11-18T09:00:00Z",'
    ' "subject": "u1", "src_ip": "10.0.0.1", "action": "login",'
    ' "target": "sso", "result": "failure"}'
)


class IngestionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.db = TempDB()

    def tearDown(self) -> None:
        self.db.close()

    def test_out_of_order_events_accepted_and_sorted_by_time(self) -> None:
        lines = [
            BASE.replace("A1", "A3").replace("09:00:00", "09:02:00"),
            BASE.replace("A1", "A1"),
            BASE.replace("A1", "A2").replace("09:00:00", "09:01:00"),
        ]
        result = self.db.import_text("\n".join(lines))
        self.assertEqual(result["counts"]["accepted"], 3)
        times = [e["event_id"] for e in self.db.events()]
        self.assertEqual(times, ["A1", "A2", "A3"])  # 按事件时间排序，与导入顺序无关

    def test_exact_duplicate_counted_once(self) -> None:
        first = self.db.import_text(BASE)
        second = self.db.import_text(BASE)
        self.assertEqual(first["counts"]["accepted"], 1)
        self.assertEqual(second["counts"]["accepted"], 0)
        self.assertEqual(second["counts"]["duplicate"], 1)
        self.assertEqual(len(self.db.events()), 1)  # 只计一次

    def test_duplicate_with_different_field_order_same_content(self) -> None:
        shuffled = (
            '{"result": "failure", "target": "sso", "action": "login",'
            ' "src_ip": "10.0.0.1", "subject": "u1",'
            ' "event_time": "2026-11-18T09:00:00Z", "event_id": "A1", "source": "auth"}'
        )
        self.db.import_text(BASE)
        result = self.db.import_text(shuffled)
        self.assertEqual(result["counts"]["duplicate"], 1)
        self.assertEqual(len(self.db.events()), 1)

    def test_conflicting_event_id_quarantined_not_overwritten(self) -> None:
        self.db.import_text(BASE)
        conflict = BASE.replace('"result": "failure"', '"result": "success"')
        result = self.db.import_text(conflict)
        self.assertEqual(result["counts"]["quarantined"], 1)
        self.assertEqual(result["counts"]["accepted"], 0)
        stored = self.db.events()[0]
        self.assertEqual(stored["result"], "failure")  # 原记录未被覆盖
        q = storage.list_quarantined(self.db.conn)
        self.assertEqual(len(q), 1)
        self.assertIn("内容不同", q[0]["reason"])

    def test_conflict_then_same_conflict_again_is_duplicate(self) -> None:
        self.db.import_text(BASE)
        conflict = BASE.replace('"result": "failure"', '"result": "success"')
        first = self.db.import_text(conflict)
        second = self.db.import_text(conflict)
        self.assertEqual(first["counts"]["quarantined"], 1)
        self.assertEqual(second["counts"]["duplicate"], 1)
        self.assertEqual(len(storage.list_quarantined(self.db.conn)), 1)

    def test_bad_lines_produce_row_level_errors(self) -> None:
        payload = "\n".join([
            "not json",
            '{"source": "auth", "event_id": "B1", "event_time": "bad-time",'
            ' "subject": "u", "src_ip": "1.1.1.1", "action": "login",'
            ' "target": "sso", "result": "failure"}',
            '{"source": "unknown", "event_id": "B2", "event_time": "2026-11-18T09:00:00Z",'
            ' "subject": "u", "src_ip": "1.1.1.1", "action": "login",'
            ' "target": "sso", "result": "failure"}',
            '{"source": "auth", "event_id": "B3", "event_time": "2026-11-18T09:00:00Z",'
            ' "src_ip": "1.1.1.1", "action": "login", "target": "sso", "result": "failure"}',
            BASE.replace("A1", "GOOD"),
        ])
        result = self.db.import_text(payload)
        self.assertEqual(result["counts"]["error"], 4)
        self.assertEqual(result["counts"]["accepted"], 1)
        reasons = [e["reason"] for e in storage.list_row_errors(self.db.conn)]
        self.assertTrue(any("JSON 解析失败" in r for r in reasons))
        self.assertTrue(any("无效时间" in r for r in reasons))
        self.assertTrue(any("未知来源" in r for r in reasons))
        self.assertTrue(any("缺少必填字段" in r for r in reasons))

    def test_failed_import_keeps_previous_data(self) -> None:
        self.db.import_text(BASE)
        storage.update_settings(self.db.conn, {"max_import_events": 5})
        oversized = "\n".join(BASE.replace("A1", f"X{i}") for i in range(6))
        with self.assertRaises(ImportRejected):
            self.db.import_text(oversized)
        self.assertEqual(len(self.db.events()), 1)  # 上次数据原样保留
        batches = storage.list_imports(self.db.conn)
        self.assertTrue(any(b["rejected_reason"] for b in batches))

    def test_size_limit_rejects_whole_batch(self) -> None:
        storage.update_settings(self.db.conn, {"max_import_bytes": 100})
        with self.assertRaises(ImportRejected):
            self.db.import_text(BASE)
        self.assertEqual(len(self.db.events()), 0)

    def test_event_count_limit_rejects_whole_batch(self) -> None:
        storage.update_settings(self.db.conn, {"max_import_events": 2})
        lines = [BASE.replace("A1", f"A{i}") for i in range(3)]
        with self.assertRaises(ImportRejected):
            self.db.import_text("\n".join(lines))
        self.assertEqual(len(self.db.events()), 0)

    def test_time_normalized_to_utc_z_format(self) -> None:
        def t(eid, ts):
            return BASE.replace("A1", eid).replace("2026-11-18T09:00:00Z", ts)
        variants = [
            t("T1", "2026-11-18T09:00:00+00:00"),
            t("T2", "2026-11-18T10:00:00+01:00"),
            t("T3", "2026-11-18T11:00:00"),
        ]
        self.db.import_text("\n".join(variants))
        normalized = {e["event_id"]: e["event_time"] for e in self.db.events()}
        self.assertEqual(normalized["T1"], "2026-11-18T09:00:00Z")
        self.assertEqual(normalized["T2"], "2026-11-18T09:00:00Z")  # +01:00 换算为 UTC
        self.assertEqual(normalized["T3"], "2026-11-18T11:00:00Z")  # 无时区按 UTC 解释

    def test_blank_lines_ignored(self) -> None:
        result = self.db.import_text(f"\n{BASE}\n\n   \n")
        self.assertEqual(result["counts"]["total"], 1)
        self.assertEqual(result["counts"]["accepted"], 1)

    def test_raw_line_preserved(self) -> None:
        self.db.import_text(BASE)
        self.assertEqual(self.db.events()[0]["raw_line"], BASE)


if __name__ == "__main__":
    unittest.main()
