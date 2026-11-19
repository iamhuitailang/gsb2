"""读取失败、采集中源文件变化、采集上限。"""

from __future__ import annotations

import os
import time

from forensics.collector import collect
from forensics.models import (
    CASE_FAILED,
    CASE_PARTIAL,
    STATUS_COLLECTED,
    STATUS_FAILED,
    STATUS_LIMIT_EXCEEDED,
)

from tests._helpers import TempTreeTestCase


class ReadFailureTests(TempTreeTestCase):
    def test_unreadable_file_marked_failed_not_collected(self):
        if self.is_root():
            self.skipTest("root 绕过权限位，无法模拟权限错误")
        self.write("ok.txt", "fine")
        self.write("locked.txt", "cannot read me")
        self.make_unreadable("locked.txt")

        result = collect(self.case_dir, self.src)
        # 案件部分完成：有权限问题但其他文件成功
        self.assertEqual(result.case_status, CASE_PARTIAL)
        self.assertEqual(result.stats.collected, 1)
        self.assertEqual(result.stats.failed, 1)

        locked = self.entry("locked.txt")
        self.assertEqual(locked["status"], STATUS_FAILED)
        self.assertEqual(locked["reason"], "permission_denied")
        self.assertIsNone(locked.get("sha256"))
        self.assertFalse(self.copy_exists("locked.txt"))
        # 其他文件不受影响
        self.assertTrue(self.copy_exists("ok.txt"))

    def test_all_files_fail_gives_failed_case(self):
        if self.is_root():
            self.skipTest("root 绕过权限位，无法模拟权限错误")
        self.write("a.txt", "a")
        self.write("b.txt", "b")
        self.make_unreadable("a.txt")
        self.make_unreadable("b.txt")
        result = collect(self.case_dir, self.src)
        self.assertEqual(result.case_status, CASE_FAILED)
        self.assertEqual(result.stats.collected, 0)

    def test_source_disappears_during_collection(self):
        self.write("a.txt", "a")
        gone = self.write("b.txt", "b")

        def hook(entry, _bytes_read):
            if entry.rel_path == "b.txt":
                os.unlink(gone)

        result = collect(self.case_dir, self.src, mid_read_hook=hook)
        statuses = {e["rel_path"]: e["status"]
                    for e in self.manifest()["entries"]}
        self.assertEqual(statuses["a.txt"], STATUS_COLLECTED)
        self.assertEqual(statuses["b.txt"], STATUS_FAILED)
        self.assertEqual(result.case_status, CASE_PARTIAL)

    def test_changed_during_read_detected(self):
        # 文件大于读取块大小，保证 hook 触发后仍有后续读取，
        # 使“采集后快照变化”检测必然生效。
        from forensics.collector import COPY_CHUNK
        path = self.write("changing.txt", b"a" * (COPY_CHUNK + 4096))
        self.write("stable.txt", "stable")

        def hook(entry, _bytes_read):
            if entry.rel_path == "changing.txt":
                # 保证 mtime 分辨率足够区分
                time.sleep(0.02)
                with open(path, "wb") as fh:
                    fh.write(b"b" * (COPY_CHUNK + 4096))

        result = collect(self.case_dir, self.src, mid_read_hook=hook)
        entry = self.entry("changing.txt")
        self.assertEqual(entry["status"], STATUS_FAILED)
        self.assertEqual(entry["reason"], "changed_during_read")
        self.assertFalse(self.copy_exists("changing.txt"))
        # 稳定文件照常采集
        self.assertTrue(self.copy_exists("stable.txt"))
        self.assertEqual(result.case_status, CASE_PARTIAL)

    def test_file_grows_during_read_detected(self):
        from forensics.collector import COPY_CHUNK
        path = self.write("grow.txt", b"x" * (COPY_CHUNK + 1024))

        def hook(entry, _bytes_read):
            with open(path, "ab") as fh:
                fh.write(b"EXTRA-BYTES")

        result = collect(self.case_dir, self.src, mid_read_hook=hook)
        entry = self.entry("grow.txt")
        self.assertEqual(entry["status"], STATUS_FAILED)
        # 增长场景要么短读要么变化检测命中，二者都属失败
        self.assertIn(entry["reason"],
                      {"short_read", "changed_during_read"})
        self.assertFalse(self.copy_exists("grow.txt"))


class LimitTests(TempTreeTestCase):
    def test_max_files_limit_marks_remaining_explicitly(self):
        for i in range(5):
            self.write(f"f{i}.txt", f"content-{i}")
        result = collect(self.case_dir, self.src, max_files=2)
        self.assertEqual(result.case_status, CASE_PARTIAL)
        self.assertEqual(result.stats.collected, 2)
        self.assertEqual(result.stats.limit_exceeded, 3)
        limited = self.entries_by_status(STATUS_LIMIT_EXCEEDED)
        self.assertEqual(len(limited), 3)
        for e in limited:
            self.assertEqual(e["reason"], "max_files_limit")
            self.assertFalse(self.copy_exists(e["rel_path"]))
        # 上限配置必须写入案件元数据
        self.assertEqual(self.manifest()["limits"]["max_files"], 2)

    def test_max_bytes_limit(self):
        self.write("small.txt", "x" * 10)          # 10
        self.write("big.txt", "y" * 1000)          # 1000
        self.write("mid.txt", "z" * 100)           # 100
        result = collect(self.case_dir, self.src, max_bytes=500)
        # 字典序: big.txt(1000) 先超限 -> limit; mid.txt(100) 纳入;
        # small.txt(10) 纳入
        self.assertEqual(result.stats.collected, 2)
        limited = self.entries_by_status(STATUS_LIMIT_EXCEEDED)
        self.assertEqual([e["rel_path"] for e in limited], ["big.txt"])
        self.assertEqual(limited[0]["reason"], "max_bytes_limit")
        self.assertTrue(self.copy_exists("mid.txt"))
        self.assertTrue(self.copy_exists("small.txt"))

    def test_limit_zero_collects_nothing_explicitly(self):
        self.write("a.txt", "a")
        result = collect(self.case_dir, self.src, max_files=0)
        self.assertEqual(result.stats.limit_exceeded, 1)
        self.assertEqual(result.stats.collected, 0)
        self.assertEqual(result.case_status, CASE_PARTIAL)

    def test_limits_are_reported_in_case_info(self):
        self.write("a.txt", "a")
        collect(self.case_dir, self.src, max_files=1, max_bytes=10)
        meta = self.manifest()
        self.assertEqual(meta["limits"],
                         {"max_files": 1, "max_bytes": 10})
