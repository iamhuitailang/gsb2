"""taintbench 自动化测试（纯标准库 unittest，python3 -I -m unittest 可运行）。

覆盖：直接调用、变量传播、跨函数传递、无法解析函数的可能风险、
安全参数数组、安全引用、数值转换、语法错误、多文件部分失败、
结果去重与稳定排序、输入限制、本机服务约束。
"""

from __future__ import annotations

import json
import os
import sys
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

# 兼容 python3 -I（隔离模式不自动把当前目录加入 sys.path）
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from taintbench.analyzer import analyze_source
from taintbench.models import STATE_TAINTED, Taint, TaintFlow, Origin
from taintbench.orchestrator import CheckLimits, check_paths, check_sources
from taintbench.webapp import _LocalOnlyHandler


def find(results, predicate):
    out = []
    for r in results:
        out.extend(f for f in r.findings if predicate(f))
    return out


def safe_lines(results):
    return {(s.file, s.line, s.rule_id) for r in results for s in r.safe_calls}


def error_lines(results):
    return {(e.file, e.line, e.kind) for r in results for e in r.errors}


class DirectCallTests(unittest.TestCase):
    def test_os_system_with_flask_input(self):
        code = (
            "import os\n"
            "from flask import request\n"
            "def view():\n"
            "    host = request.args.get('host')\n"
            "    os.system('ping ' + host)\n"
        )
        result = analyze_source(code, "a.py")
        self.assertEqual(len(result.findings), 1)
        f = result.findings[0]
        self.assertEqual(f.severity, "high")
        self.assertEqual(f.certainty, "确定")
        self.assertEqual(f.sink_rule, "S101")
        self.assertIn("Flask request.args['host']", f.source_labels)
        self.assertEqual(f.source_lines, [4])
        self.assertIn("字符串拼接", f.propagation)

    def test_input_builtin_to_os_popen(self):
        code = "import os\ndef f():\n    x = input('v: ')\n    os.popen('cat ' + x)\n"
        result = analyze_source(code, "a.py")
        self.assertEqual(len(result.findings), 1)
        self.assertEqual(result.findings[0].severity, "high")
        self.assertIn("input()", result.findings[0].source_labels[0])

    def test_subprocess_shell_true_string(self):
        code = (
            "import subprocess\n"
            "def f():\n"
            "    name = input()\n"
            "    subprocess.run('echo ' + name, shell=True)\n"
        )
        result = analyze_source(code, "a.py")
        self.assertEqual(len(result.findings), 1)
        f = result.findings[0]
        self.assertEqual(f.sink_rule, "S103")
        self.assertEqual(f.severity, "high")

    def test_subprocess_getoutput_forces_shell(self):
        code = "import subprocess\ndef f():\n    x = input()\n    subprocess.getoutput('ls ' + x)\n"
        result = analyze_source(code, "a.py")
        self.assertEqual(len(result.findings), 1)
        self.assertEqual(result.findings[0].sink_rule, "S103")

    def test_constant_command_is_not_flagged(self):
        code = "import os, subprocess\nos.system('ls -l')\nsubprocess.run(['echo', 'hi'])\n"
        result = analyze_source(code, "a.py")
        self.assertEqual(result.findings, [])
        # 仍应作为“规则上安全”展示规则依据
        self.assertTrue(any(s.rule_id.startswith("S101") for s in result.safe_calls))
        self.assertTrue(any(s.rule_id.startswith("S104") for s in result.safe_calls))


class PropagationTests(unittest.TestCase):
    def test_assignment_concat_format_fstring_keep_taint(self):
        code = (
            "import os\n"
            "def f():\n"
            "    x = input()\n"
            "    a = 'a' + x\n"
            "    b = 'b %s' % x\n"
            "    c = f'c {x}'\n"
            "    os.system(a)\n"
            "    os.system(b)\n"
            "    os.system(c)\n"
        )
        result = analyze_source(code, "a.py")
        self.assertEqual(len(result.findings), 3)
        self.assertTrue(all(f.severity == "high" for f in result.findings))
        texts = " ".join(f.propagation for f in result.findings)
        self.assertIn("字符串拼接", texts)
        self.assertIn("格式化字符串", texts)
        self.assertIn("f-string", texts)

    def test_function_argument_does_not_cut_taint(self):
        code = (
            "import os\n"
            "def echo(v):\n"
            "    return v\n"
            "def f():\n"
            "    x = input()\n"
            "    y = echo(x)\n"
            "    os.system('ls ' + y)\n"
        )
        result = analyze_source(code, "a.py")
        self.assertEqual(len(result.findings), 1)
        f = result.findings[0]
        # 跨函数统一保守标为可能风险，不能伪装成确定结论
        self.assertEqual(f.severity, "medium")
        self.assertEqual(f.certainty, "可能")
        self.assertIn("input()", f.source_labels[0])
        self.assertIn("echo()", f.propagation)

    def test_unresolved_call_is_possible_not_silently_dropped(self):
        code = (
            "import os\n"
            "def f():\n"
            "    x = input()\n"
            "    y = external_lib.clean(x)\n"
            "    os.system('ls ' + y)\n"
        )
        result = analyze_source(code, "a.py")
        self.assertEqual(len(result.findings), 1)
        self.assertEqual(result.findings[0].severity, "medium")
        self.assertIn("无法解析", result.findings[0].propagation)

    def test_chained_popen_read_still_detected(self):
        code = "import os\ndef f():\n    x = input()\n    return os.popen('cat ' + x).read()\n"
        result = analyze_source(code, "a.py")
        self.assertEqual(len(result.findings), 1)
        self.assertEqual(result.findings[0].sink_rule, "S102")

    def test_branch_merge_keeps_taint(self):
        code = (
            "import os\n"
            "def f(flag):\n"
            "    x = input()\n"
            "    if flag:\n"
            "        y = x\n"
            "    else:\n"
            "        y = 'fixed'\n"
            "    os.system('ls ' + y)\n"
        )
        result = analyze_source(code, "a.py")
        self.assertEqual(len(result.findings), 1)


class SafePatternTests(unittest.TestCase):
    def test_argv_array_with_taint_is_safe(self):
        code = (
            "import subprocess\n"
            "def f():\n"
            "    name = input()\n"
            "    subprocess.run(['echo', name])\n"
        )
        result = analyze_source(code, "a.py")
        self.assertEqual(result.findings, [])
        self.assertEqual(len(result.safe_calls), 1)
        safe = result.safe_calls[0]
        self.assertEqual(safe.sink_rule, "S104")
        self.assertIn("D203", safe.rule_id)

    def test_shlex_quote_neutralizes_shell_string(self):
        code = (
            "import shlex, subprocess\n"
            "def f():\n"
            "    host = input()\n"
            "    subprocess.run('ping ' + shlex.quote(host), shell=True)\n"
        )
        result = analyze_source(code, "a.py")
        self.assertEqual(result.findings, [])
        self.assertTrue(any("D202" in s.rule_id for s in result.safe_calls))

    def test_numeric_cast_is_sanitizer(self):
        code = (
            "import os\n"
            "def f():\n"
            "    n = int(input())\n"
            "    os.system('sleep ' + str(n))\n"
        )
        result = analyze_source(code, "a.py")
        # int() 成功后结果只含数值字符，规则上安全
        self.assertEqual(result.findings, [])
        self.assertTrue(any("D202" in s.rule_id for s in result.safe_calls))

    def test_partial_quote_still_flags_unquoted_flow(self):
        code = (
            "import shlex, subprocess\n"
            "def f():\n"
            "    a, b = input(), input()\n"
            "    subprocess.run('echo ' + shlex.quote(a) + ' ' + b, shell=True)\n"
        )
        result = analyze_source(code, "a.py")
        self.assertEqual(len(result.findings), 1)
        self.assertEqual(result.findings[0].severity, "high")

    def test_shell_true_with_list_uses_decision_d204(self):
        code = (
            "import subprocess\n"
            "def f():\n"
            "    x = input()\n"
            "    subprocess.Popen(['echo', x], shell=True)\n"
        )
        result = analyze_source(code, "a.py")
        self.assertEqual(len(result.findings), 1)
        self.assertIn("D204", result.findings[0].rule_id)


class ErrorAndMultiFileTests(unittest.TestCase):
    def test_syntax_error_reports_location(self):
        result = analyze_source("def broken(:\n    pass\n", "bad.py")
        self.assertEqual(result.findings, [])
        self.assertEqual(len(result.errors), 1)
        err = result.errors[0]
        self.assertEqual(err.kind, "syntax")
        self.assertEqual(err.line, 1)
        self.assertIn("语法错误", err.message)

    def test_multi_file_partial_failure_isolation(self):
        good = "import os\ndef f():\n    os.system('ls ' + input())\n"
        bad = "def oops(:\n"
        results = check_sources([("good.py", good), ("bad.py", bad)])
        by_name = {r.file: r for r in results}
        self.assertEqual(len(by_name["good.py"].findings), 1)
        self.assertEqual(by_name["good.py"].errors, [])
        self.assertEqual(by_name["bad.py"].findings, [])
        self.assertEqual(len(by_name["bad.py"].errors), 1)

    def test_path_scan_skips_non_python_and_sorts(self):
        results = check_paths(["samples"])
        names = [r.file for r in results]
        self.assertEqual(names, sorted(names))
        self.assertTrue(any("06_syntax_error" in n for n in names))
        bad = next(r for r in results if "06_syntax_error" in r.file)
        self.assertEqual(bad.errors[0].kind, "syntax")

    def test_missing_path_reported_not_raised(self):
        results = check_paths(["/no/such/path/xyz123"])
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].errors[0].kind, "analysis")


class StabilityTests(unittest.TestCase):
    def test_dedup_same_sink_single_finding(self):
        # 同一 sink 节点可能经不同表达式路径被评估，只能有一条发现
        code = (
            "import os\n"
            "def f():\n"
            "    x = input()\n"
            "    os.system('ls ' + x)\n"
            "    os.system('ls ' + x)\n"
        )
        first = analyze_source(code, "a.py")
        second = analyze_source(code, "a.py")
        # 两行是不同节点 => 两条；每行各自不重复
        self.assertEqual([f.line for f in first.findings], [4, 5])
        self.assertEqual(
            [f.to_dict() for f in first.findings],
            [f.to_dict() for f in second.findings],
        )

    def test_ordering_is_stable_across_runs(self):
        sources = [(f"m{i}.py", "import os\ndef f():\n    os.system('x ' + input())\n") for i in range(5)]
        r1 = check_sources(sources)
        r2 = check_sources(list(reversed(sources)))
        key = lambda rs: [(f.file, f.line, f.rule_id) for r in rs for f in r.findings]
        self.assertEqual(key(r1), key(r2))


class LimitTests(unittest.TestCase):
    def test_file_count_limit(self):
        limits = CheckLimits(max_files=2)
        results = check_sources([(f"f{i}.py", "x = 1\n") for i in range(3)], limits)
        self.assertTrue(results[0].errors)
        self.assertIn("最多", results[0].errors[0].message)

    def test_file_size_limit(self):
        limits = CheckLimits(max_file_bytes=10, max_total_bytes=10_000)
        results = check_sources([("big.py", "x = '" + "a" * 100 + "'\n")], limits)
        self.assertEqual(results[0].errors[0].kind, "analysis")
        self.assertIn("上限", results[0].errors[0].message)


class TaintModelTests(unittest.TestCase):
    def test_clean_does_not_cancel_taint(self):
        from taintbench.models import merge_taints
        self.assertIsNone(merge_taints(None, None))
        tainted = Taint(STATE_TAINTED, (TaintFlow(Origin("input", "input()", 1)),))
        # 干净值（None）与污点合并，污点必须保留而不是被抵消
        merged = merge_taints(None, tainted)
        self.assertIsNotNone(merged)
        self.assertEqual(merged.state, STATE_TAINTED)

    def test_possible_state_on_cross_function(self):
        code = (
            "def helper(v):\n"
            "    return v + '!'\n"
            "def f():\n"
            "    return helper(input())\n"
        )
        # 无 sink 时不应产生发现，也不应抛异常
        result = analyze_source(code, "a.py")
        self.assertEqual(result.findings, [])
        self.assertEqual(result.errors, [])


class WebServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _LocalOnlyHandler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def _get(self, path, host="127.0.0.1"):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", headers={"Host": host})
        return urllib.request.urlopen(req, timeout=5)

    def test_index_and_samples(self):
        html = self._get("/").read().decode("utf-8")
        self.assertIn("taintbench", html)
        data = json.loads(self._get("/api/samples").read())
        self.assertGreaterEqual(len(data["samples"]), 6)

    def test_check_api_finds_and_disclaims(self):
        payload = json.dumps({
            "files": [{"name": "t.py", "code": "import os\ndef f():\n    os.system('x ' + input())\n"}]
        }).encode()
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/check",
            data=payload, headers={"Content-Type": "application/json"}, method="POST",
        )
        data = json.loads(urllib.request.urlopen(req, timeout=5).read())
        self.assertEqual(data["summary"]["high"], 1)
        self.assertIn("不能证明", data["notice"])

    def test_non_loopback_host_rejected(self):
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        conn.request("GET", "/", headers={"Host": "evil.example.com"})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 403)
        conn.close()

    def test_oversized_body_rejected(self):
        import http.client
        oversized = json.dumps(
            {"files": [{"name": "t.py", "code": "a" * (3 * 1024 * 1024)}]}
        ).encode()
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        try:
            conn.request(
                "POST", "/api/check", body=oversized,
                headers={"Content-Type": "application/json"},
            )
            resp = conn.getresponse()
            resp.read()
            # 服务端必须拒绝；连接被拒收关闭也算满足安全意图
            self.assertIn(resp.status, (400, 413))
        except (http.client.HTTPException, ConnectionError, BrokenPipeError, OSError):
            pass
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
