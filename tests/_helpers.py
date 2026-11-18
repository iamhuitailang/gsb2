"""测试公共夹具：在临时目录中构造受控核查树。"""

import os
import shutil
import tempfile
import unittest

from baseline_audit.auditor import Auditor


class AuditTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="baseline-audit-test-")
        self.root = os.path.join(self.tmp, "target")
        self.data_dir = os.path.join(self.tmp, "audit-data")
        os.makedirs(self.root)
        self.auditor = Auditor(self.data_dir)

    def tearDown(self):
        # 000 权限目录会让 rmtree 失败，先恢复
        for dirpath, dirnames, _ in os.walk(self.tmp):
            for name in dirnames:
                try:
                    os.chmod(os.path.join(dirpath, name), 0o700)
                except OSError:
                    pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---------- 构造辅助 ----------

    def write(self, rel, content, mode=None):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(content)
        if mode is not None:
            os.chmod(path, mode)
        return path

    def write_bytes(self, rel, content, mode=None):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(content)
        if mode is not None:
            os.chmod(path, mode)
        return path

    def chmod(self, rel, mode):
        os.chmod(os.path.join(self.root, rel), mode)

    def symlink(self, rel, target):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        os.symlink(target, path)
        return path

    def scan(self):
        result = self.auditor.scan_resolved(self.root)
        return result["run"]

    def by_rule(self, run, rule_id):
        return [f for f in run["findings"] if f["rule_id"] == rule_id]

    def notice_codes(self, run, category=None):
        return {n["code"] for n in run["notices"] if category is None or n["category"] == category}

    def assert_not_root(self):
        if os.geteuid() == 0:
            self.skipTest("root 用户绕过文件权限，该断言仅对普通用户有效")
