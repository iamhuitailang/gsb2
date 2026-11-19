"""文件检查器与命令行入口的端到端测试。"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

from regex_risk.checker import InputFileError, check_file
from regex_risk.report import build_json, build_text


class CheckerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmpdir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def _write(self, name, content):
        path = os.path.join(self.tmpdir, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(content)
        return path

    def test_blank_lines_do_not_shift_line_numbers(self):
        path = self._write(
            "p.txt",
            "(a+)*\n"
            "\n"      # 真空行跳过
            "[a-z]+\n",
        )
        result = check_file(path)
        self.assertEqual([line.line_number for line in result.lines], [1, 3])
        self.assertEqual(result.lines[0].status, "findings")
        self.assertEqual(result.lines[1].status, "ok")
        self.assertEqual(result.total_non_blank, 2)

    def test_whitespace_only_line_is_treated_as_pattern(self):
        # 纯空白行不是空行：其中的空白属于模式内容，需按表达式分析。
        path = self._write("p.txt", "a*\n  \nb*\n")
        result = check_file(path)
        self.assertEqual([line.line_number for line in result.lines], [1, 2, 3])

    def test_invalid_line_is_reported_and_checking_continues(self):
        path = self._write(
            "p.txt",
            "a*\n"
            "^*\n"      # 非法
            "(a|b)*\n"  # 合法且安全
        )
        result = check_file(path)
        statuses = [line.status for line in result.lines]
        self.assertEqual(statuses, ["ok", "invalid", "ok"])
        self.assertIn("re 编译失败", result.lines[1].error)
        self.assertEqual(result.invalid_count, 1)
        self.assertEqual(result.clean_count, 2)

    def test_clean_pattern_reports_explicitly(self):
        path = self._write("p.txt", "a|b\n")
        result = check_file(path)
        text = build_text(result)
        self.assertIn("检查通过", text)
        self.assertIn("未发现符合当前规则的风险写法", text)

    def test_missing_file_raises_input_error(self):
        with self.assertRaises(InputFileError):
            check_file(os.path.join(self.tmpdir, "nope.txt"))

    def test_directory_input_raises_input_error(self):
        with self.assertRaises(InputFileError):
            check_file(self.tmpdir)

    def test_non_utf8_file_raises_input_error(self):
        path = os.path.join(self.tmpdir, "bin.txt")
        with open(path, "wb") as handle:
            handle.write(b"\xff\xfe(a+)*\n")
        with self.assertRaises(InputFileError):
            check_file(path)

    def test_crlf_line_endings(self):
        path = self._write("crlf.txt", "(a+)*\r\na*\r\n")
        result = check_file(path)
        self.assertEqual([line.pattern for line in result.lines], ["(a+)*", "a*"])

    def test_json_output_is_stable_and_machine_readable(self):
        path = self._write("p.txt", "(a|a)*\n^\n")
        result = check_file(path)
        payload = json.loads(build_json(result))
        self.assertEqual(payload["tool"], "regex_risk")
        self.assertEqual(payload["summary"]["total_non_blank_lines"], 2)
        line = payload["lines"][0]
        self.assertEqual(line["status"], "findings")
        finding = line["findings"][0]
        for key in ("level", "code", "position", "end_position", "snippet", "reason"):
            self.assertIn(key, finding)
        self.assertEqual(finding["level"], "high")
        # 再次渲染结果应完全一致（输出稳定）。
        self.assertEqual(build_json(result), build_json(result))

    def test_json_distinguishes_invalid_and_findings(self):
        path = self._write("p.txt", "(a+)*\n^*\n")
        payload = json.loads(build_json(check_file(path)))
        self.assertEqual(payload["lines"][0]["status"], "findings")
        self.assertEqual(payload["lines"][1]["status"], "invalid")
        self.assertIn("error", payload["lines"][1])
        self.assertNotIn("error", payload["lines"][0])


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmpdir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def _write(self, name, content):
        path = os.path.join(self.tmpdir, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(content)
        return path

    def _run(self, *args):
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        env = dict(os.environ)
        env["PYTHONPATH"] = repo_root + os.pathsep + env.get("PYTHONPATH", "")
        return subprocess.run(
            [sys.executable, "-P", "-m", "regex_risk", *args],
            capture_output=True,
            text=True,
            env=env,
            cwd=repo_root,
        )

    def test_exit_zero_when_clean(self):
        path = self._write("ok.txt", "a|b\n")
        proc = self._run(path)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_exit_one_on_findings_or_invalid(self):
        path = self._write("risk.txt", "(a+)*\n")
        self.assertEqual(self._run(path).returncode, 1)
        path2 = self._write("bad.txt", "^*\n")
        self.assertEqual(self._run(path2).returncode, 1)

    def test_exit_two_on_missing_file(self):
        proc = self._run(os.path.join(self.tmpdir, "missing.txt"))
        self.assertEqual(proc.returncode, 2)
        self.assertIn("输入错误", proc.stdout)

    def test_json_format_flag(self):
        path = self._write("p.txt", "(a+)*\n")
        proc = self._run(path, "--format", "json")
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["lines"][0]["status"], "findings")

    def test_output_to_file(self):
        src = self._write("p.txt", "a*\n")
        out = os.path.join(self.tmpdir, "report.txt")
        proc = self._run(src, "--output", out)
        self.assertEqual(proc.returncode, 0)
        with open(out, encoding="utf-8") as handle:
            self.assertIn("检查通过", handle.read())


if __name__ == "__main__":
    unittest.main()
