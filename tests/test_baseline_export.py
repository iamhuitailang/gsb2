"""Baseline comparison, filters, export redaction and skip reporting."""

from __future__ import annotations

import json
import os
import unittest

from tests.support import WorkbenchTestCase

AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
OTHER_SECRET = "Zx9Qm2Lp7Rt4Vb8Nc3Hf6Jd1Ks5Gw0Ey"


class BaselineTests(WorkbenchTestCase):
    def _project(self):
        return self.make_project(
            {
                "src/creds.env": 'aws_secret_access_key = "%s"\n' % AWS_SECRET,
                "src/other.env": 'aws_secret_access_key = "%s"\n' % OTHER_SECRET,
            }
        )

    def test_baseline_compare_separates_new_and_resolved(self):
        root = self._project()
        first = self.run_scan(root)
        baseline = self.workbench.create_baseline(first["id"], "发布前基线", "初始确认")
        self.assertEqual(baseline["finding_count"], 2)

        with open(os.path.join(root, "src", "other.env"), "w", encoding="utf-8") as handle:
            handle.write('aws_secret_access_key = "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0G1h2"\n')
        second = self.run_scan(root)
        comparison = self.workbench.compare_baseline(second["id"], baseline["id"])
        self.assertEqual(comparison["summary"]["new"], 1)
        self.assertEqual(comparison["summary"]["resolved"], 1)
        # The unchanged secret is still present.
        self.assertEqual(comparison["summary"]["persistent"], 1)

    def test_line_and_path_move_is_not_reported_as_new(self):
        root = self.make_project({"a/creds.env": 'aws_secret_access_key = "%s"\n' % AWS_SECRET})
        first = self.run_scan(root)
        baseline = self.workbench.create_baseline(first["id"], "baseline")

        os.makedirs(os.path.join(root, "b"), exist_ok=True)
        with open(os.path.join(root, "b", "moved.env"), "w", encoding="utf-8") as handle:
            handle.write("\n\n\n")
            handle.write('aws_secret_access_key = "%s"\n' % AWS_SECRET)
        os.unlink(os.path.join(root, "a", "creds.env"))

        second = self.run_scan(root)
        comparison = self.workbench.compare_baseline(second["id"], baseline["id"])
        self.assertEqual(comparison["summary"]["new"], 0)
        self.assertEqual(comparison["summary"]["resolved"], 0)
        self.assertEqual(comparison["summary"]["persistent"], 1)
        self.assertEqual(comparison["summary"]["relocated"], 1)
        self.assertEqual(comparison["changed"][0]["baseline_location"]["path"], "a/creds.env")

    def test_baseline_cannot_compare_across_projects(self):
        root = self._project()
        first = self.run_scan(root)
        baseline = self.workbench.create_baseline(first["id"], "baseline")
        other = self.make_project(
            {"x.env": 'aws_secret_access_key = "%s"\n' % AWS_SECRET}, name="other"
        )
        other_scan = self.run_scan(other)
        with self.assertRaises(Exception) as ctx:
            self.workbench.compare_baseline(other_scan["id"], baseline["id"])
        self.assertEqual(getattr(ctx.exception, "code", ""), "baseline_root_mismatch")

    def test_baseline_include_accepted(self):
        root = self._project()
        first = self.run_scan(root)
        finding = self.findings(first["id"])[0]
        self.workbench.review_finding(finding["id"], "accept", "确认")
        baseline = self.workbench.create_baseline(first["id"], "仅接受项", include="accepted")
        self.assertEqual(baseline["finding_count"], 1)

    def test_unchecked_file_makes_baseline_entry_unverifiable_not_resolved(self):
        root = self.make_project({"creds.env": 'aws_secret_access_key = "%s"\n' % AWS_SECRET})
        first = self.run_scan(root)
        baseline = self.workbench.create_baseline(first["id"], "baseline")

        with open(os.path.join(root, "creds.env"), "wb") as handle:
            handle.write(b"\x00\x01\x02 binary now")
        second = self.run_scan(root)
        comparison = self.workbench.compare_baseline(second["id"], baseline["id"])
        self.assertEqual(comparison["summary"]["unverifiable"], 1)
        self.assertEqual(comparison["summary"]["resolved"], 0)


class FilterAndExportTests(WorkbenchTestCase):
    def _scanned(self):
        root = self.copy_demo()
        scan = self.run_scan(root)
        return root, scan

    def test_filters_by_severity_status_and_path(self):
        _root, scan = self._scanned()
        everything = self.workbench.scan_results(scan["id"])
        critical = self.workbench.scan_results(scan["id"], {"severity": ["critical"]})
        self.assertTrue(critical)
        self.assertTrue(all(item["severity"] == "critical" for item in critical))
        self.assertLess(len(critical), len(everything))

        path_filtered = self.workbench.scan_results(scan["id"], {"path": ["src/"]})
        self.assertTrue(path_filtered)
        self.assertTrue(all(item["path"].startswith("src/") for item in path_filtered))

        by_rule = self.workbench.scan_results(scan["id"], {"rule": ["token.bearer"]})
        self.assertTrue(all(item["rule_id"] == "token.bearer" for item in by_rule))

    def test_review_filter(self):
        _root, scan = self._scanned()
        finding = self.findings(scan["id"])[0]
        self.workbench.review_finding(finding["id"], "accept", "确认")
        accepted = self.workbench.scan_results(scan["id"], {"review_state": ["accepted"]})
        self.assertEqual(len(accepted), 1)
        self.assertEqual(accepted[0]["id"], finding["id"])

    def test_json_export_has_no_secret_and_lists_unchecked_files(self):
        root, scan = self._scanned()
        # Add a binary file so not_inspected is populated.
        with open(os.path.join(root, "assets", "blob.bin"), "wb") as handle:
            handle.write(b"\x00\x01binary")
        scan = self.run_scan(root)
        report = self.workbench.export_report(scan["id"], "json")
        payload = json.loads(report["content"])
        self.assertIn("ruleset", payload)
        self.assertTrue(payload["ruleset"]["version"])
        self.assertTrue(payload["scan"]["finished_at"])
        self.assertFalse(payload["redaction"]["matched_text_included"])
        reasons = {item["reason"] for item in payload["not_inspected"]}
        self.assertIn("binary", reasons)
        for finding in payload["findings"]:
            self.assertNotIn("_secret", finding)
            self.assertNotIn(AWS_SECRET, json.dumps(finding))
            self.assertIn("preview", finding)

    def test_csv_export_is_machine_readable_and_redacted(self):
        _root, scan = self._scanned()
        report = self.workbench.export_report(scan["id"], "csv")
        content = report["content"]
        self.assertIn("scan_id=%s" % scan["id"], content)
        self.assertIn("ruleset_version=", content)
        self.assertIn("fingerprint,rule_id", content)
        self.assertIn("[REDACTED]", content)
        self.assertNotIn(AWS_SECRET, content)
        self.assertNotIn("ghp_0123456789", content)

    def test_export_includes_baseline_comparison(self):
        _root, scan = self._scanned()
        baseline = self.workbench.create_baseline(scan["id"], "baseline")
        report = self.workbench.export_report(scan["id"], "json", baseline_id=baseline["id"])
        payload = json.loads(report["content"])
        self.assertIn("baseline_comparison", payload)
        self.assertIn("resolved", payload["baseline_comparison"])

    def test_report_never_contains_matched_values_from_any_rule(self):
        _root, scan = self._scanned()
        report = self.workbench.export_report(scan["id"], "json")["content"]
        for value in (
            AWS_SECRET,
            "S3cureDemoP4ssw0rd",
            "ghp_0123456789abcdefghijklmnopqrstuvwxyz012345",
            "demo-token-7f3c9a1b2d4e6f8091a3b5c7d9e1f3a5",
            "MIIEowIBAAKCAQEA0DEMO0fakeprivatekeymaterial",
        ):
            self.assertNotIn(value, report)


class SkippedFileTests(WorkbenchTestCase):
    def test_skip_details_explain_every_reason(self):
        root = self.make_project(
            {
                "normal.txt": "hello",
                "blob.bin": b"\x00\x00\x00",
                "big.txt": "x" * 5000,
            }
        )
        scan = self.run_scan(root, max_file_bytes=1024)
        details = self.workbench.skip_details(scan["id"])
        reasons = {item["reason"] for item in details["items"]}
        self.assertIn("binary", reasons)
        self.assertIn("too_large", reasons)
        for item in details["items"]:
            self.assertTrue(item["message"])


if __name__ == "__main__":
    unittest.main()
