"""Scanner boundary tests: symlinks, binary files, size limits, redaction."""

from __future__ import annotations

import os
import tempfile
import unittest

from tests.support import WorkbenchTestCase, scan_with_rules

FAKE_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"

MINIMAL_RULES = {
    "rules": [
        {
            "id": "aws-secret",
            "family": "cloud.aws.secret-access-key",
            "name": "AWS secret",
            "severity": "critical",
            "pattern": r"(?i)aws_?secret_?access_?key\s*[:=]\s*['\"]?(?P<secret>[A-Za-z0-9/+=]{30,60})",
            "secret_group": "secret",
            "min_entropy": 3.0,
        }
    ]
}


class SymlinkTests(WorkbenchTestCase):
    def test_symlinks_are_never_followed(self):
        outside_dir = tempfile.mkdtemp(prefix="wb-outside-")
        try:
            outside_file = os.path.join(outside_dir, "outside.env")
            with open(outside_file, "w", encoding="utf-8") as handle:
                handle.write('aws_secret_access_key = "%s"\n' % FAKE_SECRET)
            root = self.make_project({"ok.txt": "hello\n"})
            os.symlink(outside_file, os.path.join(root, "link-file.env"))
            os.symlink(outside_dir, os.path.join(root, "link-dir"))
            output = scan_with_rules(root, MINIMAL_RULES)
            self.assertEqual(output.findings, [])
            reasons = {skip.path: skip.reason for skip in output.skipped}
            self.assertEqual(reasons.get("link-file.env"), "symlink_outside_root")
            self.assertEqual(reasons.get("link-dir"), "symlink_outside_root")
            self.assertEqual(output.files_inspected, 1)
        finally:
            import shutil

            shutil.rmtree(outside_dir, ignore_errors=True)

    def test_internal_symlink_is_still_not_followed(self):
        root = self.make_project(
            {"real/creds.env": 'aws_secret_access_key = "%s"\n' % FAKE_SECRET}
        )
        os.symlink(
            os.path.join(root, "real", "creds.env"), os.path.join(root, "alias.env")
        )
        output = scan_with_rules(root, MINIMAL_RULES)
        paths = [finding["path"] for finding in output.findings]
        self.assertEqual(paths, ["real/creds.env"])
        reasons = {skip.path: skip.reason for skip in output.skipped}
        self.assertEqual(reasons.get("alias.env"), "symlink")


class BinaryAndSizeTests(WorkbenchTestCase):
    def test_binary_file_is_skipped_with_reason(self):
        root = self.make_project({"image.png": b"\x89PNG\r\n\x1a\n\x00\x00secret bytes"})
        output = scan_with_rules(root, MINIMAL_RULES)
        self.assertEqual(output.findings, [])
        self.assertEqual(output.skipped[0].reason, "binary")
        self.assertEqual(output.files_inspected, 0)

    def test_oversized_file_is_skipped(self):
        root = self.make_project({"big.txt": "x" * 4096})
        from workbench.scanner import ScanOptions

        output = scan_with_rules(root, MINIMAL_RULES, ScanOptions(max_file_bytes=1024))
        self.assertEqual(output.findings, [])
        self.assertEqual(output.skipped[0].reason, "too_large")

    def test_file_count_limit_reports_skip(self):
        files = {"file%d.txt" % index: "hello" for index in range(5)}
        root = self.make_project(files)
        from workbench.scanner import ScanOptions

        output = scan_with_rules(root, MINIMAL_RULES, ScanOptions(max_files=2))
        reasons = [skip.reason for skip in output.skipped]
        self.assertEqual(reasons.count("file_limit"), 3)
        self.assertEqual(output.files_inspected, 2)

    def test_excluded_directory_is_reported(self):
        root = self.make_project({"node_modules/pkg/creds.env": "x"})
        output = scan_with_rules(root, MINIMAL_RULES)
        self.assertIn("excluded", [skip.reason for skip in output.skipped])


class RedactionTests(unittest.TestCase):
    def test_preview_never_contains_the_matched_value(self):
        import shutil

        tmp = tempfile.mkdtemp(prefix="wb-redact-")
        try:
            path = os.path.join(tmp, "creds.env")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write('aws_secret_access_key = "%s"\n' % FAKE_SECRET)
            output = scan_with_rules(tmp, MINIMAL_RULES)
            self.assertEqual(len(output.findings), 1)
            finding = output.findings[0]
            self.assertNotIn(FAKE_SECRET, finding["preview"])
            self.assertIn("[REDACTED]", finding["preview"])
            self.assertNotIn(FAKE_SECRET, output.findings[0].get("line_context", ""))
            self.assertEqual(finding["secret_length"], len(FAKE_SECRET))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_full_private_key_body_never_appears(self):
        body = "MIIEowIBAAKCAQEA0SyntheticBody"
        text = (
            "-----BEGIN RSA PRIVATE KEY-----\n"
            "%s\n"
            "-----END RSA PRIVATE KEY-----\n" % body
        )
        path = tempfile.mkdtemp(prefix="wb-pem-")
        try:
            with open(os.path.join(path, "key.txt"), "w", encoding="utf-8") as handle:
                handle.write(text)
            from workbench.default_rules import default_rules
            from workbench.rules import parse_rules
            from workbench.scanner import ScanOptions, scan_project

            output = scan_project(path, parse_rules(default_rules(), "<test>"), ScanOptions())
            self.assertEqual(len(output.findings), 1)
            finding = output.findings[0]
            self.assertTrue(finding["block"])
            self.assertNotIn(body, finding["preview"])
            self.assertNotIn(body, str({k: v for k, v in finding.items() if k != "_secret"}))
        finally:
            import shutil

            shutil.rmtree(path, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
