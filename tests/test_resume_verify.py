"""中断恢复与复核发现篡改/损坏/意外新增。"""

from __future__ import annotations

import hashlib
import json
import os

from forensics.collector import collect
from forensics.manifest import (
    check_manifest_integrity,
    copy_root,
    write_manifest,
)
from forensics.models import CASE_COMPLETE, CASE_IN_PROGRESS, STATUS_COLLECTED
from forensics.verifier import verify_case

from tests._helpers import TempTreeTestCase


class InterruptResumeTests(TempTreeTestCase):
    def test_interrupt_leaves_in_progress_case(self):
        for i in range(4):
            self.write(f"f{i}.txt", f"content-{i}\n")

        def hook(entry, _bytes_read):
            if entry.rel_path == "f2.txt":
                raise KeyboardInterrupt()

        result = collect(self.case_dir, self.src, mid_read_hook=hook)
        self.assertTrue(result.interrupted)
        self.assertEqual(result.case_status, CASE_IN_PROGRESS)
        # 半成品标记存在；已处理条目落盘，未处理条目标 interrupted
        self.assertTrue(
            os.path.exists(os.path.join(self.case_dir, ".in_progress"))
        )
        interrupted = [
            e for e in self.manifest()["entries"]
            if e.get("reason") == "interrupted"
        ]
        self.assertTrue(interrupted)
        # 已成功的副本仍然保留，清单自洽可读
        ok, problem, manifest = check_manifest_integrity(self.case_dir)
        self.assertTrue(ok, problem)
        collected = [e for e in manifest["entries"]
                     if e["status"] == STATUS_COLLECTED]
        self.assertTrue(collected)

    def test_resume_completes_and_reuses_copies(self):
        for i in range(4):
            self.write(f"f{i}.txt", f"content-{i}\n")

        def hook(entry, _bytes_read):
            if entry.rel_path == "f2.txt":
                raise KeyboardInterrupt()

        first = collect(self.case_dir, self.src, mid_read_hook=hook)
        self.assertEqual(first.case_status, CASE_IN_PROGRESS)

        second = collect(self.case_dir)
        self.assertEqual(second.case_status, CASE_COMPLETE)
        self.assertGreater(second.stats.reused, 0)
        self.assertGreater(second.stats.reprocessed, 0)
        # 标记已清除，全部文件有副本
        self.assertFalse(
            os.path.exists(os.path.join(self.case_dir, ".in_progress"))
        )
        for i in range(4):
            self.assertTrue(self.copy_exists(f"f{i}.txt"))
        # 复核通过
        report = verify_case(self.case_dir)
        self.assertTrue(report.ok)

    def test_resume_after_corrupted_copy_reprocesses(self):
        self.write("a.txt", "aaa")
        self.write("b.txt", "bbb")
        # 先正常采集
        collect(self.case_dir, self.src)
        # 人为制造“完整案件”无法直接续采，先改回非 complete 并损坏一个副本
        meta_path = os.path.join(self.case_dir, "case.json")
        with open(meta_path, "rb") as fh:
            meta = json.loads(fh.read())
        meta["case_status"] = "partial"
        with open(meta_path, "w", encoding="utf-8") as fh:
            json.dump(meta, fh)
        bad = os.path.join(self.case_dir, "copies", "a.txt")
        with open(bad, "wb") as fh:
            fh.write(b"corrupted-bytes")

        result = collect(self.case_dir)
        self.assertEqual(result.case_status, CASE_COMPLETE)
        # 损坏副本被重新采集，最终内容恢复正确
        with open(bad, "rb") as fh:
            self.assertEqual(fh.read(), b"aaa")
        self.assertTrue(verify_case(self.case_dir).ok)

    def test_resume_keeps_copy_when_source_vanished(self):
        self.write("a.txt", "aaa")
        self.write("b.txt", "bbb")
        collect(self.case_dir, self.src)
        # 置为非 complete 后删除源文件 b.txt
        meta_path = os.path.join(self.case_dir, "case.json")
        with open(meta_path, "rb") as fh:
            meta = json.loads(fh.read())
        meta["case_status"] = "partial"
        with open(meta_path, "w", encoding="utf-8") as fh:
            json.dump(meta, fh)
        os.unlink(os.path.join(self.src, "b.txt"))

        result = collect(self.case_dir)
        self.assertEqual(result.case_status, CASE_COMPLETE)
        # 源已消失但原副本保留，明细里有说明
        self.assertTrue(self.copy_exists("b.txt"))
        entry = self.entry("b.txt")
        self.assertEqual(entry["status"], STATUS_COLLECTED)
        self.assertIn("源文件已消失", entry["detail"])

    def test_resume_refuses_when_manifest_corrupted(self):
        from forensics.collector import CollectionError
        self.write("a.txt", "aaa")
        collect(self.case_dir, self.src)
        meta_path = os.path.join(self.case_dir, "case.json")
        with open(meta_path, "rb") as fh:
            meta = json.loads(fh.read())
        meta["case_status"] = "partial"
        with open(meta_path, "w", encoding="utf-8") as fh:
            json.dump(meta, fh)
        with open(os.path.join(self.case_dir, "MANIFEST.json"), "w") as fh:
            fh.write("{ broken json")
        with self.assertRaises(CollectionError):
            collect(self.case_dir)

    def test_resume_refuses_unknown_manifest_fields(self):
        from forensics.collector import CollectionError
        from forensics.manifest import write_manifest
        self.write("a.txt", "aaa")
        collect(self.case_dir, self.src)
        meta_path = os.path.join(self.case_dir, "case.json")
        with open(meta_path, "rb") as fh:
            meta = json.loads(fh.read())
        meta["case_status"] = "partial"
        with open(meta_path, "w", encoding="utf-8") as fh:
            json.dump(meta, fh)
        # 校验和仍然有效，但条目里混入工具不认识的字段
        manifest = self.manifest()
        manifest["entries"][0]["unexpected_field"] = "x"
        write_manifest(self.case_dir, manifest)
        with self.assertRaises(CollectionError):
            collect(self.case_dir)


class VerifyTests(TempTreeTestCase):
    def _full_case(self):
        self.write("a.txt", "alpha")
        self.write("sub/b.txt", "beta")
        collect(self.case_dir, self.src)

    def test_verify_detects_modified_copy(self):
        self._full_case()
        tampered = os.path.join(self.case_dir, "copies", "a.txt")
        with open(tampered, "wb") as fh:
            fh.write(b"alpha-TAMPERED")
        report = verify_case(self.case_dir)
        self.assertFalse(report.ok)
        self.assertEqual([c["rel_path"] for c in report.changed], ["a.txt"])
        self.assertEqual(report.missing, [])
        self.assertEqual(report.verified_files, 1)

    def test_verify_detects_missing_copy(self):
        self._full_case()
        os.unlink(os.path.join(self.case_dir, "copies", "sub", "b.txt"))
        report = verify_case(self.case_dir)
        self.assertFalse(report.ok)
        self.assertEqual([m["rel_path"] for m in report.missing],
                         ["sub/b.txt"])

    def test_verify_detects_unexpected_addition(self):
        self._full_case()
        extra = os.path.join(copy_root(self.case_dir), "planted.txt")
        with open(extra, "w", encoding="utf-8") as fh:
            fh.write("not in manifest")
        report = verify_case(self.case_dir)
        self.assertFalse(report.ok)
        self.assertEqual(
            [u["rel_path"] for u in report.unexpected], ["planted.txt"]
        )

    def test_verify_detects_manifest_checksum_tampering(self):
        self._full_case()
        manifest_path = os.path.join(self.case_dir, "MANIFEST.json")
        with open(manifest_path, "rb") as fh:
            manifest = json.loads(fh.read())
        manifest["entries"][0]["size"] = 999999
        # 直接改写但不更新校验和，模拟篡改
        with open(manifest_path, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh)
        ok, problem, _ = check_manifest_integrity(self.case_dir)
        self.assertFalse(ok)
        self.assertIn("校验和不匹配", problem)
        report = verify_case(self.case_dir)
        self.assertFalse(report.manifest_ok)

    def test_verify_detects_missing_manifest(self):
        self._full_case()
        os.unlink(os.path.join(self.case_dir, "MANIFEST.json"))
        ok, problem, _ = check_manifest_integrity(self.case_dir)
        self.assertFalse(ok)
        self.assertIn("缺失", problem)

    def test_rewrite_manifest_restores_checksum(self):
        self._full_case()
        manifest_path = os.path.join(self.case_dir, "MANIFEST.json")
        with open(manifest_path, "rb") as fh:
            manifest = json.loads(fh.read())
        # 通过正规接口重写：校验和同步更新，应当仍然完好
        write_manifest(self.case_dir, manifest)
        ok, problem, _ = check_manifest_integrity(self.case_dir)
        self.assertTrue(ok, problem)

    def test_verify_check_source_reports_drift(self):
        self._full_case()
        with open(os.path.join(self.src, "a.txt"), "wb") as fh:
            fh.write(b"changed-on-source")
        report = verify_case(self.case_dir, check_source=True)
        self.assertEqual(
            [d["rel_path"] for d in report.source_drift], ["a.txt"]
        )
        # 不开启源端检查时，离线复核仍然通过（副本与清单一致）
        offline = verify_case(self.case_dir, check_source=False)
        self.assertTrue(offline.ok)

    def test_verify_partial_case_lists_entry_problems(self):
        if self.is_root():
            self.skipTest("root 绕过权限位")
        self.write("ok.txt", "fine")
        self.write("locked.txt", "no")
        self.make_unreadable("locked.txt")
        collect(self.case_dir, self.src)
        report = verify_case(self.case_dir)
        self.assertTrue(report.manifest_ok)
        self.assertEqual(
            [p["rel_path"] for p in report.entry_problems], ["locked.txt"]
        )

    def test_report_is_stable_across_runs(self):
        self._full_case()
        # 制造多种差异，确认两次复核输出完全一致、顺序稳定
        with open(os.path.join(self.case_dir, "copies", "a.txt"), "wb") as fh:
            fh.write(b"x")
        os.unlink(os.path.join(self.case_dir, "copies", "sub", "b.txt"))
        r1 = verify_case(self.case_dir).as_dict()
        r2 = verify_case(self.case_dir).as_dict()
        self.assertEqual(r1, r2)
        self.assertEqual([c["rel_path"] for c in r1["changed"]], ["a.txt"])
        self.assertEqual([m["rel_path"] for m in r1["missing"]],
                         ["sub/b.txt"])
