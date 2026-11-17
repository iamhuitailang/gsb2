"""符号链接边界测试: 链接不能把扫描带出根目录。"""

import os
import tempfile
import unittest

from secretscan.config import Config
from secretscan.scanner import Scanner

SECRET_LINE = 'password = "Zx9Qm4Tv7Lk2Pw8Rn5Yc3Hf6Dg1Ja0Nb"\n'


def _scan(root: str):
    config = Config()
    scanner = Scanner(root, config, config.build_rules())
    findings, warnings = scanner.run()
    return scanner, findings, warnings


class SymlinkBoundaryTest(unittest.TestCase):
    def test_external_file_symlink_is_blocked(self):
        with tempfile.TemporaryDirectory() as outside, tempfile.TemporaryDirectory() as root:
            outside_file = os.path.join(outside, "leak.txt")
            with open(outside_file, "w", encoding="utf-8") as handle:
                handle.write(SECRET_LINE)
            link = os.path.join(root, "leak-link.txt")
            os.symlink(outside_file, link)

            _, findings, warnings = _scan(root)
            self.assertEqual(findings, [])
            self.assertEqual(warnings[0].kind, "symlink-file")
            # 告警路径是相对路径, 不泄露根目录绝对前缀。
            self.assertEqual(warnings[0].path, "leak-link.txt")
            self.assertNotIn(root, warnings[0].message)

    def test_external_directory_symlink_is_not_entered(self):
        with tempfile.TemporaryDirectory() as outside, tempfile.TemporaryDirectory() as root:
            with open(os.path.join(outside, "leak.txt"), "w", encoding="utf-8") as handle:
                handle.write(SECRET_LINE)
            os.symlink(outside, os.path.join(root, "outside-link"))

            _, findings, warnings = _scan(root)
            self.assertEqual(findings, [])
            self.assertEqual(warnings[0].kind, "symlink-dir")

    def test_internal_symlink_is_followed(self):
        with tempfile.TemporaryDirectory() as root:
            real_dir = os.path.join(root, "real")
            os.makedirs(real_dir)
            with open(os.path.join(real_dir, "leak.txt"), "w", encoding="utf-8") as handle:
                handle.write(SECRET_LINE)
            os.symlink(real_dir, os.path.join(root, "inner-link"))

            _, findings, warnings = _scan(root)
            # 界内链接目录可进入, 能扫到真实文件; 无越界告警。
            self.assertTrue(any(f.rule_id == "credential.assignment" for f in findings))
            self.assertNotIn("symlink-dir", {w.kind for w in warnings})

    def test_broken_symlink_does_not_crash_scan(self):
        with tempfile.TemporaryDirectory() as root:
            os.symlink("/nonexistent/target-xyz", os.path.join(root, "broken"))
            scanner, findings, warnings = _scan(root)
            self.assertEqual(findings, [])
            # 断链解析后不在根内, 产生越界告警而不是抛异常。
            self.assertIn("symlink-file", {w.kind for w in warnings})
            self.assertEqual(scanner.scanned_files, 0)


if __name__ == "__main__":
    unittest.main()
