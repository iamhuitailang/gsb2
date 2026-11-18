"""本地 Web API 端到端测试（127.0.0.1 随机端口，无外部网络）。"""

import json
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from threading import Thread

from baseline_audit.webapp import build_handler
from tests._helpers import AuditTestCase


class WebApiTests(AuditTestCase):
    def setUp(self):
        super().setUp()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), build_handler(self.auditor))
        self.port = self.httpd.server_address[1]
        self.thread = Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        super().tearDown()

    def _request(self, path, payload=None):
        url = f"http://127.0.0.1:{self.port}{path}"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(url, data=data,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def test_health_and_static_page(self):
        self.assertTrue(self._request("/api/health")["ok"])
        with urllib.request.urlopen(
            f"http://127.0.0.1:{self.port}/", timeout=10
        ) as resp:
            body = resp.read().decode("utf-8")
        self.assertIn("本地安全基线核查台", body)

    def test_scan_flow_baseline_exception_export(self):
        self.write("conf/open.conf", "x=1\n", 0o666)
        data = self._request("/api/scan", {"path": self.root})
        token = data["root_token"]
        run = data["run"]
        self.assertTrue(run["findings"])
        # 响应不含绝对路径
        self.assertNotIn(self.root, json.dumps(data))

        # 保存基线
        self._request("/api/baseline",
                      {"root_token": token, "run_id": run["run_id"]})
        baseline = self._request(f"/api/baseline?root_token={token}")["baseline"]
        self.assertTrue(baseline["findings"])

        # 添加例外
        finding_id = run["findings"][0]["id"]
        self._request("/api/exceptions", {
            "root_token": token, "finding_id": finding_id,
            "scope": "finding", "expires_at": "", "reason": "测试例外",
        })
        exceptions = self._request(
            f"/api/exceptions?root_token={token}"
        )["exceptions"]
        self.assertEqual(len(exceptions), 1)

        # 重新核查后例外生效
        data2 = self._request("/api/scan", {"path": self.root})
        matched = next(f for f in data2["run"]["findings"] if f["id"] == finding_id)
        self.assertIsNotNone(matched["exception"])

        # 导出
        report = self._request(f"/api/export?root_token={token}")
        self.assertEqual(report["rule_version"], run["rule_version"])
        self.assertNotIn(self.root, json.dumps(report))

        # 审计日志
        log = self._request("/api/log")["events"]
        self.assertTrue(any(e["event"] == "exception_added" for e in log))

    def test_stale_token_is_rejected(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self._request("/api/runs?root_token=deadbeefdeadbeef")
        self.assertEqual(ctx.exception.code, 400)

    def test_invalid_root_is_rejected(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self._request("/api/scan", {"path": "/nonexistent/path/xyz"})
        self.assertEqual(ctx.exception.code, 400)

    def test_static_path_traversal_blocked(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(
                f"http://127.0.0.1:{self.port}/../../etc/passwd", timeout=10
            )
        # 归一化后由服务端返回 404（urllib 可能先规范化路径，两种都可接受）
        self.assertIn(ctx.exception.code, (404, 400))
