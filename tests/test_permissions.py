"""权限规则测试：安全与风险权限组合。"""

import os
import stat

from tests._helpers import AuditTestCase


class PermissionTests(AuditTestCase):
    def test_world_writable_file_is_high_risk(self):
        self.write("conf/open.conf", "x=1\n", 0o666)
        run = self.scan()
        hits = self.by_rule(run, "PERM-WORLD-WRITABLE-FILE")
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["severity"], "high")
        self.assertEqual(hits[0]["rel_path"], "conf/open.conf")
        self.assertIn("0o666", hits[0]["evidence"]["mode"])

    def test_normal_permissions_produce_no_permission_findings(self):
        self.write("conf/app.conf", "x=1\n", 0o644)
        os.makedirs(os.path.join(self.root, "bin"))
        self.write("bin/run.sh", "echo ok\n", 0o755)
        run = self.scan()
        perm_rules = {f["rule_id"] for f in run["findings"]
                      if f["rule_id"].startswith("PERM-")}
        self.assertEqual(perm_rules, set())

    def test_world_writable_dir_without_sticky_bit(self):
        os.makedirs(os.path.join(self.root, "shared"))
        os.chmod(os.path.join(self.root, "shared"), 0o777)
        run = self.scan()
        hits = self.by_rule(run, "PERM-WORLD-WRITABLE-DIR")
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["severity"], "medium")

    def test_sticky_world_writable_dir_is_accepted(self):
        os.makedirs(os.path.join(self.root, "tmp"))
        os.chmod(os.path.join(self.root, "tmp"), 0o1777)
        run = self.scan()
        self.assertEqual(self.by_rule(run, "PERM-WORLD-WRITABLE-DIR"), [])

    def test_setuid_and_setgid_bits(self):
        self.write("bin/suid", "x\n", 0o4755)
        self.write("bin/sgid", "x\n", 0o2755)
        run = self.scan()
        self.assertEqual(len(self.by_rule(run, "PERM-SETUID")), 1)
        self.assertEqual(len(self.by_rule(run, "PERM-SETGID")), 1)

    def test_sensitive_world_readable(self):
        self.write("etc/app.key", "fake\n", 0o644)
        run = self.scan()
        hits = self.by_rule(run, "PERM-SENSITIVE-WORLD-READABLE")
        self.assertEqual(len(hits), 1)
        # 收紧权限后该发现应消失（第二次核查里以 disappeared 状态保留历史）
        os.chmod(os.path.join(self.root, "etc/app.key"), 0o600)
        run2 = self.scan()
        current_hits = [f for f in self.by_rule(run2, "PERM-SENSITIVE-WORLD-READABLE")
                        if f["status"] != "disappeared"]
        self.assertEqual(current_hits, [])

    def test_group_writable_config(self):
        self.write("etc/app.conf", "x=1\n", 0o664)
        run = self.scan()
        self.assertEqual(len(self.by_rule(run, "PERM-GROUP-WRITABLE-CONFIG")), 1)

    def test_finding_carries_reason_and_remediation(self):
        self.write("conf/open.conf", "x=1\n", 0o666)
        run = self.scan()
        finding = self.by_rule(run, "PERM-WORLD-WRITABLE-FILE")[0]
        self.assertTrue(finding["reason"])
        self.assertTrue(finding["remediation"])
        self.assertTrue(finding["id"].startswith("F-"))
