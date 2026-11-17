"""解析核心的自动化测试。

全程离线：不访问网络，不读取样例目录与仓库内文件之外的路径。
"""

import time
import unittest
from pathlib import Path

from xmlsec.inspector import LIMITS, inspect_xml

SAMPLES = Path(__file__).resolve().parent.parent / "samples"


def load_sample(name):
    return (SAMPLES / name).read_text(encoding="utf-8")


def codes(result):
    return {d["code"] for d in result["diagnostics"]}


def find_elements(node, local):
    """在结果树中递归查找 local 名匹配的元素。"""
    found = []

    def walk(n):
        if n.get("type") == "element" and n.get("local") == local:
            found.append(n)
        for c in n.get("children", []):
            walk(c)

    walk(node)
    return found


class TestNormalDocument(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = inspect_xml(load_sample("normal_document.xml"))

    def test_status_ok(self):
        self.assertEqual(self.result["status"], "ok", self.result["diagnostics"])

    def test_no_error_or_blocked(self):
        severities = {d["severity"] for d in self.result["diagnostics"]}
        self.assertNotIn("error", severities)
        self.assertNotIn("blocked", severities)

    def test_element_hierarchy_and_attributes(self):
        books = find_elements(self.result["tree"], "book")
        self.assertEqual(len(books), 2)
        attrs = {a["name"]: a["value"] for a in books[0]["attributes"]}
        self.assertEqual(attrs.get("id"), "b-001")
        self.assertEqual(attrs.get("available"), "true")

    def test_namespaces_preserved(self):
        meta = find_elements(self.result["tree"], "meta")
        self.assertEqual(len(meta), 1)
        self.assertEqual(meta[0]["namespace"], "http://example.com/ns/meta")
        self.assertEqual(meta[0]["prefix"], "m")
        created = find_elements(self.result["tree"], "created")
        self.assertEqual(created[0]["namespace"], "http://example.com/ns/meta")

    def test_char_entities_expanded(self):
        summaries = find_elements(self.result["tree"], "summary")
        text = "".join(
            c["content"] for c in summaries[0]["children"] if c["type"] == "text"
        )
        self.assertIn("<标签>", text)
        self.assertIn("&", text)
        self.assertIn("AB", text)  # &#65;&#x42;

    def test_cdata_kept_verbatim(self):
        desc = find_elements(self.result["tree"], "description")
        cdata = [c for c in desc[0]["children"] if c["type"] == "text" and c["cdata"]]
        self.assertTrue(cdata, "应存在 CDATA 文本节点")
        self.assertIn("<tags>", cdata[0]["content"])
        self.assertIn("&entities;", cdata[0]["content"])

    def test_comment_and_pi_and_segments(self):
        tree = self.result["tree"]

        def all_nodes(n):
            yield n
            for c in n.get("children", []):
                yield from all_nodes(c)

        nodes = list(all_nodes(tree))
        self.assertTrue(any(n.get("type") == "comment" for n in nodes))
        self.assertTrue(any(n.get("type") == "pi" and n.get("target") == "render" for n in nodes))
        segs = find_elements(tree, "seg")
        self.assertEqual(len(segs), 2)

    def test_positions_present(self):
        books = find_elements(self.result["tree"], "book")
        self.assertGreater(books[0]["line"], 0)


class TestDangerousConstructs(unittest.TestCase):
    def test_xxe_local_file_blocked_and_not_read(self):
        result = inspect_xml(load_sample("xxe_local_file.xml"))
        self.assertEqual(result["status"], "blocked")
        self.assertIn("external_entity", codes(result))
        self.assertIn("doctype", codes(result))
        # 文件内容绝不能出现在解析结果里
        leaks = find_elements(result["tree"], "leak")
        text = "".join(
            c.get("content", "") for c in leaks[0]["children"] if c["type"] == "text"
        ) if leaks else ""
        self.assertNotIn("root:", text)
        self.assertNotIn("/bin/", text)

    def test_xxe_remote_dtd_blocked(self):
        result = inspect_xml(load_sample("xxe_remote_dtd.xml"))
        self.assertEqual(result["status"], "blocked")
        self.assertIn("external_dtd", codes(result))
        self.assertIn("external_entity", codes(result))

    def test_blocked_diagnostics_have_reason_and_position(self):
        result = inspect_xml(load_sample("xxe_local_file.xml"))
        blocked = [d for d in result["diagnostics"] if d["severity"] == "blocked"]
        self.assertTrue(blocked)
        for d in blocked:
            self.assertTrue(d["message"])
            self.assertIsNotNone(d["line"])

    def test_parameter_entity_blocked(self):
        xml = """<?xml version="1.0"?>
<!DOCTYPE r [ <!ENTITY % pe "<!ENTITY x 'y'>"> %pe; ]>
<r>&x;</r>"""
        result = inspect_xml(xml)
        self.assertIn("parameter_entity", codes(result))
        self.assertEqual(result["status"], "blocked")


class TestLimits(unittest.TestCase):
    def test_billion_laughs_terminated_fast(self):
        start = time.monotonic()
        result = inspect_xml(load_sample("billion_laughs.xml"))
        elapsed = time.monotonic() - start
        self.assertEqual(result["status"], "limited")
        self.assertTrue(
            any(d["code"].startswith("entity_expansion") for d in result["diagnostics"]),
            result["diagnostics"],
        )
        self.assertLess(elapsed, 5.0, "实体炸弹应在数秒内被终止")

    def test_deep_nesting_limit(self):
        result = inspect_xml(load_sample("deep_nesting.xml"))
        self.assertEqual(result["status"], "limited")
        self.assertIn("max_depth", codes(result))
        limit_diag = next(d for d in result["diagnostics"] if d["code"] == "max_depth")
        self.assertIn(str(LIMITS["max_depth"]), limit_diag["message"])

    def test_oversized_input_rejected_before_parse(self):
        result = inspect_xml(load_sample("oversized.xml"))
        self.assertEqual(result["status"], "limited")
        self.assertIn("input_size", codes(result))
        self.assertIsNone(result["tree"])

    def test_exact_limit_boundary_accepted(self):
        # 恰好在上限以内的输入不应被大小限制拦截
        payload = "<r>" + "a" * (LIMITS["max_input_bytes"] - 20) + "</r>"
        result = inspect_xml(payload)
        self.assertNotIn("input_size", codes(result))

    def test_malformed_reports_position(self):
        result = inspect_xml(load_sample("malformed.xml"))
        self.assertEqual(result["status"], "error")
        errors = [d for d in result["diagnostics"] if d["severity"] == "error"]
        self.assertTrue(errors)
        self.assertIsNotNone(errors[0]["line"])

    def test_recursive_entity_does_not_hang(self):
        xml = """<?xml version="1.0"?>
<!DOCTYPE r [ <!ENTITY x "&y;"> <!ENTITY y "&x;"> ]>
<r>&x;</r>"""
        start = time.monotonic()
        result = inspect_xml(xml)
        self.assertLess(time.monotonic() - start, 5.0)
        self.assertIn(result["status"], ("error", "limited", "blocked"))

    def test_custom_limits_respected(self):
        xml = "<a><b><c>text</c></b></a>"
        result = inspect_xml(xml, limits={"max_depth": 2})
        self.assertEqual(result["status"], "limited")
        self.assertIn("max_depth", codes(result))


if __name__ == "__main__":
    unittest.main()
