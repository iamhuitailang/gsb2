"""编码处理测试: UTF-8、非 UTF-8 回退、二进制嗅探与大文件跳过。"""

import os
import tempfile
import unittest

from secretscan.config import Config
from secretscan.scanner import Scanner


class EncodingTest(unittest.TestCase):
    def _scan(self, root: str):
        config = Config()
        scanner = Scanner(root, config, config.build_rules())
        findings, warnings = scanner.run()
        return scanner, findings, warnings

    def test_utf8_chinese_content_scans(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "app.txt")
            with open(path, "wb") as handle:
                handle.write("# 中文注释\n".encode("utf-8"))
                handle.write(
                    'password = "Zx9Qm4Tv7Lk2Pw8Rn5Yc3Hf6Dg1Ja0Nb"\n'.encode("utf-8")
                )
            _, findings, warnings = self._scan(root)
            self.assertTrue(any(f.rule_id == "credential.assignment" for f in findings))
            self.assertEqual(warnings, [])

    def test_latin1_fallback_keeps_line_numbers(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "legacy.txt")
            with open(path, "wb") as handle:
                handle.write(b"# header line\n")
                handle.write(b"# caf\xe9 r\xe9sum\xe9 line\n")  # 非法 UTF-8
                handle.write(b'api_key = "AKIAEXAMPLE222222222"\n')
            _, findings, warnings = self._scan(root)
            kinds = {item.kind for item in warnings}
            self.assertIn("encoding-fallback", kinds)
            match = next(f for f in findings if f.rule_id == "aws.access_key_id")
            self.assertEqual(match.line, 3)  # 回退解码后行号仍然准确

    def test_nul_byte_file_treated_as_binary(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "blob.dat")
            with open(path, "wb") as handle:
                handle.write(b"password = " + b"\x00" * 4 + b"\n")
            scanner, findings, _ = self._scan(root)
            self.assertEqual(scanner.skipped_binary, 1)
            self.assertEqual(findings, [])

    def test_oversized_file_is_skipped_with_warning(self):
        with tempfile.TemporaryDirectory() as root:
            config = Config(max_file_bytes=64)
            path = os.path.join(root, "huge.txt")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("x" * 200)
            scanner = Scanner(root, config, config.build_rules())
            _, warnings = scanner.run()
            self.assertEqual(scanner.skipped_oversized, 1)
            self.assertEqual(warnings[0].kind, "oversized")

    def test_vcs_directory_is_skipped(self):
        with tempfile.TemporaryDirectory() as root:
            git_dir = os.path.join(root, ".git")
            os.makedirs(git_dir)
            with open(os.path.join(git_dir, "config"), "w", encoding="utf-8") as handle:
                handle.write('token = "ghp_example0000000000000000000000000000bb"')
            scanner, findings, _ = self._scan(root)
            self.assertEqual(scanner.skipped_vcs, 1)
            self.assertEqual(findings, [])


if __name__ == "__main__":
    unittest.main()
