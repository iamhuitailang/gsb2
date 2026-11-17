"""核心判定引擎自动化测试（标准库 unittest，无外部依赖）。

运行：python3 -m unittest discover -s tests -v
覆盖：解析错误定位、来源匹配（协议/端口/通配符/路径/self）、指令回退、
内联/nonce/hash、strict-dynamic、多策略叠加、仅报告模式、历史快照、样例自检。
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from csp.engine import ResourceRequest, evaluate_all, evaluate_one
from csp.matcher import parse_url
from csp.parser import parse_policy
from csp.samples import run_samples
from csp.storage import Storage, StorageError

PAGE = "https://shop.example/index.html"


def req(**kw):
    base = {"page_url": PAGE, "initiator": "page"}
    base.update(kw)
    return ResourceRequest(**base)


class TestParser(unittest.TestCase):
    def test_valid_policy_structure(self):
        p = parse_policy("default-src 'self'; img-src https://cdn.example.com")
        self.assertTrue(p.ok)
        self.assertEqual([d.name for d in p.directives], ["default-src", "img-src"])
        d = p.get_directive("img-src")
        self.assertEqual(d.sources[0].kind, "host")
        self.assertEqual(d.sources[0].host, "cdn.example.com")

    def test_error_positions_are_reported(self):
        text = "default-src 'self';\nimg-src https://a.com:99999;\nscript-src 'self';\nscript-src 'none'"
        p = parse_policy(text)
        self.assertFalse(p.ok)
        codes = {i.code for i in p.errors}
        self.assertIn("BAD_PORT", codes)
        self.assertIn("DUPLICATE_DIRECTIVE", codes)
        bad_port = next(i for i in p.errors if i.code == "BAD_PORT")
        self.assertEqual(bad_port.line, 2)
        dup = next(i for i in p.errors if i.code == "DUPLICATE_DIRECTIVE")
        self.assertEqual(dup.line, 4)

    def test_empty_segment_and_unclosed_quote(self):
        p = parse_policy("default-src 'self';; style-src 'oops")
        self.assertFalse(p.ok)
        codes = {i.code for i in p.errors}
        self.assertIn("EMPTY_DIRECTIVE", codes)
        self.assertIn("UNCLOSED_QUOTE", codes)

    def test_bad_nonce_and_hash(self):
        p1 = parse_policy("script-src 'nonce-'")
        self.assertFalse(p1.ok)
        self.assertEqual(p1.errors[0].code, "EMPTY_NONCE")
        p2 = parse_policy("script-src 'md5-abc'")
        self.assertFalse(p2.ok)
        self.assertEqual(p2.errors[0].code, "UNSUPPORTED_HASH_ALGO")
        p3 = parse_policy("script-src 'sha256-@@@'")
        self.assertFalse(p3.ok)
        self.assertEqual(p3.errors[0].code, "BAD_HASH")

    def test_blank_policy_warns_not_silent(self):
        p = parse_policy("   \n  ")
        self.assertTrue(p.ok)
        self.assertTrue(any(w.code == "EMPTY_POLICY" for w in p.warnings))

    def test_unknown_directive_is_warning_not_guess(self):
        p = parse_policy("weird-src 'self'")
        self.assertTrue(p.ok)
        self.assertEqual(p.warnings[0].code, "UNKNOWN_DIRECTIVE")

    def test_illegal_host_characters_rejected(self):
        # '@@' 不能被 userinfo/通配规则悄悄吞掉
        p = parse_policy("img-src bad@@.com")
        self.assertFalse(p.ok)
        self.assertIn(p.errors[0].code, ("BAD_HOST", "BAD_SOURCE"))
        # 合法 userinfo 仅警告
        p2 = parse_policy("img-src https://user@cdn.example.com")
        self.assertTrue(p2.ok)
        self.assertTrue(any(w.code == "USERINFO_IGNORED" for w in p2.warnings))

    def test_none_with_other_sources_warns(self):
        p = parse_policy("img-src 'none' https://a.com")
        self.assertTrue(any(w.code == "NONE_IGNORED" for w in p.warnings))

    def test_unsafe_inline_ignored_with_nonce_warning(self):
        p = parse_policy("script-src 'nonce-x' 'unsafe-inline'")
        self.assertTrue(any(w.code == "UNSAFE_INLINE_IGNORED" for w in p.warnings))

    def test_scheme_and_keyword_kinds(self):
        p = parse_policy("img-src data: 'self' 'unsafe-inline'")
        kinds = {s.raw: s.kind for s in p.get_directive("img-src").sources}
        self.assertEqual(kinds["data:"], "scheme")
        self.assertEqual(kinds["'self'"], "keyword")
        self.assertEqual(kinds["'unsafe-inline'"], "keyword")


class TestMatcher(unittest.TestCase):
    def test_scheme_host_port_path(self):
        cases = [
            ("https://cdn.example.com/a.png", "https://cdn.example.com", True),
            ("http://cdn.example.com/a.png", "https://cdn.example.com", False),
            ("https://cdn.example.com:8443/a.png", "https://cdn.example.com", False),
            ("https://cdn.example.com/lib/a.js", "https://cdn.example.com/lib", True),
            ("https://cdn.example.com/other/a.js", "https://cdn.example.com/lib", False),
            ("https://a.img.example.com/x.png", "https://*.img.example.com", True),
            ("https://img.example.com/x.png", "https://*.img.example.com", False),
        ]
        page = parse_url(PAGE)
        for url, raw, expect in cases:
            parsed = parse_policy(f"img-src {raw}")
            expr = parsed.get_directive("img-src").sources[0]
            ok, _ = __import__("csp.matcher", fromlist=["match_source"]).match_source(
                expr, parse_url(url), page
            )
            self.assertEqual(ok, expect, f"{url} vs {raw}")

    def test_self_origin_matching_with_default_port(self):
        parsed = parse_policy("script-src 'self'")
        expr = parsed.get_directive("script-src").sources[0]
        from csp.matcher import match_source
        page = parse_url(PAGE)
        self.assertTrue(match_source(expr, parse_url("https://shop.example/app.js"), page)[0])
        # 显式默认端口归一后仍同源
        self.assertTrue(match_source(expr, parse_url("https://shop.example:443/app.js"), page)[0])
        self.assertFalse(match_source(expr, parse_url("https://shop.example:8443/app.js"), page)[0])

    def test_data_url_needs_scheme_source(self):
        from csp.matcher import match_source
        page = parse_url(PAGE)
        p_self = parse_policy("img-src 'self'")
        ok, _ = match_source(p_self.get_directive("img-src").sources[0], parse_url("data:image/png;base64,xx"), page)
        self.assertFalse(ok)
        p_data = parse_policy("img-src data:")
        ok, _ = match_source(p_data.get_directive("img-src").sources[0], parse_url("data:image/png;base64,xx"), page)
        self.assertTrue(ok)

    def test_invalid_url_raises(self):
        with self.assertRaises(ValueError):
            parse_url("not-a-url")


class TestDirectiveFallback(unittest.TestCase):
    def setUp(self):
        self.parsed = parse_policy(
            "default-src 'self'; img-src https://cdn.example.com; frame-src https://f.example.com"
        )

    def test_specific_directive_used(self):
        d = evaluate_one(self.parsed, req(resource_type="img",
                                          resource_url="https://cdn.example.com/a.png"))
        self.assertEqual(d.decision, "allow")
        self.assertEqual(d.matched_directive, "img-src")
        d2 = evaluate_one(self.parsed, req(resource_type="img",
                                           resource_url="https://shop.example/a.png"))
        self.assertEqual(d2.decision, "block")

    def test_default_src_fallback(self):
        d = evaluate_one(self.parsed, req(resource_type="font",
                                          resource_url="https://shop.example/f.woff2"))
        self.assertEqual(d.decision, "allow")
        self.assertEqual(d.matched_directive, "default-src")
        self.assertEqual(d.directive_chain, ["font-src", "default-src"])

    def test_frame_chain_order(self):
        d = evaluate_one(self.parsed, req(resource_type="frame",
                                          resource_url="https://f.example.com/e"))
        self.assertEqual(d.matched_directive, "frame-src")
        self.assertEqual(d.directive_chain, ["frame-src", "child-src", "default-src"])

    def test_no_directive_means_unrestricted(self):
        parsed = parse_policy("img-src 'none'")
        d = evaluate_one(parsed, req(resource_type="media",
                                     resource_url="https://anything.example/m.mp4"))
        self.assertEqual(d.decision, "allow")
        self.assertIsNone(d.matched_directive)


class TestInlineNonceHash(unittest.TestCase):
    def setUp(self):
        self.parsed = parse_policy(
            "script-src 'nonce-r4nd0m' 'sha256-d0A9Zq3U4k7Q0YgP8mY3wV2xR1cT6bN5mL8kH0pQeRs='; "
            "style-src 'unsafe-inline'"
        )

    def test_inline_nonce_hit_and_miss(self):
        ok = evaluate_one(self.parsed, req(resource_type="script", is_inline=True,
                                           nonce="r4nd0m", inline_content="x"))
        self.assertEqual(ok.decision, "allow")
        miss = evaluate_one(self.parsed, req(resource_type="script", is_inline=True,
                                             nonce="bad", inline_content="x"))
        self.assertEqual(miss.decision, "block")

    def test_inline_hash_computed_locally(self):
        import base64
        import hashlib
        content = "console.log('hi')"
        digest = "sha256-" + base64.b64encode(hashlib.sha256(content.encode()).digest()).decode()
        parsed = parse_policy(f"script-src '{digest}'")
        d = evaluate_one(parsed, req(resource_type="script", is_inline=True,
                                     inline_content=content, inline_digest=digest))
        self.assertEqual(d.decision, "allow")
        # 只给原文、由引擎本地计算 sha256 摘要同样放行
        d2 = evaluate_one(parsed, req(resource_type="script", is_inline=True,
                                      inline_content=content))
        self.assertEqual(d2.decision, "allow")

    def test_inline_without_token_blocked(self):
        d = evaluate_one(self.parsed, req(resource_type="script", is_inline=True,
                                          inline_content="whatever"))
        self.assertEqual(d.decision, "block")

    def test_unsafe_inline_allows_style(self):
        d = evaluate_one(self.parsed, req(resource_type="style", is_inline=True,
                                          inline_content="body{}"))
        self.assertEqual(d.decision, "allow")

    def test_unsafe_inline_ignored_when_nonce_present(self):
        parsed = parse_policy("script-src 'nonce-x' 'unsafe-inline'")
        d = evaluate_one(parsed, req(resource_type="script", is_inline=True,
                                     inline_content="alert(1)"))
        self.assertEqual(d.decision, "block")

    def test_nonce_does_not_leak_across_resource_classes(self):
        # 图片策略里即便有主机源，脚本请求也不能复用
        parsed = parse_policy("img-src https://cdn.example.com; script-src 'none'")
        d = evaluate_one(parsed, req(resource_type="script",
                                     resource_url="https://cdn.example.com/a.js"))
        self.assertEqual(d.decision, "block")


class TestStrictDynamic(unittest.TestCase):
    def setUp(self):
        self.parsed = parse_policy(
            "script-src 'nonce-abc' https://scripts.example.com 'strict-dynamic'"
        )

    def test_host_ignored_for_page_initiated(self):
        d = evaluate_one(self.parsed, req(resource_type="script",
                                          resource_url="https://scripts.example.com/a.js"))
        self.assertEqual(d.decision, "block")

    def test_nonce_still_works(self):
        d = evaluate_one(self.parsed, req(resource_type="script",
                                          resource_url="https://scripts.example.com/a.js",
                                          nonce="abc"))
        self.assertEqual(d.decision, "allow")

    def test_trusted_propagation(self):
        d = evaluate_one(self.parsed, req(resource_type="script",
                                          resource_url="https://anywhere.example/x.js",
                                          initiator="script", parent_trusted=True))
        self.assertEqual(d.decision, "allow")
        d2 = evaluate_one(self.parsed, req(resource_type="script",
                                           resource_url="https://anywhere.example/x.js",
                                           initiator="script", parent_trusted=False))
        self.assertEqual(d2.decision, "block")


class TestMultiplePoliciesAndModes(unittest.TestCase):
    def test_enforce_policies_and_relation(self):
        a = parse_policy("img-src https://cdn.example.com https://img.other.com")
        b = parse_policy("img-src https://cdn.example.com")
        entries = [
            {"id": "a", "name": "A", "mode": "enforce", "parsed": a},
            {"id": "b", "name": "B", "mode": "enforce", "parsed": b},
        ]
        r1 = evaluate_all(entries, req(resource_type="img",
                                       resource_url="https://cdn.example.com/x.png"))
        self.assertEqual(r1.decision, "allow")
        r2 = evaluate_all(entries, req(resource_type="img",
                                       resource_url="https://img.other.com/y.png"))
        self.assertEqual(r2.decision, "block")

    def test_report_only_does_not_change_result(self):
        strict = parse_policy("img-src 'self'")
        entries = [{"id": "r", "name": "R", "mode": "report", "parsed": strict}]
        r = evaluate_all(entries, req(resource_type="img",
                                      resource_url="https://third.example.net/x.png"))
        self.assertEqual(r.decision, "allow")
        self.assertEqual(len(r.reports), 1)
        self.assertEqual(r.reports[0].mode, "report")

    def test_mixed_enforce_and_report(self):
        loose = parse_policy("img-src https://cdn.example.com")
        strict = parse_policy("img-src 'self'")
        entries = [
            {"id": "e", "name": "拦截", "mode": "enforce", "parsed": loose},
            {"id": "r", "name": "报告", "mode": "report", "parsed": strict},
        ]
        # 拦截策略放行 -> 最终放行，但报告策略产生报告
        r = evaluate_all(entries, req(resource_type="img",
                                      resource_url="https://cdn.example.com/x.png"))
        self.assertEqual(r.decision, "allow")
        self.assertEqual(len(r.reports), 1)

    def test_empty_policy_set_allows(self):
        r = evaluate_all([], req(resource_type="img", resource_url="https://x.example/a.png"))
        self.assertEqual(r.decision, "allow")


class TestStorageAndSnapshots(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Storage(os.path.join(self.tmp.name, "data.json"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_broken_policy_rejected_not_flattened(self):
        with self.assertRaises(StorageError):
            self.store.add_policy("坏策略", "default-src 'self';; img-src 'bad@@'")
        self.assertEqual(self.store.list_policies(), [])

    def test_history_keeps_snapshot_after_replace_and_delete(self):
        p = self.store.add_policy("v1", "img-src 'self'")
        rec1 = self.store.analyze(
            [p["id"]],
            {"page_url": PAGE, "resource_type": "img",
             "resource_url": "https://other.example/a.png", "initiator": "page"},
        )
        self.assertEqual(rec1["decision"], "block")
        # 替换为更宽松的策略
        self.store.replace_policy(p["id"], "v2", "img-src https://other.example", "enforce")
        recs = self.store.list_records()
        self.assertEqual(len(recs), 1)
        snap = recs[0]["policy_snapshots"][0]
        self.assertEqual(snap["name"], "v1")
        self.assertIn("'self'", snap["text"])
        # 删除策略后历史仍在且快照不变
        self.store.delete_policy(p["id"])
        recs2 = self.store.list_records()
        self.assertEqual(len(recs2), 1)
        self.assertEqual(recs2[0]["policy_snapshots"][0]["name"], "v1")

    def test_report_record_fields(self):
        p = self.store.add_policy("报告", "img-src 'self'", mode="report")
        rec = self.store.analyze(
            [p["id"]],
            {"page_url": PAGE, "resource_type": "img",
             "resource_url": "https://other.example/a.png", "initiator": "page"},
        )
        self.assertEqual(rec["decision"], "allow")
        self.assertEqual(rec["reports"][0]["matched_directive"], "img-src")
        self.assertIn("time", rec)
        self.assertIn("reason", rec["reports"][0])

    def test_filters(self):
        p1 = self.store.add_policy("p1", "img-src 'self'")
        p2 = self.store.add_policy("p2", "font-src 'self'")
        self.store.analyze([p1["id"]], {"page_url": PAGE, "resource_type": "img",
                                        "resource_url": "https://other.example/a",
                                        "initiator": "page"})
        self.store.analyze([p2["id"]], {"page_url": PAGE, "resource_type": "font",
                                        "resource_url": "https://shop.example/f",
                                        "initiator": "page"})
        self.assertEqual(len(self.store.list_records(resource_type="img")), 1)
        self.assertEqual(len(self.store.list_records(decision="allow")), 1)
        self.assertEqual(len(self.store.list_records(policy_id=p1["id"])), 1)


class TestSamplesSelfCheck(unittest.TestCase):
    def test_all_samples_match_expectations(self):
        out = run_samples()
        self.assertTrue(out["all_pass"], msg=[
            (r["key"], r["expected"], r["actual"])
            for c in out["cases"] for r in c["rows"] if not r["passed"]
        ])


if __name__ == "__main__":
    unittest.main(verbosity=2)
