"""端到端集成测试：覆盖直接风险、跨函数风险、安全参数绑定、
无关字符串拼接、启发式 sink、分析失败、去重、过滤与输出结构。
"""

from __future__ import annotations

import ast
import json
import unittest

from sqlaudit.cli import main as cli_main
from sqlaudit.model import Severity
from sqlaudit.report import render_text
from tests.helpers import ScannerCase


class TestDirectRisks(ScannerCase):
    def test_concat_fstring_percent_format_are_all_high(self):
        files = {
            "app.py": (
                "from flask import request\n"
                "def f(cursor):\n"
                "    a = request.args.get('a')\n"
                "    b = request.form['b']\n"
                "    c = request.json.get('c')\n"
                "    cursor.execute('SELECT * FROM t WHERE id=' + a)\n"
                "    cursor.execute(f\"SELECT * FROM t WHERE n='{b}'\")\n"
                "    cursor.execute('SELECT * FROM t WHERE x=%s' % c)\n"
            ),
        }
        result, root = self.scan(files)
        findings = self.findings_on(result, "app")
        self.assertEqual(len(findings), 3)
        self.assertTrue(all(f.severity == Severity.HIGH for f in findings))
        self.assertTrue(all(f.rule_id == "SQLI-001" for f in findings))
        # 每条发现都能定位到源头与 sink 的文件+行号
        for f in findings:
            self.assertEqual(f.origin.file, "app")
            self.assertGreater(f.origin.line, 0)
            self.assertGreater(f.line, 0)
            self.assertIn("execute", f.sink_function)

    def test_builtin_input_is_a_source(self):
        files = {
            "app.py": (
                "def f(cursor):\n"
                "    x = input()\n"
                "    cursor.execute('SELECT 1 WHERE x=' + x)\n"
            ),
        }
        result, _ = self.scan(files)
        self.assertEqual(len(result.findings), 1)
        self.assertEqual(result.findings[0].origin.source_kind, "input()")

    def test_sys_argv_and_environ_are_sources(self):
        files = {
            "app.py": (
                "import sys, os\n"
                "def f(cursor):\n"
                "    cursor.execute('SELECT * FROM t WHERE id=' + sys.argv[1])\n"
                "    cursor.execute('SELECT * FROM t WHERE k=' + os.environ['K'])\n"
            ),
        }
        result, _ = self.scan(files)
        kinds = {f.origin.source_kind for f in result.findings}
        self.assertEqual(kinds, {"sys.argv", "os.environ"})


class TestCrossFunctionTaint(ScannerCase):
    def test_taint_through_helper_function(self):
        files = {
            "app.py": (
                "from flask import request\n"
                "def build(q):\n"
                "    return 'SELECT * FROM t WHERE id=' + q\n"
                "def view(cursor):\n"
                "    x = request.args.get('x')\n"
                "    cursor.execute(build(x))\n"
            ),
        }
        result, root = self.scan(files)
        self.assertEqual(len(result.findings), 1)
        f = result.findings[0]
        self.assertEqual(f.severity, Severity.HIGH)
        # 源头在 view，sink 也在 view，但路径必须体现经过 build
        sink_line = self.line_of(root, "app.py", "cursor.execute(build(x))")
        self.assertEqual(f.line, sink_line)
        self.assertTrue(
            any("build" in h.function or "build" in h.code for h in f.hops),
            f"传递路径缺少 build: {f.to_path()}",
        )

    def test_taint_across_files(self):
        files = {
            "pkg/__init__.py": "",
            "pkg/dao.py": (
                "def build(q):\n"
                "    return 'SELECT * FROM t WHERE id=' + q\n"
                "def fetch(cursor, q):\n"
                "    cursor.execute(build(q))\n"
            ),
            "pkg/web.py": (
                "from flask import request\n"
                "from .dao import fetch\n"
                "def view(cursor):\n"
                "    x = request.args.get('x')\n"
                "    fetch(cursor, x)\n"
            ),
        }
        result, root = self.scan(files)
        self.assertEqual(len(result.findings), 1)
        f = result.findings[0]
        # sink 落在 dao.py，源头落在 web.py —— 跨文件关系可见
        self.assertEqual(f.file, "pkg/dao")
        self.assertEqual(f.origin.file, "pkg/web")
        self.assertTrue(any(h.file == "pkg/web" for h in f.hops))

    def test_multi_hop_path_is_complete(self):
        files = {
            "app.py": (
                "from flask import request\n"
                "def l3(q):\n"
                "    return 'SELECT * FROM t WHERE id=' + q\n"
                "def l2(q):\n"
                "    return l3(q)\n"
                "def l1(q):\n"
                "    return l2(q)\n"
                "def view(cursor):\n"
                "    x = request.args.get('x')\n"
                "    cursor.execute(l1(x))\n"
            ),
        }
        result, _ = self.scan(files)
        self.assertEqual(len(result.findings), 1)
        path = result.findings[0].to_path()
        # 至少要看到跨函数调用 l1，以及内部经过 l3 的传播
        self.assertTrue(any("l1" in h["code"] for h in path))
        self.assertTrue(any("l3" in h["code"] for h in path))

    def test_taint_through_self_field(self):
        files = {
            "app.py": (
                "from flask import request\n"
                "class DAO:\n"
                "    def set_v(self, v):\n"
                "        self.v = v\n"
                "    def run(self, cursor):\n"
                "        cursor.execute('SELECT * FROM t WHERE x=' + self.v)\n"
                "def view():\n"
                "    d = DAO()\n"
                "    d.set_v(request.args.get('x'))\n"
                "    d.run(None)\n"
            ),
        }
        result, _ = self.scan(files)
        self.assertEqual(len(result.findings), 1)
        f = result.findings[0]
        # 源头必须是真实 request，而不是 parameter:v
        self.assertIn("request", f.origin.source_kind)
        self.assertTrue(any("set_v" in h.code for h in f.hops))


class TestSafeParameterization(ScannerCase):
    def test_placeholder_binding_not_reported(self):
        files = {
            "app.py": (
                "from flask import request\n"
                "def f(cursor):\n"
                "    x = request.args.get('x')\n"
                "    cursor.execute('SELECT * FROM t WHERE id = ?', (x,))\n"
                "    cursor.execute('SELECT * FROM t WHERE n = :n', {'n': x})\n"
                "    cursor.executemany('INSERT INTO t VALUES (?)', [(x,)])\n"
            ),
        }
        result, _ = self.scan(files)
        self.assertEqual(result.findings, [])

    def test_cleansing_builtins_clear_taint(self):
        files = {
            "app.py": (
                "from flask import request\n"
                "def f(cursor):\n"
                "    x = int(request.args.get('x'))\n"
                "    cursor.execute('SELECT * FROM t WHERE id = ?', (x,))\n"
            ),
        }
        result, _ = self.scan(files)
        self.assertEqual(result.findings, [])

    def test_partial_parameterization_is_medium(self):
        files = {
            "app.py": (
                "from flask import request\n"
                "def f(cursor):\n"
                "    table = request.args.get('table')\n"
                "    cursor.execute('SELECT * FROM ' + table + ' WHERE a = ?',\n"
                "                     ('v',))\n"
            ),
        }
        result, _ = self.scan(files)
        self.assertEqual(len(result.findings), 1)
        f = result.findings[0]
        self.assertEqual(f.severity, Severity.MEDIUM)
        self.assertTrue(f.has_params)


class TestBenignStrings(ScannerCase):
    def test_string_concat_without_db_is_clean(self):
        files = {
            "app.py": (
                "from flask import request\n"
                "def f():\n"
                "    x = request.args.get('x')\n"
                "    msg = 'hello ' + x\n"
                "    title = 'Mr {}'.format(x)\n"
                "    text = f'hi {x}'\n"
                "    return msg, title, text\n"
            ),
        }
        result, _ = self.scan(files)
        self.assertEqual(result.findings, [])


class TestHeuristicSink(ScannerCase):
    def test_unresolved_db_named_call_is_low(self):
        files = {
            "app.py": (
                "from flask import request\n"
                "from external_lib import run_sql\n"
                "def f():\n"
                "    x = request.args.get('x')\n"
                "    run_sql('SELECT * FROM t WHERE x=' + x)\n"
            ),
        }
        result, _ = self.scan(files)
        self.assertEqual(len(result.findings), 1)
        f = result.findings[0]
        self.assertEqual(f.severity, Severity.LOW)
        self.assertEqual(f.rule_id, "SQLI-002")


class TestModernSyntax(ScannerCase):
    def test_walrus_taint_is_tracked(self):
        files = {
            "app.py": (
                "from flask import request\n"
                "def f(cursor):\n"
                "    if (x := request.args.get('x')):\n"
                "        cursor.execute('SELECT * FROM t WHERE id=' + x)\n"
            ),
        }
        result, _ = self.scan(files)
        self.assertEqual(len(result.findings), 1)
        self.assertEqual(result.findings[0].severity, Severity.HIGH)

    @unittest.skipUnless(hasattr(ast, "Match"),
                         "match 语句需要 Python 3.10+")
    def test_match_capture_taint_is_tracked(self):
        files = {
            "app.py": (
                "from flask import request\n"
                "def f(cursor):\n"
                "    z = request.json.get('z')\n"
                "    match z:\n"
                "        case str(s):\n"
                "            cursor.execute('SELECT * FROM t WHERE z=' + s)\n"
                "        case _:\n"
                "            pass\n"
            ),
        }
        result, _ = self.scan(files)
        self.assertEqual(len(result.findings), 1)
        self.assertEqual(result.findings[0].severity, Severity.HIGH)


class TestAnalysisFailure(ScannerCase):
    def test_syntax_error_is_reported_not_skipped(self):
        files = {
            "good.py": (
                "def f():\n"
                "    return 1\n"
            ),
            "broken.py": (
                "def broken(:\n"
                "    return 1\n"
            ),
        }
        result, _ = self.scan(files)
        self.assertEqual(len(result.errors), 1)
        err = result.errors[0]
        self.assertEqual(err.file, "broken")
        self.assertEqual(err.error_type, "SyntaxError")
        self.assertGreater(err.line, 0)
        # 好文件仍然被分析
        self.assertIn("good", result.scanned_files)
        self.assertNotIn("broken", result.scanned_files)


class TestDedupAndOrdering(ScannerCase):
    def test_same_sink_reported_once_even_with_multiple_paths(self):
        files = {
            "app.py": (
                "from flask import request\n"
                "def wrap1(x):\n"
                "    return wrap2(x)\n"
                "def wrap2(x):\n"
                "    return x\n"
                "def f(cursor):\n"
                "    x = request.args.get('x')\n"
                "    cursor.execute('SELECT * FROM t WHERE id=' + wrap1(x))\n"
            ),
        }
        result, _ = self.scan(files)
        sinks = {(f.file, f.line) for f in result.findings}
        self.assertEqual(len(sinks), 1)

    def test_report_order_is_stable(self):
        files = {
            "app.py": (
                "from flask import request\n"
                "def f(cursor):\n"
                "    a = request.args.get('a')\n"
                "    b = request.args.get('b')\n"
                "    cursor.execute('SELECT * FROM t WHERE id=' + b)\n"
                "    cursor.execute('SELECT * FROM t WHERE id=' + a)\n"
            ),
        }
        result, _ = self.scan(files)
        keys = [f.sort_key() for f in result.findings]
        self.assertEqual(keys, sorted(keys))
        # 再扫一次，顺序完全一致
        result2, _ = self.scan(files)
        self.assertEqual(
            [(f.file, f.line, f.origin.line) for f in result.findings],
            [(f.file, f.line, f.origin.line) for f in result2.findings],
        )


class TestFilteringAndOutput(ScannerCase):
    def test_min_level_filter(self):
        files = {
            "app.py": (
                "from flask import request\n"
                "from external_lib import run_sql\n"
                "def f(cursor):\n"
                "    x = request.args.get('x')\n"
                "    run_sql('SELECT * FROM t WHERE x=' + x)\n"
                "    cursor.execute('SELECT * FROM t WHERE id=' + x)\n"
            ),
        }
        result, _ = self.scan(files)
        self.assertEqual(len(result.findings), 2)
        high_only = result.filter_by_level(Severity.HIGH)
        self.assertEqual(len(high_only.findings), 1)
        # 过滤不影响分析错误的保留
        self.assertEqual(high_only.errors, result.errors)

    def test_json_schema_is_tool_readable(self):
        files = {
            "app.py": (
                "from flask import request\n"
                "def f(cursor):\n"
                "    x = request.args.get('x')\n"
                "    cursor.execute('SELECT * FROM t WHERE id=' + x)\n"
            ),
        }
        result, _ = self.scan(files)
        payload = json.loads(json.dumps(result.to_dict()))
        self.assertEqual(payload["summary"]["findings"], 1)
        f = payload["findings"][0]
        for key in ("rule_id", "severity", "severity_level", "file", "line",
                    "sink_function", "code", "has_params", "reason",
                    "origin", "flow_path"):
            self.assertIn(key, f)
        self.assertIn("source_kind", f["origin"])
        self.assertIsInstance(f["flow_path"], list)

    def test_text_report_contains_key_sections(self):
        files = {
            "app.py": (
                "from flask import request\n"
                "def f(cursor):\n"
                "    x = request.args.get('x')\n"
                "    cursor.execute('SELECT * FROM t WHERE id=' + x)\n"
            ),
        }
        result, _ = self.scan(files)
        text = render_text(result, color=False)
        self.assertIn("SQLI-001", text)
        self.assertIn("输入来源", text)
        self.assertIn("危险调用", text)
        self.assertIn("传递路径", text)


class TestCli(ScannerCase):
    def test_cli_json_and_exit_codes(self):
        import io
        import contextlib

        files = {
            "app.py": (
                "from flask import request\n"
                "def f(cursor):\n"
                "    x = request.args.get('x')\n"
                "    cursor.execute('SELECT * FROM t WHERE id=' + x)\n"
            ),
            "clean.py": "def f():\n    return 1\n",
        }
        root = self.make_project(files)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = cli_main([root, "--format", "json", "--no-color"])
        self.assertEqual(code, 1)
        payload = json.loads(buf.getvalue())
        self.assertEqual(payload["summary"]["findings"], 1)

        clean_root = self.make_project({"m.py": "x = 1\n"})
        with contextlib.redirect_stdout(io.StringIO()):
            clean_code = cli_main([clean_root, "--format", "json"])
        self.assertEqual(clean_code, 0)

    def test_cli_bad_path_returns_usage_error(self):
        import io
        import contextlib

        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cli_main(["/no/such/path-xyz"]), 2)
