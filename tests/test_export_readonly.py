"""导出报告安全与只读保证测试。"""

import json
import os

from tests._helpers import AuditTestCase


class ExportTests(AuditTestCase):
    def test_export_uses_relative_paths_only(self):
        self.write("etc/demo/app.conf", "listen = 0.0.0.0:9000\n", 0o644)
        run = self.scan()
        report = self.auditor.export_report(self.root)

        self.assertEqual(report["rule_version"], run["rule_version"])
        self.assertTrue(report["scanned_at"])
        self.assertIn("findings", report)
        for finding in report["findings"]:
            self.assertFalse(os.path.isabs(finding["rel_path"]))
        # 报告整体不包含本机绝对路径前缀
        self.assertNotIn(self.tmp, json.dumps(report, ensure_ascii=False))

    def test_export_contains_rule_version_and_time(self):
        self.write("conf/a.conf", "x=1\n", 0o644)
        self.scan()
        report = self.auditor.export_report(self.root)
        self.assertTrue(report["rule_version"])
        self.assertTrue(report["rule_fingerprint"])
        self.assertTrue(report["scanned_at"])
        self.assertTrue(report["exported_at"])

    def test_notices_included_and_categorized(self):
        self.write_bytes("etc/bad.conf", b"\x00\x01 binary\n", 0o644)
        self.scan()
        report = self.auditor.export_report(self.root)
        categories = {n["category"] for n in report["notices"]}
        self.assertIn("parse_error", categories)
        for notice in report["notices"]:
            self.assertNotIn(self.tmp, notice["detail"])


class ReadOnlyTests(AuditTestCase):
    def test_scan_does_not_modify_target_tree(self):
        self.write("conf/a.conf", "x=1\n", 0o666)
        nested = os.path.join(self.root, "d", "e")
        os.makedirs(nested)
        self.write("d/e/f.txt", "hello\n", 0o644)

        snapshot = {}
        for dirpath, dirnames, filenames in os.walk(self.root):
            for name in dirnames + filenames:
                full = os.path.join(dirpath, name)
                st = os.lstat(full)
                snapshot[full] = (st.st_mode, st.st_size, st.st_mtime_ns)

        self.scan()
        self.scan()  # 重复核查同样只读

        for full, sig in snapshot.items():
            st = os.lstat(full)
            self.assertEqual((st.st_mode, st.st_size, st.st_mtime_ns), sig,
                             f"被核查文件被修改：{full}")

    def test_data_dir_inside_target_is_excluded_from_scan(self):
        # 数据目录位于目标树内时，扫描必须排除该子树，避免自我扫描
        inside = os.path.join(self.root, ".audit_data")
        from baseline_audit.auditor import Auditor
        auditor = Auditor(inside)
        self.write("conf/open.conf", "x=1\n", 0o666)
        # 数据目录里放一个本应产生发现的文件，若被扫到就会泄露工具状态
        self.write(".audit_data/roots/leak.conf", "password=LEAK-MARKER\n", 0o666)
        run = auditor.scan_resolved(self.root)["run"]
        rels = {f["rel_path"] for f in run["findings"]}
        self.assertFalse(any(rel.startswith(".audit_data") for rel in rels))
        self.assertIn("path_excluded", self.notice_codes(run))
        # 正常业务文件仍被扫描
        self.assertIn("conf/open.conf", rels)
