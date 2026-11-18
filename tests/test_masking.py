"""敏感内容遮蔽测试：页面数据、日志、导出、状态文件都不得出现凭据原文。"""

import json
import os

from baseline_audit.masking import redact_line, scan_line, value_fingerprint
from tests._helpers import AuditTestCase

FAKE_SECRET = "EXAMPLE-FAKE-SUPER-SECRET-VALUE-987654"


class MaskingUnitTests(AuditTestCase):
    def test_assignment_redaction_keeps_key_only(self):
        line = f'api_key = "{FAKE_SECRET}"'
        redacted = redact_line(line)
        self.assertIn("api_key", redacted)
        self.assertNotIn(FAKE_SECRET, redacted)
        self.assertIn("[REDACTED]", redacted)

    def test_url_credentials_redacted(self):
        line = f"db_url = postgres://user:{FAKE_SECRET}@host:5432/db"
        redacted = redact_line(line)
        self.assertNotIn(FAKE_SECRET, redacted)
        self.assertIn("[REDACTED]", redacted)

    def test_pem_block_redacted(self):
        line = "-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----"
        redacted = redact_line(line)
        self.assertNotIn("SECRET", redacted)

    def test_value_fingerprint_is_stable_and_short(self):
        fp1 = value_fingerprint(FAKE_SECRET)
        fp2 = value_fingerprint(FAKE_SECRET)
        self.assertEqual(fp1, fp2)
        self.assertTrue(fp1.startswith("sha256:"))
        self.assertNotIn(FAKE_SECRET, fp1)
        self.assertNotEqual(value_fingerprint("other"), fp1)

    def test_scan_line_does_not_return_raw_value(self):
        hits = scan_line(f"password={FAKE_SECRET}")
        self.assertTrue(hits)
        self.assertNotIn(FAKE_SECRET, json.dumps(hits))


class MaskingEndToEndTests(AuditTestCase):
    def _all_persisted_text(self):
        """收集运行结果、导出报告与状态目录内所有文本。"""
        blobs = []
        for dirpath, _, filenames in os.walk(self.data_dir):
            for name in filenames:
                with open(os.path.join(dirpath, name), "rb") as handle:
                    blobs.append(handle.read().decode("utf-8", "replace"))
        return blobs

    def test_secret_never_leaks_into_findings_store_log_or_export(self):
        self.write(
            "etc/demo/app.conf",
            f'api_key = "{FAKE_SECRET}"\n'
            f"db_url = postgres://u:{FAKE_SECRET}@h/db\n",
            0o644,
        )
        run = self.scan()
        self.auditor.save_baseline(self.root, run["run_id"])
        self.auditor.add_exception(
            self.root, run["findings"][0]["id"], "finding", "", f"理由 {FAKE_SECRET}"
        )
        report = self.auditor.export_report(self.root)

        serialized = json.dumps(run, ensure_ascii=False) + json.dumps(report, ensure_ascii=False)
        for blob in self._all_persisted_text():
            serialized += blob
        self.assertNotIn(FAKE_SECRET, serialized)

        # 凭据发现仍应存在，且证据只含指纹与遮蔽行
        secret_hits = [f for f in run["findings"] if f["rule_id"] == "SVC-PLAINTEXT-SECRET"]
        self.assertGreaterEqual(len(secret_hits), 2)
        for finding in secret_hits:
            self.assertIn("value_fingerprint", finding["evidence"])
            self.assertIn("[REDACTED]", json.dumps(finding["evidence"], ensure_ascii=False))

    def test_audit_log_has_events_but_no_secret(self):
        self.write("etc/demo/app.env", f"TOKEN={FAKE_SECRET}\n", 0o644)
        self.scan()
        events = self.auditor.read_audit_log()
        self.assertTrue(any(e["event"] == "scan_complete" for e in events))
        self.assertNotIn(FAKE_SECRET, json.dumps(events, ensure_ascii=False))
