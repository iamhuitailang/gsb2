"""正常采集、清单内容、案件状态与 CLI 基础行为。"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys

from forensics.collector import collect, create_case, CollectionError
from forensics.models import CASE_COMPLETE, CASE_NEW
from forensics.verifier import verify_case

from tests._helpers import TempTreeTestCase


class NormalCollectionTests(TempTreeTestCase):
    def test_full_collection_and_manifest_fields(self):
        self.write("a.txt", "alpha\n")
        self.write("sub/b.txt", "beta beta\n")
        self.mkdir("empty_dir")

        result = collect(self.case_dir, self.src)
        self.assertEqual(result.case_status, CASE_COMPLETE)
        self.assertEqual(result.stats.collected, 2)
        self.assertEqual(result.stats.total_bytes, len("alpha\n") + len("beta beta\n"))

        # 案件目录结构
        for name in ("case.json", "MANIFEST.json", "MANIFEST.sha256",
                     "copies", "events.log"):
            self.assertTrue(os.path.exists(os.path.join(self.case_dir, name)),
                            f"缺少案件组成部分: {name}")
        # 完整案件不得留下半成品标记
        self.assertFalse(
            os.path.exists(os.path.join(self.case_dir, ".in_progress"))
        )

        # 副本内容与源一致，且保持相对目录结构
        self.assertTrue(self.copy_exists("a.txt"))
        self.assertTrue(self.copy_exists("sub/b.txt"))
        with open(os.path.join(self.case_dir, "copies", "a.txt"), "rb") as fh:
            self.assertEqual(fh.read(), b"alpha\n")

        entry = self.entry("a.txt")
        self.assertEqual(entry["status"], "collected")
        self.assertEqual(entry["entry_type"], "regular")
        self.assertEqual(entry["size"], len("alpha\n"))
        self.assertEqual(entry["sha256"],
                         hashlib.sha256(b"alpha\n").hexdigest())
        self.assertTrue(entry["mode"].startswith("0o"))
        self.assertIn("mtime_ns", entry)
        self.assertEqual(entry["copy_path"], "copies/a.txt")

        # 目录条目仅登记，不产生副本
        dir_entry = self.entry("empty_dir")
        self.assertEqual(dir_entry["status"], "recorded")
        self.assertFalse(self.copy_exists("empty_dir"))

        # 复核应当通过且结果稳定（连跑两次字典完全相同）
        r1 = verify_case(self.case_dir).as_dict()
        r2 = verify_case(self.case_dir).as_dict()
        self.assertTrue(r1["manifest_ok"])
        self.assertEqual(r1["verified_files"], 2)
        self.assertEqual(r1, r2)

    def test_empty_source_is_complete(self):
        result = collect(self.case_dir, self.src)
        self.assertEqual(result.case_status, CASE_COMPLETE)
        self.assertEqual(result.stats.collected, 0)

    def test_create_then_collect(self):
        meta = create_case(self.case_dir, self.src)
        self.assertEqual(meta["case_status"], CASE_NEW)
        self.write("x.txt", "x")
        result = collect(self.case_dir)
        self.assertEqual(result.case_status, CASE_COMPLETE)
        self.assertEqual(result.stats.collected, 1)

    def test_refuse_overwrite_nonempty_case(self):
        collect(self.case_dir, self.src)
        with self.assertRaises(CollectionError):
            create_case(self.case_dir, self.src)

    def test_refuse_collect_completed_case(self):
        self.write("a.txt", "a")
        collect(self.case_dir, self.src)
        with self.assertRaises(CollectionError):
            collect(self.case_dir)

    def test_case_json_and_manifest_are_valid_json(self):
        self.write("a.txt", "a")
        collect(self.case_dir, self.src)
        for name in ("case.json", "MANIFEST.json"):
            with open(os.path.join(self.case_dir, name), "rb") as fh:
                json.loads(fh.read().decode("utf-8"))

    def test_deterministic_manifest_bytes(self):
        self.write("a.txt", "a")
        self.write("b.txt", "bb")
        collect(self.case_dir, self.src)
        with open(os.path.join(self.case_dir, "MANIFEST.json"), "rb") as fh:
            first = fh.read()
        # 再跑一次复核不改变清单字节
        verify_case(self.case_dir)
        with open(os.path.join(self.case_dir, "MANIFEST.json"), "rb") as fh:
            second = fh.read()
        self.assertEqual(first, second)


class CliTests(TempTreeTestCase):
    def _run(self, *args):
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        cmd = [sys.executable, "-I",
               os.path.join(repo_root, "forensics_cli.py"), *args]
        proc = subprocess.run(
            cmd, cwd=repo_root, capture_output=True, text=True
        )
        return proc

    def test_cli_create_collect_info_verify(self):
        self.write("a.txt", "alpha")

        p = self._run("create", self.case_dir, self.src)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("成功", p.stdout)

        p = self._run("collect", self.case_dir)
        self.assertEqual(p.returncode, 0, p.stderr)

        p = self._run("info", self.case_dir)
        self.assertEqual(p.returncode, 0)
        self.assertIn("a.txt", p.stdout)
        # 报告不得输出文件正文
        self.assertNotIn("alpha", p.stdout)

        p = self._run("verify", self.case_dir)
        self.assertEqual(p.returncode, 0)
        self.assertIn("复核通过", p.stdout)

        p = self._run("verify", self.case_dir, "--json")
        self.assertEqual(p.returncode, 0)
        payload = json.loads(p.stdout)
        self.assertTrue(payload["manifest_ok"])

    def test_cli_missing_case_returns_error_code(self):
        p = self._run("info", os.path.join(self.workdir, "nope"))
        self.assertEqual(p.returncode, 2)
        self.assertIn("失败", p.stdout)

    def test_cli_invalid_source_reports_clean_error_no_traceback(self):
        bad_source = os.path.join(self.workdir, "no-such-source")
        p = self._run("create",
                      os.path.join(self.workdir, "c"), bad_source)
        self.assertEqual(p.returncode, 2)
        self.assertIn("失败", p.stdout)
        # 必须是可读的单行错误，而不是 Python traceback
        self.assertNotIn("Traceback", p.stdout)
        self.assertNotIn("PathError", p.stdout)

    def test_cli_missing_subcommand_returns_usage_error(self):
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        proc = subprocess.run(
            [sys.executable, "-I",
             os.path.join(repo_root, "forensics_cli.py")],
            cwd=repo_root, capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 2)
        self.assertIn("usage", proc.stderr.lower())

    def test_cli_report_never_prints_file_content(self):
        secret = "THE-FICTIONAL-SECRET-MARKER-9f3k"
        self.write("secret.txt", secret)
        collect(self.case_dir, self.src)
        for sub in ("info", "verify"):
            p = self._run(sub, self.case_dir, "--json")
            self.assertEqual(p.returncode, 0 if sub == "verify" else 0)
            self.assertNotIn(secret, p.stdout)
