"""HTTP 端到端测试：普通接口来源不可自填、测试入口模拟来源、时钟与日志接口。"""
from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
import urllib.request
import urllib.error

_TMP_ROOT = tempfile.mkdtemp(prefix="login-svc-http-test-")
os.environ.setdefault("LOGIN_SVC_DATA_DIR", os.path.join(_TMP_ROOT, "default"))

from app.config import Config  # noqa: E402
from app.http_server import build_server  # noqa: E402


def _request(method: str, url: str, payload: dict | None = None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


class HttpEndToEndTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.dir = tempfile.mkdtemp(dir=_TMP_ROOT)
        # 端口 0 让操作系统分配空闲端口
        cls.httpd, cls.service = build_server(Config(data_dir=cls.dir, port=0))
        cls.port = cls.httpd.server_address[1]
        cls.base = f"http://127.0.0.1:{cls.port}"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.service.close()

    def test_01_normal_login_ignores_user_source(self) -> None:
        # 请求体里伪造 source，服务端必须忽略并改用连接地址
        status, body = _request("POST", f"{self.base}/api/login", {
            "username": "jia", "password": "wrong", "source": "forged",
        })
        self.assertEqual(status, 401)
        self.assertEqual(body, {"success": False, "message": "用户名或密码错误"})

        # 管理员日志记录的来源是服务端推导的 ip:127.0.0.1，而不是 forged
        _, log = _request("GET", f"{self.base}/api/demo/admin-log")
        self.assertTrue(any(e["source"] == "ip:127.0.0.1" for e in log["entries"]))
        self.assertFalse(any(e["source"] == "forged" for e in log["entries"]))

        # 普通接口用正确密码可以登录
        status, body = _request("POST", f"{self.base}/api/login", {
            "username": "yi", "password": "yi-pass-123", "source": "forged",
        })
        self.assertEqual(status, 200)
        self.assertTrue(body["success"])
        self.assertEqual(body["source"], "ip:127.0.0.1")

    def test_02_demo_login_source_simulation_and_block(self) -> None:
        # jia 在两个演示来源累计失败 3 次
        for _ in range(2):
            status, _ = _request("POST", f"{self.base}/api/demo/login", {
                "username": "jia", "password": "wrong", "source": "http-A",
            })
            self.assertEqual(status, 401)
        status, _ = _request("POST", f"{self.base}/api/demo/login", {
            "username": "jia", "password": "wrong", "source": "http-B",
        })
        self.assertEqual(status, 401)

        # 新来源也被账号层限制，且响应与普通失败完全一致
        status, body = _request("POST", f"{self.base}/api/demo/login", {
            "username": "jia", "password": "jia-pass-123", "source": "http-C",
        })
        self.assertEqual(status, 401)
        self.assertEqual(body, {"success": False, "message": "用户名或密码错误"})

        # 状态接口能看到账号层锁定与截止时间
        status, body = _request("GET", f"{self.base}/api/demo/status?username=jia&source=http-C")
        self.assertEqual(status, 200)
        self.assertTrue(body["account_window"]["blocked"])
        self.assertIsNotNone(body["account_window"]["deadline"])
        self.assertGreaterEqual(body["account_window"]["retry_after"], 0)
        # 新来源自身用量为 0（被账号层拦截的请求不写来源计数）
        self.assertEqual(body["source_window"]["failures"], 0)

        # 管理员日志标注 account 层生效
        _, log = _request("GET", f"{self.base}/api/demo/admin-log")
        marks = [e for e in log["entries"] if e["kind"] == "login_blocked"]
        self.assertTrue(any(e["layer"] == "account" for e in marks))

    def test_03_clock_advance_then_login_succeeds(self) -> None:
        status, body = _request("POST", f"{self.base}/api/demo/clock", {
            "action": "advance", "seconds": self.service.config.account_window_seconds + 1,
        })
        self.assertEqual(status, 200)

        status, body = _request("POST", f"{self.base}/api/demo/login", {
            "username": "jia", "password": "jia-pass-123", "source": "http-C",
        })
        self.assertEqual(status, 200)
        self.assertTrue(body["success"])

        # 成功后账号计数清零
        status, body = _request("GET", f"{self.base}/api/demo/status?username=jia&source=http-C")
        self.assertEqual(body["account_window"]["failures"], 0)

    def test_04_source_limit_blocks_new_account(self) -> None:
        for i in range(5):
            status, _ = _request("POST", f"{self.base}/api/demo/login", {
                "username": f"cand{i}", "password": "wrong", "source": "shared-http",
            })
            self.assertEqual(status, 401)
        # 第 6 个全新账号也被来源层拦截
        status, body = _request("POST", f"{self.base}/api/demo/login", {
            "username": "fresh", "password": "wrong", "source": "shared-http",
        })
        self.assertEqual(status, 401)
        self.assertEqual(body["message"], "用户名或密码错误")

        _, log = _request("GET", f"{self.base}/api/demo/admin-log")
        self.assertTrue(
            any(e["kind"] == "login_blocked" and e["layer"] == "source" for e in log["entries"])
        )

    def test_05_invalid_source_rejected(self) -> None:
        status, body = _request("POST", f"{self.base}/api/demo/login", {
            "username": "jia", "password": "wrong", "source": "bad source!!",
        })
        self.assertEqual(status, 400)

    def test_06_page_and_health(self) -> None:
        with urllib.request.urlopen(f"{self.base}/") as resp:
            self.assertEqual(resp.status, 200)
            self.assertIn("text/html", resp.headers["Content-Type"])
        status, body = _request("GET", f"{self.base}/health")
        self.assertEqual(status, 200)
        self.assertIn("now", body)


if __name__ == "__main__":
    unittest.main(verbosity=2)
