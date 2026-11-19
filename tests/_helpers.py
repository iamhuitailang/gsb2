"""测试公共辅助：在临时目录里构建完全虚构的源树。

所有测试只读写 tempfile 自动创建/清理的目录，不接触机器上的真实文件。
"""

from __future__ import annotations

import os
import shutil
import stat
import tempfile
import unittest


class TempTreeTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.workdir = tempfile.mkdtemp(prefix="forensics-test-")
        self.src = os.path.join(self.workdir, "src")
        self.case_dir = os.path.join(self.workdir, "case")
        os.makedirs(self.src)
        self._chmod_restore: list[str] = []

    def tearDown(self) -> None:
        # 权限位被改成 0000 的目录/文件先恢复，避免 rmtree 失败
        for path in self._chmod_restore:
            if os.path.exists(path):
                try:
                    os.chmod(path, stat.S_IRWXU)
                except OSError:
                    pass
        shutil.rmtree(self.workdir, ignore_errors=True)

    # ------------------------------------------------------------ helpers
    def write(self, rel: str, content: str | bytes = "x") -> str:
        path = os.path.join(self.src, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        mode = "wb" if isinstance(content, bytes) else "w"
        with open(path, mode) as fh:
            fh.write(content)
        return path

    def mkdir(self, rel: str) -> str:
        path = os.path.join(self.src, rel)
        os.makedirs(path, exist_ok=True)
        return path

    def symlink(self, rel: str, target: str) -> str:
        path = os.path.join(self.src, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        os.symlink(target, path)
        return path

    def make_unreadable(self, rel: str) -> str:
        path = os.path.join(self.src, rel)
        os.chmod(path, 0)
        self._chmod_restore.append(path)
        return path

    def make_unreadable_dir(self, rel: str) -> str:
        path = self.mkdir(rel)
        self.write(os.path.join(rel, "inside.txt"), "secret")
        os.chmod(path, 0)
        self._chmod_restore.append(path)
        return path

    def make_fifo(self, rel: str) -> str:
        path = os.path.join(self.src, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if not os.path.exists(path):
            os.mkfifo(path)
        return path

    def copy_exists(self, rel: str) -> bool:
        return os.path.isfile(
            os.path.join(self.case_dir, "copies", rel)
        )

    def manifest(self) -> dict:
        import json
        with open(os.path.join(self.case_dir, "MANIFEST.json"), "rb") as fh:
            return json.loads(fh.read().decode("utf-8"))

    def entry(self, rel: str) -> dict:
        for raw in self.manifest()["entries"]:
            if raw["rel_path"] == rel:
                return raw
        raise KeyError(rel)

    def entries_by_status(self, status: str) -> list[dict]:
        return [
            raw for raw in self.manifest()["entries"]
            if raw["status"] == status
        ]

    @staticmethod
    def is_root() -> bool:
        return hasattr(os, "geteuid") and os.geteuid() == 0
