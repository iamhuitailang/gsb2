"""域名/路径匹配与同站判断测试。"""
import unittest

from cookie_sim.matching import (
    canonicalize_host,
    default_path,
    domain_matches,
    is_ip_address,
    path_matches,
)
from cookie_sim.sites import UrlInfo, is_cross_site, parse_url, registrable_domain


class MatchingTest(unittest.TestCase):
    def test_domain_label_boundary(self):
        self.assertTrue(domain_matches("example.com", "example.com"))
        self.assertTrue(domain_matches("example.com", "a.b.example.com"))
        # 完整标签边界: 前缀相似但不是子域
        self.assertFalse(domain_matches("example.com", "evil-example.com"))
        self.assertFalse(domain_matches("example.com", "evilexample.com"))
        # 大小写与根点容错
        self.assertTrue(domain_matches("Example.COM.", "shop.example.com"))

    def test_canonicalize_host(self):
        self.assertEqual(canonicalize_host("SHOP.Example.com."), "shop.example.com")
        with self.assertRaises(ValueError):
            canonicalize_host("")
        with self.assertRaises(ValueError):
            canonicalize_host(".bad.example")

    def test_ip_detection(self):
        self.assertTrue(is_ip_address("127.0.0.1"))
        self.assertTrue(is_ip_address("::1"))
        self.assertFalse(is_ip_address("example.com"))

    def test_default_path_algorithm(self):
        self.assertEqual(default_path("/"), "/")
        self.assertEqual(default_path("/page"), "/")
        self.assertEqual(default_path("/a/b/c"), "/a/b")
        self.assertEqual(default_path(""), "/")

    def test_path_boundary(self):
        self.assertTrue(path_matches("/", "/anything"))
        self.assertTrue(path_matches("/store", "/store"))
        self.assertTrue(path_matches("/store", "/store/cart"))
        self.assertTrue(path_matches("/store/", "/store/x"))
        # /cart 不得匹配 /cartoon
        self.assertFalse(path_matches("/cart", "/cartoon"))
        self.assertFalse(path_matches("/store", "/storeother"))


class SitesTest(unittest.TestCase):
    def test_parse_url_validation(self):
        info = parse_url("https://shop.example.com:8443/a/b?x=1")
        self.assertEqual(info.scheme, "https")
        self.assertEqual(info.host, "shop.example.com")
        self.assertEqual(info.port, 8443)
        self.assertEqual(info.path, "/a/b")
        self.assertTrue(info.is_secure)
        with self.assertRaises(ValueError):
            parse_url("ftp://example.com/")
        with self.assertRaises(ValueError):
            parse_url("example.com/no-scheme")
        with self.assertRaises(ValueError):
            parse_url("https:///nohost")

    def test_registrable_domain_with_suffix_list(self):
        self.assertEqual(registrable_domain("a.b.example.co.uk"), "example.co.uk")
        self.assertEqual(registrable_domain("shop.example.com"), "example.com")
        self.assertEqual(registrable_domain("deep.inside.example.org"), "example.org")
        self.assertEqual(registrable_domain("127.0.0.1"), "127.0.0.1")
        # 未收录后缀: 无法离线判断, 整个主机名视为可注册域
        self.assertEqual(registrable_domain("a.unknown-xyz"), "a.unknown-xyz")

    def test_cross_site_request_vs_top(self):
        def cross(req, top):
            return is_cross_site(parse_url(req), parse_url(top))

        # 同站: 子域之间
        self.assertFalse(cross("https://shop.example.com/x",
                               "https://www.example.com/y"))
        # 跨站: 不同可注册域
        self.assertTrue(cross("https://shop.example.com/x",
                              "https://blog.example.org/y"))
        # 跨站: 同域不同协议(schemeful same-site)
        self.assertTrue(cross("http://shop.example.com/x",
                              "https://shop.example.com/y"))
        # 跨站: 公共后缀相同但可注册域不同
        self.assertTrue(cross("https://a.co.uk/x", "https://b.co.uk/y"))
        # 同站: 仅端口不同
        self.assertFalse(cross("https://example.com:8080/x",
                               "https://example.com:9000/y"))


if __name__ == "__main__":
    unittest.main()
