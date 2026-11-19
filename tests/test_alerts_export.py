"""告警处置、筛选、导出与规则版本测试。"""
from __future__ import annotations

import json
import unittest

from secbench import export as export_mod
from secbench import storage

from helpers import TempDB


def make_r1_alert(db: TempDB) -> int:
    lines = "\n".join([
        '{"source": "auth", "event_id": "A1", "event_time": "2026-11-18T09:00:00Z",'
        ' "subject": "u1", "src_ip": "9.9.9.9", "action": "login", "target": "sso", "result": "failure"}',
        '{"source": "auth", "event_id": "A2", "event_time": "2026-11-18T09:00:20Z",'
        ' "subject": "u2", "src_ip": "9.9.9.9", "action": "login", "target": "sso", "result": "failure"}',
        '{"source": "auth", "event_id": "A3", "event_time": "2026-11-18T09:00:40Z",'
        ' "subject": "u3", "src_ip": "9.9.9.9", "action": "login", "target": "sso", "result": "failure"}',
        '{"source": "auth", "event_id": "A4", "event_time": "2026-11-18T09:01:00Z",'
        ' "subject": "u1", "src_ip": "9.9.9.9", "action": "login", "target": "sso", "result": "success"}',
        '{"source": "proxy", "event_id": "P1", "event_time": "2026-11-18T10:00:00Z",'
        ' "subject": "anon", "src_ip": "8.8.8.8", "action": "path_scan", "target": "/.git", "result": "404"}',
        '{"source": "proxy", "event_id": "P2", "event_time": "2026-11-18T10:02:00Z",'
        ' "subject": "anon", "src_ip": "8.8.8.8", "action": "GET", "target": "/admin", "result": "200"}',
    ])
    db.import_text(lines)
    db.evaluate()
    return next(a for a in db.alerts() if a["rule_id"] == "R1_BRUTE_FORCE")["id"]


class AlertWorkflowTest(unittest.TestCase):
    def setUp(self) -> None:
        self.db = TempDB()
        self.alert_id = make_r1_alert(self.db)

    def tearDown(self) -> None:
        self.db.close()

    def test_status_transitions_and_note_persist(self) -> None:
        for status, note in [
            ("confirmed", "确认是撞库"),
            ("false_positive", "压力测试流量，误报"),
            ("open", "重新打开继续观察"),
        ]:
            row = storage.set_alert_status(self.db.conn, self.alert_id, status, note)
            self.assertEqual(row["status"], status)
            self.assertEqual(row["disposition_note"], note)

    def test_invalid_status_rejected(self) -> None:
        with self.assertRaises(ValueError):
            storage.set_alert_status(self.db.conn, self.alert_id, "hacked", "x")

    def test_filters_by_severity_status_source_subject(self) -> None:
        storage.set_alert_status(self.db.conn, self.alert_id, "confirmed", "ok")
        self.assertEqual(len(storage.list_alerts(self.db.conn, severity="high")), 1)
        self.assertEqual(len(storage.list_alerts(self.db.conn, severity="medium")), 1)
        self.assertEqual(len(storage.list_alerts(self.db.conn, status="confirmed")), 1)
        self.assertEqual(len(storage.list_alerts(self.db.conn, status="open")), 1)
        self.assertEqual(len(storage.list_alerts(self.db.conn, source="proxy")), 1)
        self.assertEqual(len(storage.list_alerts(self.db.conn, source="auth")), 1)
        self.assertEqual(len(storage.list_alerts(self.db.conn, subject="u1")), 1)
        self.assertEqual(len(storage.list_alerts(self.db.conn, subject="nobody")), 0)

    def test_time_range_filter(self) -> None:
        hits = storage.list_alerts(
            self.db.conn,
            time_from="2026-11-18T09:30:00Z",
            time_to="2026-11-18T10:30:00Z",
        )
        self.assertEqual(len(hits), 1)  # 只覆盖 R2
        none = storage.list_alerts(
            self.db.conn, time_from="2026-11-19T00:00:00Z"
        )
        self.assertEqual(none, [])

    def test_export_payload_contains_version_judgement_evidence_and_raw(self) -> None:
        storage.set_alert_status(self.db.conn, self.alert_id, "confirmed", "说明文字")
        alerts = storage.list_alerts(self.db.conn)
        payload = export_mod.build_export_payload(self.db.conn, alerts)
        self.assertEqual(payload["engine_rule_version"], storage.RULE_VERSION)
        target = next(a for a in payload["alerts"] if a["alert_id"] == self.alert_id)
        self.assertEqual(target["rule_version"], storage.RULE_VERSION)
        self.assertIn("关联依据", target["rationale"])
        self.assertEqual(target["status_label"], "已确认")
        self.assertEqual(len(target["evidence"]), 4)  # 3 条失败 + 1 条成功
        # 证据按事件时间升序，含编号与原始记录，可与页面逐条核对
        times = [e["event_time"] for e in target["evidence"]]
        self.assertEqual(times, sorted(times))
        for ev in target["evidence"]:
            self.assertTrue(ev["event_id"])
            self.assertIsInstance(ev["raw_record"], dict)
            self.assertEqual(ev["raw_record"]["event_id"], ev["event_id"])
        jsonl = export_mod.to_jsonl_text(payload)
        self.assertEqual(len([ln for ln in jsonl.splitlines() if ln.strip()]), len(payload["alerts"]))
        for line in jsonl.splitlines():
            json.loads(line)  # 每行都是合法 JSON

    def test_export_respects_current_filter(self) -> None:
        only_high = storage.list_alerts(self.db.conn, severity="high")
        payload = export_mod.build_export_payload(self.db.conn, only_high)
        self.assertEqual(payload["alert_count"], 1)
        self.assertTrue(all(a["severity"] == "high" for a in payload["alerts"]))

    def test_reset_clears_everything(self) -> None:
        storage.reset_all(self.db.conn)
        self.assertEqual(storage.all_event_rows(self.db.conn), [])
        self.assertEqual(storage.list_alerts(self.db.conn), [])
        self.assertEqual(storage.list_imports(self.db.conn), [])
        # 设置项恢复默认
        self.assertEqual(storage.get_settings(self.db.conn)["r1_fail_threshold"], 3)


if __name__ == "__main__":
    unittest.main()
