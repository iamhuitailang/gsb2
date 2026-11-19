"""路径规范化、符号链接逃逸、路径冲突与特殊文件处理。"""

from __future__ import annotations

import os

from forensics.collector import collect
from forensics.models import (
    Entry,
    STATUS_COLLECTED,
    STATUS_CONFLICT,
    STATUS_OUT_OF_BOUNDS,
    STATUS_RECORDED,
    STATUS_SKIPPED,
)
from forensics.paths import (
    is_within_root,
    normalize_root,
    safe_join_copy_root,
    PathError,
)
from forensics.planner import plan_entries

from tests._helpers import TempTreeTestCase


class PathNormalizationTests(TempTreeTestCase):
    def test_root_with_dotdot_and_dot_segments(self):
        self.write("a.txt", "a")
        self.write("sub/b.txt", "bb")
        # 根目录用包含 ./ 与 ../ 的变体给出，规范化后必须与真实根一致
        weird_root = os.path.join(
            self.workdir, ".", "src", "..", "src", ".", ""
        )
        result = collect(self.case_dir, weird_root)
        self.assertEqual(result.case_status, "complete")
        # 清单里记录的源根目录是规范化后的真实路径
        meta_root = self.manifest()["source_root"]
        self.assertEqual(meta_root, os.path.realpath(self.src))
        self.assertEqual(
            {e["rel_path"] for e in self.manifest()["entries"]},
            {"a.txt", "sub", "sub/b.txt"},
        )

    def test_relative_root_resolved_from_cwd(self):
        self.write("a.txt", "a")
        cwd = os.getcwd()
        try:
            os.chdir(self.workdir)
            result = collect("case_rel", "src")
            self.assertEqual(result.case_status, "complete")
        finally:
            os.chdir(cwd)
            if os.path.exists(os.path.join(self.workdir, "case_rel")):
                pass  # tearDown 统一清理

    def test_nonexistent_root_rejected(self):
        with self.assertRaises(PathError):
            normalize_root(os.path.join(self.workdir, "no-such-dir"))

    def test_is_within_root_lexical_checks(self):
        root = "/tmp/case-root"
        self.assertTrue(is_within_root(root, "/tmp/case-root/a/b"))
        self.assertTrue(is_within_root(root, "/tmp/case-root"))
        self.assertFalse(is_within_root(root, "/tmp/case-root-other/x"))
        self.assertFalse(is_within_root(root, "/tmp/other"))

    def test_safe_join_copy_root_rejects_escape(self):
        copy_root = os.path.join(self.workdir, "copies")
        os.makedirs(copy_root)
        self.assertEqual(
            safe_join_copy_root(copy_root, "a/b.txt"),
            os.path.join(copy_root, "a", "b.txt"),
        )
        for evil in ("../escape.txt", "a/../../escape.txt", "/abs/path"):
            with self.assertRaises(PathError):
                safe_join_copy_root(copy_root, evil)


class SymlinkEscapeTests(TempTreeTestCase):
    def _build_outside(self):
        outside = os.path.join(self.workdir, "outside")
        os.makedirs(outside)
        secret = os.path.join(outside, "secret.txt")
        with open(secret, "w", encoding="utf-8") as fh:
            fh.write("OUTSIDE-SECRET-CONTENT-MARKER")
        return outside, secret

    def test_relative_symlink_escape_is_blocked(self):
        outside, secret = self._build_outside()
        self.write("docs/a.txt", "inside")
        self.symlink("docs/escape.link",
                     os.path.join("..", "..", "outside", "secret.txt"))

        result = collect(self.case_dir, self.src)
        # 其他文件照常成功，逃逸条目单独标记
        self.assertEqual(result.stats.collected, 1)
        self.assertEqual(result.stats.out_of_bounds, 1)

        entry = self.entry("docs/escape.link")
        self.assertEqual(entry["status"], STATUS_OUT_OF_BOUNDS)
        self.assertEqual(entry["reason"], "symlink_escape")
        # 越界内容绝不能出现在副本目录
        for dirpath, _dirs, files in os.walk(os.path.join(self.case_dir, "copies")):
            for name in files:
                with open(os.path.join(dirpath, name), "rb") as fh:
                    self.assertNotIn(b"OUTSIDE-SECRET-CONTENT-MARKER", fh.read())
        self.assertFalse(self.copy_exists("docs/escape.link"))

    def test_absolute_symlink_escape_is_blocked(self):
        outside, secret = self._build_outside()
        self.symlink("abs_escape.link", secret)
        result = collect(self.case_dir, self.src)
        self.assertEqual(result.stats.out_of_bounds, 1)
        entry = self.entry("abs_escape.link")
        self.assertEqual(entry["status"], STATUS_OUT_OF_BOUNDS)
        self.assertFalse(self.copy_exists("abs_escape.link"))

    def test_symlink_directory_never_entered(self):
        outside, _secret = self._build_outside()
        # 指向根外目录的符号链接目录：不能被递归扫描
        self.symlink("outside_dir.link", outside)
        result = collect(self.case_dir, self.src)
        self.assertEqual(result.stats.out_of_bounds, 1)
        rels = {e["rel_path"] for e in self.manifest()["entries"]}
        self.assertNotIn("outside_dir.link/secret.txt", rels)
        self.assertIn("outside_dir.link", rels)

    def test_in_bounds_symlink_recorded_but_not_copied(self):
        self.write("docs/real.txt", "real content")
        self.symlink("docs/alias.link", "real.txt")
        result = collect(self.case_dir, self.src)
        self.assertEqual(result.case_status, "complete")
        link_entry = self.entry("docs/alias.link")
        self.assertEqual(link_entry["status"], STATUS_RECORDED)
        self.assertEqual(link_entry["entry_type"], "symlink")
        self.assertEqual(link_entry["symlink_target"], "real.txt")
        # 链接本身不产生副本；目标文件作为普通文件正常采集
        self.assertFalse(self.copy_exists("docs/alias.link"))
        self.assertTrue(self.copy_exists("docs/real.txt"))
        self.assertEqual(result.stats.recorded, 2)  # docs 目录 + 链接

    def test_chained_symlink_escape_detected(self):
        # 链接 A 指向根内链接 B，B 再指向根外：多层跳转也要识别
        outside, secret = self._build_outside()
        self.symlink("b.link", secret)           # 直接逃逸
        self.symlink("a.link", "b.link")         # 指向根内链接
        collect(self.case_dir, self.src)
        statuses = {
            e["rel_path"]: e["status"] for e in self.manifest()["entries"]
        }
        self.assertEqual(statuses["b.link"], STATUS_OUT_OF_BOUNDS)
        self.assertEqual(statuses["a.link"], STATUS_OUT_OF_BOUNDS)


class ConflictPlannerTests(TempTreeTestCase):
    def _entry(self, rel, abs_path=None, size=1):
        return Entry(
            rel_path=rel,
            abs_path=abs_path or os.path.join(self.src, rel),
            entry_type="regular",
            size=size,
            mode=0o644,
        )

    def test_duplicate_normalized_relpath_flagged(self):
        e1 = self._entry("a.txt", os.path.join(self.src, "a.txt"))
        e2 = self._entry("a.txt", os.path.join(self.src, "sub", "..", "a.txt"))
        planned = plan_entries(self.src, [e1, e2], [])
        statuses = sorted(e.status for e in planned)
        self.assertIn(STATUS_CONFLICT, statuses)
        conflict = [e for e in planned if e.status == STATUS_CONFLICT][0]
        self.assertEqual(conflict.reason, "duplicate_relpath")

    def test_case_insensitive_collision_flagged(self):
        e1 = self._entry("Report.txt")
        e2 = self._entry("REPORT.TXT")
        planned = plan_entries(self.src, [e1, e2], [])
        conflict = [e for e in planned if e.status == STATUS_CONFLICT]
        self.assertEqual(len(conflict), 1)
        self.assertEqual(conflict[0].reason, "case_insensitive_collision")
        # 另一个保持可采集
        pending = [e for e in planned if e.status == "pending"]
        self.assertEqual(len(pending), 1)

    def test_real_fs_case_collision_or_distinct_files(self):
        # 集成层面：能建两个文件就应被规划器识别；建不出来（大小写不敏感
        # 文件系统）则跳过，单元测试已覆盖同一逻辑
        d = os.path.join(self.src, "mix")
        os.makedirs(d)
        p1 = os.path.join(d, "Report.txt")
        p2 = os.path.join(d, "REPORT.TXT")
        with open(p1, "w") as fh:
            fh.write("one")
        with open(p2, "w") as fh:
            fh.write("two")
        collect(self.case_dir, self.src)
        if not os.path.samefile(p1, p2):
            conflicts = self.entries_by_status(STATUS_CONFLICT)
            self.assertTrue(any(
                e["reason"] == "case_insensitive_collision" for e in conflicts
            ))


class SpecialFileTests(TempTreeTestCase):
    def test_fifo_skipped_never_opened(self):
        self.write("normal.txt", "ok")
        self.make_fifo("pipe.fifo")
        result = collect(self.case_dir, self.src)
        # FIFO 被跳过不算失败，案件仍可完整
        self.assertEqual(result.case_status, "complete")
        entry = self.entry("pipe.fifo")
        self.assertEqual(entry["status"], STATUS_SKIPPED)
        self.assertEqual(entry["reason"], "special_file")
        self.assertFalse(self.copy_exists("pipe.fifo"))

    def test_unreadable_directory_recorded_as_failed_but_others_survive(self):
        if self.is_root():
            self.skipTest("root 绕过权限位，无法模拟不可读目录")
        self.write("ok.txt", "fine")
        self.make_unreadable_dir("locked_dir")
        result = collect(self.case_dir, self.src)
        # 单个目录不可读不抹掉其他文件
        self.assertEqual(result.stats.collected, 1)
        self.assertGreaterEqual(result.stats.failed, 1)
        failed = [e for e in self.manifest()["entries"]
                  if e["status"] == "failed"]
        self.assertTrue(failed)
        self.assertEqual(failed[0]["reason"], "unreadable_directory")
        self.assertTrue(self.copy_exists("ok.txt"))
