"""Set-Cookie 关键属性解析与拒收原因测试。"""
import unittest

from cookie_sim.model import SameSite
from cookie_sim.parser import parse_set_cookie

SRC = "https://shop.example.com/account/orders"
NOW = 1_000_000.0


class ParseTest(unittest.TestCase):
    def test_basic_host_only_and_default_path(self):
        r = parse_set_cookie("sid=abc; HttpOnly", SRC, now=NOW)
        self.assertTrue(r.accepted, r.reason)
        c = r.cookie
        self.assertTrue(c.host_only)
        self.assertEqual(c.domain, "shop.example.com")
        # 默认路径取来源 URL 的目录部分
        self.assertEqual(c.path, "/account")
        self.assertTrue(c.http_only)
        # 未指定 SameSite -> Lax, 并给出提示
        self.assertIs(c.same_site, SameSite.LAX)
        self.assertTrue(any("SameSite" in w for w in r.warnings))

    def test_default_path_root_and_single_segment(self):
        r1 = parse_set_cookie("a=1", "https://h.test/", now=NOW)
        self.assertEqual(r1.cookie.path, "/")
        r2 = parse_set_cookie("a=1", "https://h.test/page", now=NOW)
        self.assertEqual(r2.cookie.path, "/")
        r3 = parse_set_cookie("a=1", "https://h.test/a/b/c", now=NOW)
        self.assertEqual(r3.cookie.path, "/a/b")

    def test_domain_cookie_and_leading_dot(self):
        r = parse_set_cookie("a=1; Domain=.example.com", SRC, now=NOW)
        self.assertTrue(r.accepted, r.reason)
        self.assertFalse(r.cookie.host_only)
        self.assertEqual(r.cookie.domain, "example.com")

    def test_domain_label_boundary_rejection(self):
        # evil-example.com 不是 example.com 的子域
        r = parse_set_cookie("a=1; Domain=example.com",
                             "https://evil-example.com/", now=NOW)
        self.assertFalse(r.accepted)
        self.assertIn("同一域", r.reason)

    def test_public_suffix_rejected(self):
        r = parse_set_cookie("a=1; Domain=com", SRC, now=NOW)
        self.assertFalse(r.accepted)
        self.assertIn("公共后缀", r.reason)

    def test_ip_domain_rejected(self):
        r = parse_set_cookie("a=1; Domain=1.2.3.4",
                             "http://1.2.3.4/", now=NOW)
        self.assertFalse(r.accepted)
        self.assertIn("IP", r.reason)

    def test_malformed_name_value(self):
        self.assertFalse(parse_set_cookie("noequals", SRC, now=NOW).accepted)
        bad_name = parse_set_cookie("a b=1", SRC, now=NOW)
        self.assertFalse(bad_name.accepted)
        self.assertIn("名称", bad_name.reason)
        bad_value = parse_set_cookie('a=1 2; Path=/', SRC, now=NOW)
        self.assertFalse(bad_value.accepted)
        self.assertIn("值", bad_value.reason)
        empty = parse_set_cookie("   ", SRC, now=NOW)
        self.assertFalse(empty.accepted)

    def test_quoted_value_accepted_and_unwrapped(self):
        r = parse_set_cookie('a="hello world"; Path=/', SRC, now=NOW)
        self.assertTrue(r.accepted, r.reason)
        self.assertEqual(r.cookie.value, "hello world")

    def test_attribute_conflict_rejected(self):
        r = parse_set_cookie("a=1; Path=/; Path=/other", SRC, now=NOW)
        self.assertFalse(r.accepted)
        self.assertIn("冲突", r.reason)
        # 同名属性取值一致 -> 接受并警告
        r2 = parse_set_cookie("a=1; Path=/; Path=/", SRC, now=NOW)
        self.assertTrue(r2.accepted)
        self.assertTrue(r2.warnings)

    def test_max_age_preferred_over_expires(self):
        r = parse_set_cookie(
            "a=1; Max-Age=60; Expires=Mon, 01 Jan 1990 00:00:00 GMT",
            SRC, now=NOW,
        )
        self.assertTrue(r.accepted, r.reason)
        self.assertEqual(r.cookie.expires, NOW + 60)
        self.assertTrue(any("Max-Age" in w for w in r.warnings))

    def test_bad_max_age_and_expires_rejected(self):
        r1 = parse_set_cookie("a=1; Max-Age=soon", SRC, now=NOW)
        self.assertFalse(r1.accepted)
        self.assertIn("Max-Age", r1.reason)
        r2 = parse_set_cookie("a=1; Expires=not-a-date", SRC, now=NOW)
        self.assertFalse(r2.accepted)
        self.assertIn("Expires", r2.reason)

    def test_expires_http_dates(self):
        for date_str in (
            "Sun, 06 Nov 1994 08:49:37 GMT",      # RFC 1123
            "Sunday, 06-Nov-94 08:49:37 GMT",     # RFC 850
            "Sun Nov  6 08:49:37 1994",           # asctime
        ):
            r = parse_set_cookie(f"a=1; Expires={date_str}", SRC, now=NOW)
            self.assertTrue(r.accepted, f"{date_str}: {r.reason}")
            self.assertEqual(r.cookie.expires, 784111777.0)

    def test_samesite_none_requires_secure(self):
        r = parse_set_cookie("a=1; SameSite=None", SRC, now=NOW)
        self.assertFalse(r.accepted)
        self.assertIn("Secure", r.reason)
        r2 = parse_set_cookie("a=1; SameSite=None; Secure", SRC, now=NOW)
        self.assertTrue(r2.accepted)
        self.assertIs(r2.cookie.same_site, SameSite.NONE)

    def test_unknown_samesite_and_unknown_attribute(self):
        r = parse_set_cookie("a=1; SameSite=Maybe", SRC, now=NOW)
        self.assertFalse(r.accepted)
        self.assertIn("SameSite", r.reason)
        r2 = parse_set_cookie("a=1; NewfangledThing=x", SRC, now=NOW)
        self.assertTrue(r2.accepted)
        self.assertTrue(any("无法识别" in w for w in r2.warnings))

    def test_relative_path_ignored(self):
        r = parse_set_cookie("a=1; Path=relative", SRC, now=NOW)
        self.assertTrue(r.accepted)
        self.assertEqual(r.cookie.path, "/account")
        self.assertTrue(any("默认路径" in w for w in r.warnings))


if __name__ == "__main__":
    unittest.main()
