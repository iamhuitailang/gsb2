"""Identity stability, review lifecycle, ignore expiry and rule-change isolation."""

from __future__ import annotations

import json
import os
import tempfile
import unittest

from tests.support import WorkbenchTestCase

AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"


class StabilityTests(WorkbenchTestCase):
    def test_identity_survives_line_shift_and_file_move(self):
        root = self.make_project(
            {"a/creds.env": 'aws_secret_access_key = "%s"\n' % AWS_SECRET}
        )
        first = self.run_scan(root)
        self.assertEqual(first["status"], "completed", first.get("error"))
        original = self.findings(first["id"])
        self.assertTrue(original)
        fp = original[0]["fingerprint"]

        migrated = os.path.join(root, "b", "moved.env")
        os.makedirs(os.path.dirname(migrated), exist_ok=True)
        with open(migrated, "w", encoding="utf-8") as handle:
            handle.write("line one\nline two\nline three\n")
            handle.write('aws_secret_access_key = "%s"\n' % AWS_SECRET)
        os.unlink(os.path.join(root, "a", "creds.env"))

        second = self.run_scan(root)
        moved = [f for f in self.findings(second["id"]) if f["fingerprint"] == fp]
        self.assertEqual(len(moved), 1, "the credential must keep one identity after the move")
        self.assertEqual(moved[0]["path"], "b/moved.env")
        self.assertEqual(moved[0]["line"], 4)
        self.assertEqual(moved[0]["status"], "persistent")

    def test_line_shift_alone_does_not_create_new_findings(self):
        path = "creds.env"
        root = self.make_project({path: 'aws_secret_access_key = "%s"\n' % AWS_SECRET})
        first = self.run_scan(root)
        before = {f["fingerprint"] for f in self.findings(first["id"])}

        with open(os.path.join(root, path), "w", encoding="utf-8") as handle:
            handle.write("# padding\n" * 7)
            handle.write('aws_secret_access_key = "%s"\n' % AWS_SECRET)
        second = self.run_scan(root)
        after = {f["fingerprint"] for f in self.findings(second["id"])}
        self.assertEqual(before, after)
        moved = [f for f in self.findings(second["id"]) if f["fingerprint"] in before]
        self.assertTrue(all(f["status"] == "persistent" for f in moved))

    def test_changed_secret_creates_new_identity_and_old_is_resolved(self):
        root = self.make_project({"creds.env": 'aws_secret_access_key = "%s"\n' % AWS_SECRET})
        first = self.run_scan(root)
        before = {f["fingerprint"] for f in self.findings(first["id"])}
        with open(os.path.join(root, "creds.env"), "w", encoding="utf-8") as handle:
            handle.write('aws_secret_access_key = "Zx9Qm2Lp7Rt4Vb8Nc3Hf6Jd1Ks5Gw0Ey"\n')
        second = self.run_scan(root)
        after = self.findings(second["id"])
        new_fps = {f["fingerprint"] for f in after if f["status"] == "new"}
        resolved = {f["fingerprint"] for f in after if f["status"] == "resolved"}
        self.assertTrue(new_fps - before)
        self.assertEqual(resolved, before)


class ReviewLifecycleTests(WorkbenchTestCase):
    def _scan_one(self):
        root = self.make_project({"creds.env": 'aws_secret_access_key = "%s"\n' % AWS_SECRET})
        scan = self.run_scan(root)
        return root, self.findings(scan["id"])[0]

    def test_accept_requires_reason_and_persists(self):
        _root, finding = self._scan_one()
        with self.assertRaises(Exception) as ctx:
            self.workbench.review_finding(finding["id"], "accept", "   ")
        self.assertEqual(getattr(ctx.exception, "code", ""), "reason_required")

        updated = self.workbench.review_finding(finding["id"], "accept", "测试用占位值")
        self.assertEqual(updated["review_state"], "accepted")
        self.assertIn("测试用占位值", updated["review_note"])

    def test_ignore_expiry_transitions_back_to_attention(self):
        _root, finding = self._scan_one()
        # Ignore for 30 days, then simulate time passing by rewriting the deadline.
        self.workbench.review_finding(finding["id"], "ignore", "稍后处理", ignore_days=30)
        self.assertEqual(
            self.workbench.decorate_finding(self.workbench.store.get_finding(finding["id"]))["review_state"],
            "ignored",
        )
        past = "2020-01-01T00:00:00Z"
        self.workbench.store.upsert_review(
            fingerprint=finding["fingerprint"],
            family=finding["family"],
            semantic_hash=finding["rule_semantic_hash"],
            decision="ignore",
            reason="稍后处理",
            actor="",
            ignore_until=past,
        )
        decorated = self.workbench.decorate_finding(self.workbench.store.get_finding(finding["id"]))
        self.assertEqual(decorated["review_state"], "ignore_expired")
        self.assertIn("到期", decorated["review_note"])

    def test_ignore_rejects_past_deadline(self):
        _root, finding = self._scan_one()
        with self.assertRaises(Exception) as ctx:
            self.workbench.review_finding(
                finding["id"], "ignore", "稍后处理", ignore_until="2000-01-01T00:00:00Z"
            )
        self.assertEqual(getattr(ctx.exception, "code", ""), "invalid_ignore_until")

    def test_review_survives_rescan(self):
        root, finding = self._scan_one()
        self.workbench.review_finding(finding["id"], "accept", "已确认")
        second = self.run_scan(root)
        refreshed = self.findings(second["id"])[0]
        self.assertEqual(refreshed["review_state"], "accepted")

    def test_rule_meaning_change_invalidates_review(self):
        root, finding = self._scan_one()
        self.workbench.review_finding(finding["id"], "accept", "已确认")

        rules = json.loads(self.workbench.rules_text())
        for rule in rules["rules"]:
            if rule["family"] == "cloud.aws.secret-access-key":
                rule["semantic_version"] = "2"
                rule["pattern"] = (
                    r"(?i)aws_?secret_?access_?key\s*[:=]\s*['\"]?(?P<secret>[A-Za-z0-9/+=]{30,60})['\"]?"
                )
        self.workbench.update_rules(json.dumps(rules, ensure_ascii=False))
        second = self.run_scan(root)
        refreshed = self.findings(second["id"])[0]
        self.assertEqual(refreshed["review_state"], "needs_rereview")
        self.assertIn("旧规则", refreshed["review_note"])
        # The old review is preserved for audit, not deleted.
        self.assertTrue(
            self.workbench.store.reviews_for_fingerprint(
                finding["fingerprint"], finding["family"]
            )
        )

    def test_cosmetic_rule_change_keeps_review(self):
        root, finding = self._scan_one()
        self.workbench.review_finding(finding["id"], "accept", "已确认")
        rules = json.loads(self.workbench.rules_text())
        for rule in rules["rules"]:
            if rule["family"] == "cloud.aws.secret-access-key":
                rule["name"] = "AWS Secret Key (renamed)"
                rule["severity"] = "high"
        self.workbench.update_rules(json.dumps(rules, ensure_ascii=False))
        second = self.run_scan(root)
        refreshed = self.findings(second["id"])[0]
        self.assertEqual(refreshed["review_state"], "accepted")


class RuleImpactTests(WorkbenchTestCase):
    def test_impact_reports_semantic_families(self):
        rules = json.loads(self.workbench.rules_text())
        for rule in rules["rules"]:
            if rule["family"] == "token.github":
                rule["pattern"] = r"\bghp_[A-Za-z0-9]{36,251}\b"
                rule["min_entropy"] = 3.5
            if rule["family"] == "token.slack":
                rule["name"] = "Slack (renamed)"
        impact = self.workbench.rule_change_impact(json.dumps(rules))
        self.assertIn("token.github", impact["semantic_change_families"])
        self.assertIn("token.slack", impact["cosmetic_change_families"])
        self.assertIn("token.github", impact["warning"])


if __name__ == "__main__":
    unittest.main()
