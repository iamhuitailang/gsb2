"""Cookie 库更新/删除、请求 SameSite 决策、排序与脚本可读视图测试。"""
import unittest

from cookie_sim.jar import CookieJar
from cookie_sim.model import SameSite
from cookie_sim.parser import parse_set_cookie
from cookie_sim.request import evaluate_request, script_readable_cookies

NOW = 2_000_000.0


def make_jar(now=NOW):
    return CookieJar(now_func=lambda: now)


def add(jar, raw, source, now=NOW):
    r = parse_set_cookie(raw, source, now=now)
    assert r.accepted, r.reason
    return jar.add(r.cookie)


class JarUpdateDeleteTest(unittest.TestCase):
    def test_same_key_updates_value_and_seq(self):
        jar = make_jar()
        c1 = add(jar, "a=1; Path=/", "https://h.example.com/")
        c2 = add(jar, "a=2; Path=/", "https://h.example.com/")
        self.assertEqual(len(jar.all_cookies()), 1)
        self.assertEqual(jar.get(c1.key()).value, "2")
        self.assertGreater(c2.seq, c1.seq)

    def test_same_name_different_domain_or_path_coexist(self):
        jar = make_jar()
        add(jar, "t=host; Path=/", "https://shop.example.com/")
        add(jar, "t=wide; Path=/; Domain=example.com",
            "https://shop.example.com/")
        add(jar, "t=deep; Path=/app", "https://shop.example.com/app/x")
        names = sorted((c.name, c.domain, c.path) for c in jar.all_cookies())
        self.assertEqual(len(names), 3)

    def test_max_age_zero_only_deletes_matching_tuple(self):
        jar = make_jar()
        add(jar, "token=first; Path=/app",
            "https://shop.example.com/app/home")
        add(jar, "token=second; Path=/app/home",
            "https://shop.example.com/app/home")
        # Max-Age=0 只删除 名称+域+路径 完全相同的那条
        add(jar, "token=gone; Path=/app; Max-Age=0",
            "https://shop.example.com/app/home")
        remaining = {(c.path, c.value) for c in jar.all_cookies()}
        self.assertEqual(remaining, {("/app/home", "second")})

    def test_past_expires_deletes_matching_tuple(self):
        jar = make_jar()
        add(jar, "a=1; Path=/", "https://h.example.com/")
        # 用负 Max-Age 表达"过去的过期时间", 与过去 Expires 走同一删除路径
        r = parse_set_cookie("a=dead; Path=/; Max-Age=-100",
                             "https://h.example.com/", now=NOW)
        self.assertTrue(r.accepted)
        jar.add(r.cookie)
        self.assertEqual(jar.all_cookies(), [])

    def test_expired_kept_until_purge_and_not_sent(self):
        jar = make_jar()
        c = add(jar, "a=1; Max-Age=10; Path=/", "https://h.example.com/")
        # 未过期正常发送
        d = evaluate_request(jar, "https://h.example.com/",
                             "https://h.example.com/", now=NOW + 5)
        self.assertEqual(d.cookie_header, "a=1")
        # 过期后不发送, 但仍在库里(可手动清理)
        d2 = evaluate_request(jar, "https://h.example.com/",
                              "https://h.example.com/", now=NOW + 11)
        self.assertEqual(d2.cookie_header, "")
        self.assertEqual(len(jar.all_cookies()), 1)
        self.assertEqual(jar.purge_expired(now=NOW + 11), 1)
        self.assertEqual(jar.all_cookies(), [])
        self.assertTrue(c.is_expired(NOW + 11))

    def test_rejection_records_kept(self):
        jar = make_jar()
        r = parse_set_cookie("a=1; Domain=com", "https://h.example.com/")
        self.assertFalse(r.accepted)
        jar.reject("a=1; Domain=com", "h.example.com", r.reason)
        self.assertEqual(len(jar.rejections()), 1)
        self.assertIn("公共后缀", jar.rejections()[0].reason)


class SameSiteRequestTest(unittest.TestCase):
    def _ss_jar(self, attr):
        jar = make_jar()
        raw = f"sid=x; Path=/; SameSite={attr}"
        if attr == "None":
            raw += "; Secure"
        add(jar, raw, "https://shop.example.com/")
        return jar

    def test_strict_blocks_cross_site_even_navigation(self):
        jar = self._ss_jar("Strict")
        d = evaluate_request(jar, "https://shop.example.com/w",
                             "https://blog.example.org/p",
                             method="GET", is_navigation=True, now=NOW)
        self.assertTrue(d.cross_site)
        self.assertEqual(d.cookie_header, "")
        self.assertIn("Strict", d.decisions[0].block_reason)

    def test_lax_allows_safe_top_level_navigation(self):
        jar = self._ss_jar("Lax")
        d = evaluate_request(jar, "https://shop.example.com/w",
                             "https://blog.example.org/p",
                             method="GET", is_navigation=True, now=NOW)
        self.assertEqual(d.cookie_header, "sid=x")

    def test_lax_blocks_post_navigation(self):
        jar = self._ss_jar("Lax")
        d = evaluate_request(jar, "https://shop.example.com/w",
                             "https://blog.example.org/p",
                             method="POST", is_navigation=True, now=NOW)
        self.assertEqual(d.cookie_header, "")
        self.assertIn("安全方法", d.decisions[0].block_reason)

    def test_lax_blocks_cross_site_subresource(self):
        jar = self._ss_jar("Lax")
        d = evaluate_request(jar, "https://shop.example.com/pixel",
                             "https://blog.example.org/p",
                             method="GET", is_navigation=False, now=NOW)
        self.assertEqual(d.cookie_header, "")
        self.assertIn("子资源", d.decisions[0].block_reason)

    def test_none_secure_sent_cross_site(self):
        jar = self._ss_jar("None")
        d = evaluate_request(jar, "https://shop.example.com/pixel",
                             "https://blog.example.org/p",
                             method="POST", is_navigation=False, now=NOW)
        self.assertEqual(d.cookie_header, "sid=x")

    def test_default_lax_for_missing_samesite(self):
        jar = make_jar()
        add(jar, "sid=x; Path=/", "https://shop.example.com/")
        d = evaluate_request(jar, "https://shop.example.com/pixel",
                             "https://blog.example.org/p",
                             method="GET", is_navigation=False, now=NOW)
        self.assertIs(d.decisions[0].cookie.same_site, SameSite.LAX)
        self.assertEqual(d.cookie_header, "")

    def test_same_site_requests_always_sent_when_other_checks_pass(self):
        jar = make_jar()
        add(jar, "sid=x; Path=/; SameSite=Strict",
            "https://shop.example.com/")
        d = evaluate_request(jar, "https://shop.example.com/api",
                             "https://shop.example.com/home",
                             method="POST", is_navigation=False, now=NOW)
        self.assertFalse(d.cross_site)
        self.assertEqual(d.cookie_header, "sid=x")


class OtherChecksTest(unittest.TestCase):
    def test_secure_blocked_over_http(self):
        jar = make_jar()
        add(jar, "secret=x; Path=/; Secure", "https://h.example.com/")
        d = evaluate_request(jar, "http://h.example.com/a",
                             "http://h.example.com/b", now=NOW)
        self.assertEqual(d.cookie_header, "")
        self.assertIn("安全连接", d.decisions[0].block_reason)

    def test_host_only_not_sent_to_sibling_subdomain(self):
        jar = make_jar()
        add(jar, "h=1; Path=/", "https://shop.example.com/")
        add(jar, "w=1; Path=/; Domain=example.com",
            "https://shop.example.com/")
        d = evaluate_request(jar, "https://api.example.com/x",
                             "https://api.example.com/y", now=NOW)
        self.assertEqual(d.cookie_header, "w=1")
        blocked = next(x for x in d.decisions if x.cookie.name == "h")
        self.assertIn("域匹配", blocked.block_reason)

    def test_sorting_by_path_length_then_creation(self):
        jar = make_jar()
        add(jar, "a=1; Path=/", "https://h.example.com/")
        add(jar, "b=2; Path=/app", "https://h.example.com/app")
        add(jar, "c=3; Path=/app/deep", "https://h.example.com/app/deep/x")
        add(jar, "d=4; Path=/app", "https://h.example.com/app")
        d = evaluate_request(jar, "https://h.example.com/app/deep/page",
                             "https://h.example.com/home", now=NOW)
        # /app/deep 最前; 同路径 /app 按创建先后 b 在 d 前
        self.assertEqual(d.cookie_header, "c=3; b=2; d=4; a=1")

    def test_each_check_explained(self):
        jar = make_jar()
        add(jar, "a=1; Path=/app; Secure", "https://h.example.com/app/x")
        d = evaluate_request(jar, "http://h.example.com/other",
                             "http://h.example.com/home", now=NOW)
        checks = {chk.key for chk in d.decisions[0].checks}
        self.assertEqual(checks, {"domain", "path", "secure", "expiry", "samesite"})


class ScriptViewTest(unittest.TestCase):
    def test_httponly_hidden_but_still_sent(self):
        jar = make_jar()
        add(jar, "sid=secret; Path=/; HttpOnly",
            "https://shop.example.com/")
        add(jar, "theme=dark; Path=/", "https://shop.example.com/")
        view = script_readable_cookies(jar, "https://shop.example.com/page", now=NOW)
        # 脚本只能读 theme
        self.assertEqual(view.readable_header, "theme=dark")
        self.assertEqual([c.name for c in view.readable], ["theme"])
        excluded = {e["cookie"]["name"]: e["reason"] for e in view.to_dict()["excluded"]}
        self.assertIn("HttpOnly", excluded["sid"])
        # 但实际请求头两者都带
        d = evaluate_request(jar, "https://shop.example.com/page",
                             "https://shop.example.com/home", now=NOW)
        self.assertEqual(set(d.cookie_header.split("; ")), {"sid=secret", "theme=dark"})

    def test_secure_hidden_on_http_document(self):
        jar = make_jar()
        add(jar, "s=1; Path=/; Secure", "https://h.example.com/")
        view = script_readable_cookies(jar, "http://h.example.com/", now=NOW)
        self.assertEqual(view.readable, [])
        self.assertIn("Secure", view.excluded[0][1])

    def test_path_and_expiry_exclusion(self):
        jar = make_jar()
        add(jar, "a=1; Path=/app", "https://h.example.com/app/x")
        add(jar, "b=2; Path=/; Max-Age=-1", "https://h.example.com/")
        # Max-Age 为负, 入库时即删除 -> 库中只剩 a, 视图里 a 因路径不匹配被排除
        view = script_readable_cookies(jar, "https://h.example.com/", now=NOW)
        self.assertEqual(view.readable, [])
        reasons = {e[0].name: e[1] for e in view.excluded}
        self.assertIn("路径", reasons["a"])
        # 过期删除语义单独验证: 同键 cookie 被移除
        self.assertIsNone(jar.get(("b", "h.example.com", "/")))


if __name__ == "__main__":
    unittest.main()
