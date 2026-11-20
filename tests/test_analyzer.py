"""污点分析引擎的单元测试：四类场景与各种传播/绑定写法。"""

import unittest

from sqli_scanner.model import (
    RULE_TAINTED_SQL,
    RULE_UNCONFIRMED_SQL,
    SEVERITY_REVIEW,
    SEVERITY_VULNERABILITY,
)
from sqli_scanner.scanner import scan_source


def analyze(code, **kwargs):
    result = scan_source(code, path="testcase.py", **kwargs)
    return result.findings


class DirectTaintTests(unittest.TestCase):
    def test_string_concat_is_vulnerability(self):
        code = """
def view(request):
    keyword = request.args.get("keyword")
    query = "SELECT * FROM t WHERE name = '" + keyword + "'"
    cursor.execute(query)
"""
        findings = analyze(code)
        self.assertEqual(len(findings), 1)
        f = findings[0]
        self.assertEqual(f.severity, SEVERITY_VULNERABILITY)
        self.assertEqual(f.rule, RULE_TAINTED_SQL)
        self.assertEqual(f.source_name, "request.args.get")
        self.assertEqual(f.sink_name, "cursor.execute")
        # 输入位置与执行位置都能定位
        self.assertEqual(f.source_lineno, 3)
        self.assertEqual(f.sink_lineno, 5)
        # 传播路径覆盖赋值与拼接
        kinds = [s.kind for s in f.trace]
        self.assertIn("source", kinds)
        self.assertIn("assign", kinds)
        self.assertIn("concat", kinds)
        self.assertIn("sink", kinds)

    def test_fstring_is_vulnerability(self):
        code = """
def view(request):
    keyword = request.args.get("keyword")
    cursor.execute(f"SELECT * FROM t WHERE name = '{keyword}'")
"""
        findings = analyze(code)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].severity, SEVERITY_VULNERABILITY)
        self.assertIn("fstring", [s.kind for s in findings[0].trace])

    def test_percent_format_is_vulnerability(self):
        code = """
def view(request):
    category = request.form.get("category")
    cursor.execute("SELECT * FROM t WHERE c = '%s'" % category)
"""
        findings = analyze(code)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].severity, SEVERITY_VULNERABILITY)
        self.assertIn("percent-format", [s.kind for s in findings[0].trace])

    def test_subscript_source(self):
        code = """
def view(request):
    keyword = request.args["keyword"]
    cursor.execute("SELECT * FROM t WHERE n = '" + keyword + "'")
"""
        findings = analyze(code)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].severity, SEVERITY_VULNERABILITY)

    def test_builtin_input_source(self):
        code = """
def cli():
    name = input("name: ")
    cursor.execute("SELECT * FROM t WHERE n = '" + name + "'")
"""
        findings = analyze(code)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].source_name, "input")

    def test_text_wrapper_reports_at_execute(self):
        code = """
def view(request):
    q = request.args.get("q")
    stmt = text("SELECT * FROM t WHERE n = '" + q + "'")
    session.execute(stmt)
"""
        findings = analyze(code)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].severity, SEVERITY_VULNERABILITY)
        self.assertEqual(findings[0].sink_name, "session.execute")

    def test_engine_execute_concat(self):
        code = """
def view(request):
    q = request.args.get("q")
    engine.execute("SELECT * FROM t WHERE n = '" + q + "'")
"""
        findings = analyze(code)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].sink_name, "engine.execute")

    def test_str_format_is_vulnerability(self):
        code = """
def view(request):
    keyword = request.args["keyword"]
    cursor.execute("SELECT * FROM t WHERE n = '{}'".format(keyword))
"""
        findings = analyze(code)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].severity, SEVERITY_VULNERABILITY)


class ParameterBindingTests(unittest.TestCase):
    def test_positional_binding_not_flagged(self):
        code = """
def view(request):
    keyword = request.args.get("keyword")
    cursor.execute("SELECT * FROM t WHERE name = ?", (keyword,))
"""
        self.assertEqual(analyze(code), [])

    def test_named_binding_not_flagged(self):
        code = """
def view(request):
    keyword = request.args.get("keyword")
    cursor.execute(
        "SELECT * FROM t WHERE name = :k",
        {"k": keyword},
    )
"""
        self.assertEqual(analyze(code), [])

    def test_binding_keyword_not_flagged(self):
        code = """
def view(request):
    keyword = request.args.get("keyword")
    cursor.execute("SELECT * FROM t WHERE name = %s", params=(keyword,))
"""
        self.assertEqual(analyze(code), [])

    def test_executemany_binding_not_flagged(self):
        code = """
def view(request):
    rows = request.json.get("rows")
    cursor.executemany("INSERT INTO t (n) VALUES (?)", rows)
"""
        self.assertEqual(analyze(code), [])

    def test_static_query_with_tainted_binding_is_safe(self):
        code = """
def view(request):
    keyword = request.args.get("keyword")
    sql = "SELECT * FROM t WHERE name = ?"
    cursor.execute(sql, (keyword,))
"""
        self.assertEqual(analyze(code), [])

    def test_tainted_query_with_binding_still_flagged(self):
        # 查询字符串本身被拼接过，即使给了绑定参数仍然是风险
        code = """
def view(request):
    keyword = request.args.get("keyword")
    table = request.args.get("table")
    cursor.execute("SELECT * FROM " + table + " WHERE n = ?", (keyword,))
"""
        findings = analyze(code)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].severity, SEVERITY_VULNERABILITY)
        self.assertIn("参数绑定", findings[0].reason)


class LocalFunctionTests(unittest.TestCase):
    def test_taint_through_local_helper(self):
        code = """
def build_sql(keyword):
    return "SELECT * FROM t WHERE n = '" + keyword + "'"

def view(request):
    keyword = request.args.get("keyword")
    query = build_sql(keyword)
    cursor.execute(query)
"""
        findings = analyze(code)
        self.assertEqual(len(findings), 1)
        f = findings[0]
        self.assertEqual(f.severity, SEVERITY_VULNERABILITY)
        self.assertTrue(
            any(step.kind == "call" and "build_sql" in step.detail for step in f.trace)
        )

    def test_taint_through_chained_helpers(self):
        code = """
def passthrough(value):
    return value

def build(value):
    return "SELECT * FROM t WHERE n = '" + passthrough(value) + "'"

def view(request):
    keyword = request.args.get("keyword")
    cursor.execute(build(keyword))
"""
        findings = analyze(code)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].severity, SEVERITY_VULNERABILITY)

    def test_helper_with_static_return_is_safe(self):
        code = """
def static_sql():
    return "SELECT * FROM t"

def view(request):
    request.args.get("keyword")  # 读了输入但没用进 SQL
    cursor.execute(static_sql())
"""
        self.assertEqual(analyze(code), [])

    def test_recursive_call_does_not_crash_and_degrades_to_review(self):
        code = """
def recurse(value, n):
    if n <= 0:
        return value
    return recurse(value, n - 1)

def view(request):
    keyword = request.args.get("keyword")
    cursor.execute("SELECT * FROM t WHERE n = '" + recurse(keyword, 20) + "'")
"""
        findings = analyze(code)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].severity, SEVERITY_REVIEW)


class UnconfirmedTests(unittest.TestCase):
    def test_unknown_call_chain_is_review(self):
        code = """
def view(request):
    keyword = request.args.get("keyword")
    fragment = build_query(keyword)
    cursor.execute("SELECT * FROM t WHERE " + fragment)
"""
        findings = analyze(code)
        self.assertEqual(len(findings), 1)
        f = findings[0]
        self.assertEqual(f.severity, SEVERITY_REVIEW)
        self.assertEqual(f.rule, RULE_UNCONFIRMED_SQL)

    def test_unknown_helper_body_is_review(self):
        code = """
def clean(value):
    return escape_sql(value)

def view(request):
    keyword = clean(request.args.get("keyword"))
    cursor.execute("SELECT * FROM t WHERE n = '" + keyword + "'")
"""
        findings = analyze(code)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].severity, SEVERITY_REVIEW)

    def test_clean_data_not_used_in_sql(self):
        code = """
def view(request):
    keyword = request.args.get("keyword")
    log(keyword)
"""
        self.assertEqual(analyze(code), [])

    def test_imported_helper_degrades_to_review(self):
        # 跨模块导入的函数无法在当前文件解析，保守标为待复核
        code = """
from .helpers import build_sql

def view(request):
    keyword = request.args.get("keyword")
    cursor.execute(build_sql(keyword))
"""
        findings = analyze(code)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].severity, SEVERITY_REVIEW)
        # 原始外部输入来源仍应保留，方便维护者定位
        self.assertEqual(findings[0].source_name, "request.args.get")

    def test_review_finding_keeps_original_source(self):
        code = """
def view(request):
    keyword = request.args.get("keyword")
    fragment = build_query(keyword)
    cursor.execute("SELECT * FROM t WHERE " + fragment)
"""
        findings = analyze(code)
        self.assertEqual(findings[0].source_kind, "source")
        self.assertEqual(findings[0].source_name, "request.args.get")


class ExtraSourceAndParamsTests(unittest.TestCase):
    def test_extra_source_option(self):
        code = """
def view():
    value = myframework.current_request.params("q")
    cursor.execute("SELECT * FROM t WHERE n = '" + value + "'")
"""
        # 默认不识别
        self.assertEqual(analyze(code), [])
        # 注册后识别
        findings = analyze(code, extra_sources={"myframework.current_request.params"})
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].severity, SEVERITY_VULNERABILITY)

    def test_assume_params_tainted(self):
        code = """
def view(keyword):
    cursor.execute("SELECT * FROM t WHERE n = '" + keyword + "'")
"""
        self.assertEqual(analyze(code), [])
        findings = analyze(code, assume_params_tainted=True)
        self.assertEqual(len(findings), 1)
        # 参数来源无法确认，只能给待复核
        self.assertEqual(findings[0].severity, SEVERITY_REVIEW)


class StabilityTests(unittest.TestCase):
    def test_id_stable_when_line_numbers_shift(self):
        base = '''
def view(request):
    keyword = request.args.get("keyword")
    cursor.execute("SELECT * FROM t WHERE n = '" + keyword + "'")
'''
        shifted = (
            "# 新增若干行注释\n# 让行号整体下移\n# 但代码本身没有变化\n"
            + base
        )
        first = analyze(base)
        second = analyze(shifted)
        self.assertEqual(len(first), 1)
        self.assertEqual(len(second), 1)
        self.assertEqual(first[0].finding_id, second[0].finding_id)
        self.assertNotEqual(first[0].sink_lineno, second[0].sink_lineno)

    def test_id_changes_when_code_changes(self):
        before = '''
def view(request):
    keyword = request.args.get("keyword")
    cursor.execute("SELECT * FROM t WHERE n = '" + keyword + "'")
'''
        after = '''
def view(request):
    keyword = request.args.get("other")
    cursor.execute("SELECT * FROM t WHERE n = '" + keyword + "'")
'''
        self.assertNotEqual(
            analyze(before)[0].finding_id, analyze(after)[0].finding_id
        )

    def test_deterministic_order(self):
        code = """
def view_a(request):
    k = request.args.get("k")
    cursor.execute("SELECT * FROM a WHERE n = '" + k + "'")

def view_b(request):
    k = request.args.get("k")
    cursor.execute("SELECT * FROM b WHERE n = '" + k + "'")
"""
        first = [f.finding_id for f in analyze(code)]
        second = [f.finding_id for f in analyze(code)]
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
