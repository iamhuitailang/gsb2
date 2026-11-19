"""规则引擎测试：三类关联、时间边界、迟到事件、重复导入不产生重复告警。"""
from __future__ import annotations

import json
import unittest

from secbench import storage

from helpers import TempDB


def rec(source, event_id, ts, subject, src_ip, action, target, result):
    return json.dumps({
        "source": source, "event_id": event_id, "event_time": ts,
        "subject": subject, "src_ip": src_ip, "action": action,
        "target": target, "result": result,
    }, ensure_ascii=False)


def auth(eid, ts, subject, ip, result):
    return rec("auth", eid, ts, subject, ip, "login", "sso", result)


def proxy(eid, ts, ip, action, target, result, subject="anonymous"):
    return rec("proxy", eid, ts, subject, ip, action, target, result)


def ep(eid, ts, subject, ip, action, target):
    return rec("endpoint", eid, ts, subject, ip, action, target, "success")


class Rule1Test(unittest.TestCase):
    def setUp(self) -> None:
        self.db = TempDB()

    def tearDown(self) -> None:
        self.db.close()

    def _brute_lines(self, fail_ts, success_ts):
        return "\n".join([
            auth("A1", fail_ts[0], "u1", "9.9.9.9", "failure"),
            auth("A2", fail_ts[1], "u2", "9.9.9.9", "failure"),
            auth("A3", fail_ts[2], "u3", "9.9.9.9", "failure"),
            auth("A4", success_ts, "u1", "9.9.9.9", "success"),
        ])

    def test_alert_when_three_distinct_accounts_then_success(self) -> None:
        self.db.import_text(self._brute_lines(
            ["2026-11-18T09:00:00Z", "2026-11-18T09:00:20Z", "2026-11-18T09:00:40Z"],
            "2026-11-18T09:01:00Z",
        ))
        self.db.evaluate()
        r1 = [a for a in self.db.alerts() if a["rule_id"] == "R1_BRUTE_FORCE"]
        self.assertEqual(len(r1), 1)
        self.assertEqual(r1[0]["severity"], "high")
        evidence = storage.alert_evidence(self.db.conn, r1[0]["id"])
        self.assertEqual(len(evidence), 4)
        self.assertEqual([e["event_time"] for e in evidence], sorted(e["event_time"] for e in evidence))

    def test_single_failure_does_not_alert(self) -> None:
        self.db.import_text(auth("A1", "2026-11-18T09:00:00Z", "u1", "9.9.9.9", "failure"))
        self.db.evaluate()
        self.assertEqual(self.db.alerts(), [])

    def test_failures_without_success_do_not_alert(self) -> None:
        lines = "\n".join(auth(f"A{i}", f"2026-11-18T09:00:0{i}Z", f"u{i}", "9.9.9.9", "failure")
                          for i in range(4))
        self.db.import_text(lines)
        self.db.evaluate()
        self.assertEqual([a for a in self.db.alerts() if a["rule_id"] == "R1_BRUTE_FORCE"], [])

    def test_same_account_failures_below_distinct_threshold_do_not_alert(self) -> None:
        lines = "\n".join([
            auth("A1", "2026-11-18T09:00:00Z", "u1", "9.9.9.9", "failure"),
            auth("A2", "2026-11-18T09:00:10Z", "u1", "9.9.9.9", "failure"),
            auth("A3", "2026-11-18T09:00:20Z", "u1", "9.9.9.9", "failure"),
            auth("A4", "2026-11-18T09:00:30Z", "u1", "9.9.9.9", "success"),
        ])
        self.db.import_text(lines)
        self.db.evaluate()
        self.assertEqual([a for a in self.db.alerts() if a["rule_id"] == "R1_BRUTE_FORCE"], [])

    def test_boundary_success_exactly_at_window_edge_included(self) -> None:
        # 默认 r1_window_seconds=600：成功时刻与最早失败相隔恰好 600s，闭区间应命中
        lines = "\n".join([
            auth("A1", "2026-11-18T09:00:00Z", "u1", "9.9.9.9", "failure"),
            auth("A2", "2026-11-18T09:05:00Z", "u2", "9.9.9.9", "failure"),
            auth("A3", "2026-11-18T09:08:00Z", "u3", "9.9.9.9", "failure"),
            auth("A4", "2026-11-18T09:10:00Z", "u1", "9.9.9.9", "success"),
        ])
        self.db.import_text(lines)
        self.db.evaluate()
        self.assertEqual(len([a for a in self.db.alerts() if a["rule_id"] == "R1_BRUTE_FORCE"]), 1)

    def test_success_too_late_does_not_alert(self) -> None:
        lines = "\n".join([
            auth("A1", "2026-11-18T09:00:00Z", "u1", "9.9.9.9", "failure"),
            auth("A2", "2026-11-18T09:00:20Z", "u2", "9.9.9.9", "failure"),
            auth("A3", "2026-11-18T09:00:40Z", "u3", "9.9.9.9", "failure"),
            auth("A4", "2026-11-18T09:20:00Z", "u1", "9.9.9.9", "success"),
        ])
        self.db.import_text(lines)
        self.db.evaluate()
        self.assertEqual([a for a in self.db.alerts() if a["rule_id"] == "R1_BRUTE_FORCE"], [])

    def test_threshold_configurable(self) -> None:
        storage.update_settings(self.db.conn, {"r1_fail_threshold": 2})
        lines = "\n".join([
            auth("A1", "2026-11-18T09:00:00Z", "u1", "9.9.9.9", "failure"),
            auth("A2", "2026-11-18T09:00:20Z", "u2", "9.9.9.9", "failure"),
            auth("A3", "2026-11-18T09:00:40Z", "u1", "9.9.9.9", "success"),
        ])
        self.db.import_text(lines)
        self.db.evaluate()
        self.assertEqual(len([a for a in self.db.alerts() if a["rule_id"] == "R1_BRUTE_FORCE"]), 1)


class Rule2Test(unittest.TestCase):
    def setUp(self) -> None:
        self.db = TempDB()

    def tearDown(self) -> None:
        self.db.close()

    def test_probe_then_sensitive_access_alerts(self) -> None:
        lines = "\n".join([
            proxy("P1", "2026-11-18T10:00:00Z", "8.8.8.8", "path_scan", "/.git/config", "404"),
            proxy("P2", "2026-11-18T10:02:00Z", "8.8.8.8", "GET", "/admin/users", "200"),
            proxy("P3", "2026-11-18T10:04:00Z", "8.8.8.8", "GET", "/api/internal/tokens", "500"),
        ])
        self.db.import_text(lines)
        self.db.evaluate()
        r2 = [a for a in self.db.alerts() if a["rule_id"] == "R2_PROBE_THEN_ACCESS"]
        self.assertEqual(len(r2), 1)
        self.assertEqual(r2[0]["severity"], "medium")

    def test_lone_404_does_not_alert(self) -> None:
        self.db.import_text(proxy("P1", "2026-11-18T10:00:00Z", "8.8.8.8", "GET", "/nope", "404"))
        self.db.evaluate()
        self.assertEqual([a for a in self.db.alerts() if a["rule_id"] == "R2_PROBE_THEN_ACCESS"], [])

    def test_followup_outside_window_does_not_alert(self) -> None:
        lines = "\n".join([
            proxy("P1", "2026-11-18T10:00:00Z", "8.8.8.8", "path_scan", "/.git/config", "404"),
            proxy("P2", "2026-11-18T10:20:00Z", "8.8.8.8", "GET", "/admin/users", "200"),
        ])
        self.db.import_text(lines)
        self.db.evaluate()
        self.assertEqual([a for a in self.db.alerts() if a["rule_id"] == "R2_PROBE_THEN_ACCESS"], [])

    def test_boundary_followup_exactly_at_window_edge_included(self) -> None:
        # 默认 r2_window_seconds=600：恰好 600s 后的访问应命中（闭区间）
        lines = "\n".join([
            proxy("P1", "2026-11-18T10:00:00Z", "8.8.8.8", "path_scan", "/.git/config", "404"),
            proxy("P2", "2026-11-18T10:10:00Z", "8.8.8.8", "GET", "/admin/users", "200"),
        ])
        self.db.import_text(lines)
        self.db.evaluate()
        self.assertEqual(len([a for a in self.db.alerts() if a["rule_id"] == "R2_PROBE_THEN_ACCESS"]), 1)


class Rule3Test(unittest.TestCase):
    def setUp(self) -> None:
        self.db = TempDB()

    def tearDown(self) -> None:
        self.db.close()

    def _base_lines(self, export_ts, export_ip="172.16.0.9"):
        return "\n".join([
            auth("L1", "2026-11-18T11:00:00Z", "alice", "10.0.0.10", "success"),
            ep("E1", export_ts, "alice", export_ip, "bulk_export", "crm_pii"),
        ])

    def test_cross_ip_export_alerts(self) -> None:
        self.db.import_text(self._base_lines("2026-11-18T11:05:00Z"))
        self.db.evaluate()
        r3 = [a for a in self.db.alerts() if a["rule_id"] == "R3_CROSS_IP_EXPORT"]
        self.assertEqual(len(r3), 1)
        self.assertEqual(r3[0]["severity"], "high")

    def test_same_ip_export_does_not_alert(self) -> None:
        self.db.import_text(self._base_lines("2026-11-18T11:05:00Z", export_ip="10.0.0.10"))
        self.db.evaluate()
        self.assertEqual([a for a in self.db.alerts() if a["rule_id"] == "R3_CROSS_IP_EXPORT"], [])

    def test_export_before_login_does_not_alert(self) -> None:
        self.db.import_text(self._base_lines("2026-11-18T10:59:00Z"))
        self.db.evaluate()
        self.assertEqual([a for a in self.db.alerts() if a["rule_id"] == "R3_CROSS_IP_EXPORT"], [])

    def test_export_outside_window_does_not_alert(self) -> None:
        self.db.import_text(self._base_lines("2026-11-18T11:30:00Z"))
        self.db.evaluate()
        self.assertEqual([a for a in self.db.alerts() if a["rule_id"] == "R3_CROSS_IP_EXPORT"], [])

    def test_boundary_export_exactly_at_window_edge_included(self) -> None:
        # 默认 r3_window_seconds=900：恰好 900s 后的导出应命中（闭区间）
        self.db.import_text(self._base_lines("2026-11-18T11:15:00Z"))
        self.db.evaluate()
        self.assertEqual(len([a for a in self.db.alerts() if a["rule_id"] == "R3_CROSS_IP_EXPORT"]), 1)


class ReEvaluationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.db = TempDB()

    def tearDown(self) -> None:
        self.db.close()

    def test_late_event_extends_timeline_but_keeps_alert_identity_and_status(self) -> None:
        # 先导入：只有两次失败 + 成功，尚未达到阈值（3 个不同账号）
        first = "\n".join([
            auth("A1", "2026-11-18T09:00:00Z", "u1", "9.9.9.9", "failure"),
            auth("A2", "2026-11-18T09:00:20Z", "u2", "9.9.9.9", "failure"),
            auth("A3", "2026-11-18T09:01:00Z", "u1", "9.9.9.9", "success"),
        ])
        self.db.import_text(first)
        self.db.evaluate()
        self.assertEqual([a for a in self.db.alerts() if a["rule_id"] == "R1_BRUTE_FORCE"], [])

        # 迟到事件：时间更早的第三个账号失败，补齐后应产生告警
        late = auth("A0", "2026-11-18T08:59:50Z", "u3", "9.9.9.9", "failure")
        self.db.import_text(late)
        self.db.evaluate()
        alerts = [a for a in self.db.alerts() if a["rule_id"] == "R1_BRUTE_FORCE"]
        self.assertEqual(len(alerts), 1)
        evidence = storage.alert_evidence(self.db.conn, alerts[0]["id"])
        self.assertEqual([e["event_id"] for e in evidence][0], "A0")  # 时间线自动补齐并排序

    def test_reimport_same_data_does_not_duplicate_alert_or_counts(self) -> None:
        lines = "\n".join([
            auth("A1", "2026-11-18T09:00:00Z", "u1", "9.9.9.9", "failure"),
            auth("A2", "2026-11-18T09:00:20Z", "u2", "9.9.9.9", "failure"),
            auth("A3", "2026-11-18T09:00:40Z", "u3", "9.9.9.9", "failure"),
            auth("A4", "2026-11-18T09:01:00Z", "u1", "9.9.9.9", "success"),
        ])
        self.db.import_text(lines)
        self.db.evaluate()
        before = self.db.alerts()
        self.assertEqual(len(before), 1)
        second = self.db.import_text(lines)
        self.assertEqual(second["counts"]["duplicate"], 4)
        self.db.evaluate()
        after = self.db.alerts()
        self.assertEqual(len(after), 1)
        self.assertEqual(after[0]["id"], before[0]["id"])  # 同一条告警，没有重复生成
        evidence = storage.alert_evidence(self.db.conn, after[0]["id"])
        self.assertEqual(len(evidence), 4)

    def test_late_event_preserves_disposition_status_and_note(self) -> None:
        lines = "\n".join([
            auth("A1", "2026-11-18T09:00:00Z", "u1", "9.9.9.9", "failure"),
            auth("A2", "2026-11-18T09:00:20Z", "u2", "9.9.9.9", "failure"),
            auth("A3", "2026-11-18T09:00:40Z", "u3", "9.9.9.9", "failure"),
            auth("A4", "2026-11-18T09:01:00Z", "u1", "9.9.9.9", "success"),
        ])
        self.db.import_text(lines)
        self.db.evaluate()
        alert = self.db.alerts()[0]
        storage.set_alert_status(self.db.conn, alert["id"], "confirmed", "已人工确认撞库")

        # 再导入一条迟到的同窗口失败事件，触发重新评估
        self.db.import_text(auth("A5", "2026-11-18T09:00:50Z", "u4", "9.9.9.9", "failure"))
        self.db.evaluate()
        refreshed = storage.get_alert(self.db.conn, alert["id"])
        self.assertIsNotNone(refreshed)
        self.assertEqual(refreshed["status"], "confirmed")           # 处置状态未被抹掉
        self.assertEqual(refreshed["disposition_note"], "已人工确认撞库")
        evidence = storage.alert_evidence(self.db.conn, alert["id"])
        self.assertEqual(len(evidence), 5)                            # 时间线被补齐

    def test_late_r3_export_joins_existing_alert(self) -> None:
        base = "\n".join([
            auth("L1", "2026-11-18T11:00:00Z", "alice", "10.0.0.10", "success"),
            ep("E1", "2026-11-18T11:05:00Z", "alice", "172.16.0.9", "bulk_export", "crm"),
        ])
        self.db.import_text(base)
        self.db.evaluate()
        alert_id = self.db.alerts()[0]["id"]
        self.db.import_text(ep("E2", "2026-11-18T11:08:00Z", "alice", "172.16.0.10", "data_export", "hr"))
        self.db.evaluate()
        alerts = self.db.alerts()
        self.assertEqual(len(alerts), 1)
        self.assertEqual(alerts[0]["id"], alert_id)  # 迟到证据并入同一告警
        self.assertEqual(len(storage.alert_evidence(self.db.conn, alert_id)), 3)

    def test_threshold_change_marks_alert_superseded_then_revives(self) -> None:
        lines = "\n".join([
            auth("A1", "2026-11-18T09:00:00Z", "u1", "9.9.9.9", "failure"),
            auth("A2", "2026-11-18T09:00:20Z", "u2", "9.9.9.9", "failure"),
            auth("A3", "2026-11-18T09:00:40Z", "u3", "9.9.9.9", "failure"),
            auth("A4", "2026-11-18T09:01:00Z", "u1", "9.9.9.9", "success"),
        ])
        self.db.import_text(lines)
        self.db.evaluate()
        alert = self.db.alerts()[0]
        storage.set_alert_status(self.db.conn, alert["id"], "confirmed", "保留的处置")

        # 阈值调高，规则不再命中：默认列表隐藏，但记录仍在且处置不丢
        storage.update_settings(self.db.conn, {"r1_fail_threshold": 5})
        self.db.evaluate()
        self.assertEqual(self.db.alerts(), [])
        hidden = storage.list_alerts(self.db.conn, include_superseded=True)
        self.assertEqual(len(hidden), 1)
        self.assertEqual(hidden[0]["superseded"], 1)
        self.assertEqual(hidden[0]["status"], "confirmed")

        # 阈值恢复：同一告警复活（ID 不变），失效标记清除，处置仍保留
        storage.update_settings(self.db.conn, {"r1_fail_threshold": 3})
        self.db.evaluate()
        visible = self.db.alerts()
        self.assertEqual(len(visible), 1)
        self.assertEqual(visible[0]["id"], alert["id"])
        self.assertEqual(visible[0]["superseded"], 0)
        self.assertEqual(visible[0]["status"], "confirmed")
        self.assertEqual(visible[0]["disposition_note"], "保留的处置")


if __name__ == "__main__":
    unittest.main()
