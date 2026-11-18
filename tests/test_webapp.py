"""Web 服务冒烟测试: 启动真实本机 HTTP 服务并通过 HTTP 调用全部接口。"""
import json
import tempfile
import threading
import unittest
import urllib.request
from urllib.error import HTTPError

from cookie_sim.webapp import create_server


class WebAppSmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        storage = tempfile.mktemp(dir=cls.tmp.name, suffix=".json")
        cls.server = create_server("127.0.0.1", 0, storage)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def _call(self, path, payload=None, method=None):
        data = None
        headers = {}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=data, headers=headers, method=method or ("POST" if data else "GET"),
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except HTTPError as exc:
            return exc.code, json.loads(exc.read().decode("utf-8"))

    def test_static_index(self):
        with urllib.request.urlopen(
            f"http://127.0.0.1:{self.port}/", timeout=5
        ) as resp:
            html = resp.read().decode("utf-8")
        self.assertIn("Cookie 安全策略模拟器", html)

    def test_full_flow(self):
        # 合法 cookie 入库
        status, data = self._call("/api/set-cookie", {
            "source_url": "https://shop.example.com/account/x",
            "set_cookies": [
                "sid=abc; Path=/; HttpOnly",
                "bad=1; SameSite=None",
            ],
        })
        self.assertEqual(status, 200)
        self.assertEqual(len(data["jar"]["cookies"]), 1)
        self.assertEqual(len(data["jar"]["rejections"]), 1)
        self.assertIn("Secure", data["jar"]["rejections"][0]["reason"])

        # 同站请求带上
        status, d = self._call("/api/evaluate", {
            "request_url": "https://shop.example.com/api",
            "top_url": "https://shop.example.com/home",
            "method": "GET",
            "is_navigation": False,
        })
        self.assertEqual(d["cookie_header"], "sid=abc")
        self.assertFalse(d["cross_site"])

        # 脚本视图读不到 HttpOnly
        status, view = self._call("/api/script-view", {
            "document_url": "https://shop.example.com/page",
        })
        self.assertEqual(view["readable"], [])
        self.assertIn("HttpOnly", view["excluded"][0]["reason"])

        # 样例载入
        status, data = self._call("/api/load-sample",
                                  {"sample_id": "strict-cross-site"})
        self.assertEqual(status, 200)
        self.assertTrue(data["jar"]["cookies"])

        # 错误 URL 返回 400
        status, data = self._call("/api/evaluate", {
            "request_url": "not-a-url",
            "top_url": "https://shop.example.com/",
        })
        self.assertEqual(status, 400)
        self.assertIn("error", data)

        # 清空
        status, data = self._call("/api/clear", {})
        self.assertEqual(data["cookies"], [])


if __name__ == "__main__":
    unittest.main()
