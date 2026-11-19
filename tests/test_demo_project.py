"""Demo project integration tests (require the generated demo artefacts)."""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
import unittest

from tests.support import DEMO_ROOT, REPO_ROOT, WorkbenchTestCase
from workbench.scanner import ScanOptions, scan_project
from workbench.rules import load_rules


class DemoProjectTests(WorkbenchTestCase):
    @classmethod
    def setUpClass(cls):
        cls.generated = os.path.join(DEMO_ROOT, "huge")
        if not os.path.exists(os.path.join(DEMO_ROOT, "huge", "large.log")):
            subprocess.run(
                [sys.executable, os.path.join(REPO_ROOT, "scripts", "make_demo.py")],
                check=True,
                cwd=REPO_ROOT,
            )

    def test_demo_scan_reports_skips_and_findings(self):
        scan = self.run_scan(DEMO_ROOT)
        self.assertEqual(scan["status"], "completed", scan.get("error"))
        findings = self.findings(scan["id"])
        paths = {finding["path"] for finding in findings}
        self.assertIn("src/config.py", paths)
        self.assertIn("src/db.py", paths)
        self.assertIn("src/http_client.js", paths)
        self.assertIn("demo_certs/demo-key.txt", paths)
        self.assertIn("moved/config.py", paths)

        skipped = self.workbench.skip_details(scan["id"])
        reasons = {item["path"]: item["reason"] for item in skipped["items"]}
        self.assertEqual(reasons.get("assets/logo.bin"), "binary")
        self.assertEqual(reasons.get("huge/large.log"), "too_large")
        self.assertEqual(reasons.get("links/outside-link"), "symlink_outside_root")

        # Nothing from the outside file may appear anywhere in the results.
        blob = repr(findings)
        self.assertNotIn("Outs1deDemoSecret", blob)

    def test_demo_same_credential_in_two_paths_shares_identity(self):
        scan = self.run_scan(DEMO_ROOT)
        findings = self.findings(scan["id"])
        aws = [f for f in findings if f["family"] == "cloud.aws.secret-access-key"]
        by_path = {f["path"] for f in aws}
        self.assertIn("src/config.py", by_path)
        self.assertIn("moved/config.py", by_path)
        fingerprints = {f["fingerprint"] for f in aws if f["path"] in ("src/config.py", "moved/config.py")}
        self.assertEqual(len(fingerprints), 1, "the same credential must share one fingerprint")

    def test_symlink_target_outside_root_is_never_read(self):
        # Verify with the pure scanner as well, not just the service layer.
        rules = load_rules(self.workbench.rules_path)
        output = scan_project(DEMO_ROOT, rules, ScanOptions())
        for finding in output.findings:
            self.assertNotIn("Outs1deDemoSecret", str(finding.get("preview", "")))
            self.assertNotEqual(finding["path"], "links/outside-link")

    def test_binary_and_large_files_not_read(self):
        rules = load_rules(self.workbench.rules_path)
        output = scan_project(DEMO_ROOT, rules, ScanOptions())
        inspected = output.inspected_paths
        self.assertNotIn("assets/logo.bin", inspected)
        self.assertNotIn("huge/large.log", inspected)
        self.assertNotIn("links/outside-link", inspected)


class SymlinkUnitTests(WorkbenchTestCase):
    def test_outside_symlink_reported_without_reading(self):
        outside = os.path.join(self.tmp, "outside-root.txt")
        with open(outside, "w", encoding="utf-8") as handle:
            handle.write('aws_secret_access_key = "never-read-this-synthetic-value-012345"\n')
        root = self.make_project({"real.txt": "ok\n"})
        os.symlink(outside, os.path.join(root, "link.txt"))
        output = scan_project(root, load_rules(self.workbench.rules_path), ScanOptions())
        self.assertEqual(output.findings, [])
        reasons = {skip.path: skip.reason for skip in output.skipped}
        self.assertEqual(reasons.get("link.txt"), "symlink_outside_root")


if __name__ == "__main__":
    unittest.main()
