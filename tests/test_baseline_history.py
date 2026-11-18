"""重复核查、稳定身份与基线测试。"""

import json
import os

from baseline_audit.models import (
    STATUS_CHANGED,
    STATUS_DISAPPEARED,
    STATUS_NEW,
    STATUS_PRESENT,
)
from baseline_audit.rules import RULES_VERSION
from tests._helpers import AuditTestCase


class RepeatScanTests(AuditTestCase):
    def test_first_scan_marks_everything_new(self):
        self.write("conf/open.conf", "x=1\n", 0o666)
        run = self.scan()
        self.assertTrue(all(f["status"] == STATUS_NEW for f in run["findings"]))

    def test_unchanged_finding_keeps_identity_and_becomes_present(self):
        self.write("conf/open.conf", "x=1\n", 0o666)
        first = self.scan()
        second = self.scan()
        first_ids = {f["id"] for f in first["findings"]}
        second_ids = {f["id"] for f in second["findings"]}
        self.assertEqual(first_ids, second_ids)
        self.assertTrue(all(f["status"] == STATUS_PRESENT for f in second["findings"]))

    def test_permission_change_is_detected_as_changed(self):
        path = self.write("conf/open.conf", "x=1\n", 0o666)
        first = self.scan()
        os.chmod(path, 0o644)
        second = self.scan()
        # 旧的过宽权限发现应标记为消失
        disappeared = [f for f in second["findings"] if f["status"] == STATUS_DISAPPEARED]
        self.assertTrue(any(f["rule_id"] == "PERM-WORLD-WRITABLE-FILE" for f in disappeared))
        # 身份不变但指纹变化时标记为 changed
        self.write("conf/open.conf", "x=1\n", 0o660)
        third = self.scan()
        group_hits = [f for f in third["findings"]
                      if f["rule_id"] == "PERM-GROUP-WRITABLE-CONFIG"]
        self.assertTrue(group_hits)

    def test_new_and_disappeared_findings_both_reported(self):
        self.write("conf/a.conf", "x=1\n", 0o666)
        self.scan()
        os.unlink(os.path.join(self.root, "conf/a.conf"))
        self.write("conf/b.conf", "y=2\n", 0o666)
        run = self.scan()
        statuses = {f["rel_path"]: f["status"] for f in run["findings"]}
        self.assertEqual(statuses.get("conf/b.conf"), STATUS_NEW)
        self.assertEqual(statuses.get("conf/a.conf"), STATUS_DISAPPEARED)

    def test_identity_is_path_and_rule_bound(self):
        # 不同路径的同类问题必须是不同身份，旧例外无法套用
        self.write("conf/a.conf", "x=1\n", 0o666)
        self.write("conf/b.conf", "x=1\n", 0o666)
        run = self.scan()
        ids = [f["id"] for f in run["findings"]
               if f["rule_id"] == "PERM-WORLD-WRITABLE-FILE"]
        self.assertEqual(len(ids), 2)
        self.assertEqual(len(set(ids)), 2)


class BaselineTests(AuditTestCase):
    def test_baseline_save_and_compare(self):
        self.write("conf/a.conf", "x=1\n", 0o666)
        run1 = self.scan()
        baseline = self.auditor.save_baseline(self.root, run1["run_id"])
        self.assertEqual(baseline["rule_version"], RULES_VERSION)

        # 新增文件 -> new_since_baseline
        self.write("conf/b.conf", "y=2\n", 0o666)
        run2 = self.scan()
        states = {f["rel_path"]: f.get("baseline_state") for f in run2["findings"]}
        self.assertEqual(states.get("conf/b.conf"), "new_since_baseline")
        self.assertEqual(states.get("conf/a.conf"), "in_baseline")

    def test_corrupt_baseline_is_reported_not_silently_reused(self):
        self.write("conf/a.conf", "x=1\n", 0o666)
        run = self.scan()
        self.auditor.save_baseline(self.root, run["run_id"])
        baseline_path = self.auditor.store._baseline_path(self.root)
        with open(baseline_path, "w", encoding="utf-8") as handle:
            handle.write("{ this is not valid json")

        run2 = self.scan()
        tool_notices = [n for n in run2["notices"] if n["category"] == "tool_error"]
        self.assertTrue(any(n["code"] == "baseline_corrupt" for n in tool_notices))

    def test_rule_version_change_warns(self):
        from baseline_audit import rules as rules_mod

        self.write("conf/a.conf", "x=1\n", 0o666)
        run = self.scan()
        self.auditor.save_baseline(self.root, run["run_id"])

        original = rules_mod.rules_fingerprint
        rules_mod.rules_fingerprint = lambda: "sha256:fakechangedfingerprint00"
        try:
            run2 = self.scan()
        finally:
            rules_mod.rules_fingerprint = original
        self.assertTrue(any("规则版本已变化" in w for w in run2["warnings"]))
