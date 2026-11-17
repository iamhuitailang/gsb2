"""规则层的细粒度单元测试：源识别与 sink 参数位判定。"""

from __future__ import annotations

import ast

from sqlaudit.rules import call_has_params, extract_source, match_sink
from tests.helpers import ScannerCase


def parse_expr(code: str) -> ast.AST:
    return ast.parse(code, mode="eval").body


class TestSourceRecognition(ScannerCase):
    def test_request_inputs(self):
        for code, kind in [
            ("request.args.get('id')", "request.args"),
            ("request.form['name']", "request.form"),
            ("request.json", "request.json"),
            ("req.headers.get('Auth')", "request.headers"),
            ("self.request.query_params", "request.query_params"),
        ]:
            source = extract_source(parse_expr(code))
            self.assertIsNotNone(source, code)
            self.assertEqual(source[0], kind, code)

    def test_other_sources(self):
        self.assertEqual(extract_source(parse_expr("input()"))[0],
                         "input()")
        self.assertEqual(extract_source(parse_expr("sys.argv[1]"))[0],
                         "sys.argv")
        self.assertEqual(extract_source(parse_expr("os.environ['X']"))[0],
                         "os.environ")
        self.assertEqual(
            extract_source(parse_expr("os.getenv('X')"))[0], "os.getenv"
        )

    def test_non_sources(self):
        for code in ["x", "obj.name", "data.get('x')", "'literal'",
                     "request.method", "config.args"]:
            self.assertIsNone(extract_source(parse_expr(code)), code)


class TestSinkRules(ScannerCase):
    def test_known_sink_query_and_param_positions(self):
        call = parse_expr("cursor.execute(sql, params)")
        info = match_sink(call)
        self.assertIsNotNone(info)
        self.assertFalse(info["heuristic"])
        self.assertEqual(info["query_index"], 0)
        self.assertTrue(call_has_params(call, info))

    def test_sink_without_params(self):
        call = parse_expr("cursor.execute(sql)")
        info = match_sink(call)
        self.assertFalse(call_has_params(call, info))

    def test_heuristic_sink(self):
        call = parse_expr("db.run_sql(q)")
        info = match_sink(call)
        self.assertIsNotNone(info)
        self.assertTrue(info["heuristic"])
        self.assertEqual(info["name"], "run_sql")

    def test_plain_function_is_not_sink(self):
        self.assertIsNone(match_sink(parse_expr("helper(x)")))
        self.assertIsNone(match_sink(parse_expr("obj.transform(x)")))
