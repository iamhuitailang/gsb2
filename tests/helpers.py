"""测试公共辅助：在临时目录里生成小型 Python 项目并扫描。"""

from __future__ import annotations

import os
import tempfile
import unittest

from sqlaudit.scanner import scan_project


class ScannerCase(unittest.TestCase):
    def make_project(self, files: dict[str, str]) -> str:
        """files: {相对路径: 文件内容}，返回项目根目录。"""
        tmp = tempfile.mkdtemp(prefix="sqlaudit-test-")
        for rel, content in files.items():
            full = os.path.join(tmp, rel)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w", encoding="utf-8") as fh:
                fh.write(content)
        self.addCleanup(self._cleanup, tmp)
        return tmp

    @staticmethod
    def _cleanup(path: str) -> None:
        for root, dirs, names in os.walk(path, topdown=False):
            for name in names:
                os.remove(os.path.join(root, name))
            for name in dirs:
                os.rmdir(os.path.join(root, name))
        os.rmdir(path)

    def scan(self, files: dict[str, str]):
        root = self.make_project(files)
        return scan_project(root), root

    @staticmethod
    def findings_on(result, filename: str):
        return [f for f in result.findings if f.file == filename]

    @staticmethod
    def line_of(root: str, filename: str, needle: str) -> int:
        """返回文件中包含 needle 的行号，避免把行号硬编码进断言。"""
        path = os.path.join(root, filename)
        with open(path, encoding="utf-8") as fh:
            for lineno, line in enumerate(fh, start=1):
                if needle in line:
                    return lineno
        raise AssertionError(f"{needle!r} not found in {filename}")
