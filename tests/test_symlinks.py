"""符号链接安全测试：越界、循环、断裂、目录内链接，以及读取失败隔离。"""

import os

from tests._helpers import AuditTestCase


class SymlinkTests(AuditTestCase):
    def test_outside_root_symlink_is_never_followed(self):
        outside = os.path.join(self.tmp, "outside-secret.txt")
        with open(outside, "w", encoding="utf-8") as handle:
            handle.write("TOP-SECRET-MARKER outside the audit root\n")
        self.symlink("links/escape", outside)

        run = self.scan()

        # 有明确的越界通知
        self.assertIn("symlink_outside_root", self.notice_codes(run))
        # 外部文件绝不出现在任何相对路径或证据中
        serialized = str(run)
        self.assertNotIn("TOP-SECRET-MARKER", serialized)
        self.assertNotIn("outside-secret.txt", serialized)
        # 外部文件未被当作扫描条目
        rels = {f["rel_path"] for f in run["findings"]}
        self.assertNotIn("outside-secret.txt", rels)

    def test_symlink_loop_does_not_break_scan(self):
        self.symlink("links/loop-a", "loop-b")
        self.symlink("links/loop-b", "loop-a")
        # 同目录还有一个正常文件，证明遍历没有中断
        self.write("links/normal.txt", "ok\n", 0o644)

        run = self.scan()
        self.assertIn("symlink_loop", self.notice_codes(run))
        # 同目录正常文件仍被扫描，证明遍历没有中断
        scanned_rels = set()
        for f in run["findings"]:
            scanned_rels.add(f["rel_path"])
        self.assertNotIn("links/loop-a", scanned_rels)
        self.assertGreaterEqual(run["stats"]["entries_scanned"], 3)

    def test_broken_symlink_is_reported_but_not_followed(self):
        self.symlink("links/broken", "does-not-exist")
        run = self.scan()
        self.assertIn("symlink_broken", self.notice_codes(run))

    def test_internal_symlink_is_not_followed_either(self):
        self.write("etc/sshd_config", "PermitRootLogin yes\n", 0o644)
        self.symlink("links/internal", "../etc/sshd_config")
        run = self.scan()
        self.assertIn("symlink_in_scope", self.notice_codes(run))
        # 真实文件按自身路径只被分析一次，链接不产生重复发现
        ssh_hits = [f for f in run["findings"]
                    if f["rel_path"] == "etc/sshd_config"
                    and f["rule_id"] == "SVC-SSHD-PERMIT-ROOT-LOGIN"]
        self.assertEqual(len(ssh_hits), 1)

    def test_unreadable_directory_is_isolated(self):
        self.assert_not_root()
        locked = os.path.join(self.root, "locked")
        os.makedirs(locked)
        with open(os.path.join(locked, "hidden.txt"), "w", encoding="utf-8") as h:
            h.write("x\n")
        os.chmod(locked, 0o000)
        # 同级正常文件仍能被扫描，单次失败不清除已有结果
        self.write("visible.txt", "ok\n", 0o644)

        run = self.scan()
        self.assertIn("scandir_failed", self.notice_codes(run, "read_error"))
        rels = {n["rel"] for n in run["notices"]}
        self.assertIn("locked", rels)
        self.assertNotIn("locked/hidden.txt", str(run))

    def test_unsupported_file_type_is_skipped_with_notice(self):
        fifo = os.path.join(self.root, "pipe.fifo")
        try:
            os.mkfifo(fifo)
        except (OSError, AttributeError):
            self.skipTest("当前平台不支持 mkfifo")
        run = self.scan()
        self.assertIn("unsupported_file_type", self.notice_codes(run))
