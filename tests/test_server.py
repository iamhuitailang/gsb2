"""HTTP 服务的自动化测试：只打 127.0.0.1 本机回环，不访问外网。"""

import http.client
import json
import threading
import unittest

from xmlsec.server import create_server


class ServerTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = create_server(port=0)  # 随机空闲端口
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request(method, path, body=body, headers=headers or {})
        except (BrokenPipeError, ConnectionResetError):
            # 服务器在正文发送完毕前就拒绝（如 413），属预期行为
            pass
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        return resp.status, data

    def get_json(self, path):
        status, data = self.request("GET", path)
        return status, json.loads(data)


class TestPages(ServerTestCase):
    def test_index_page(self):
        status, data = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("XML".encode(), data)

    def test_static_assets(self):
        for path in ("/static/app.js", "/static/style.css"):
            status, _ = self.request("GET", path)
            self.assertEqual(status, 200, path)

    def test_static_path_traversal_rejected(self):
        status, _ = self.request("GET", "/static/../README.md")
        self.assertEqual(status, 404)


class TestSamplesApi(ServerTestCase):
    def test_sample_list(self):
        status, data = self.get_json("/api/samples")
        self.assertEqual(status, 200)
        names = data["samples"]
        for expected in ("normal_document.xml", "xxe_local_file.xml",
                         "billion_laughs.xml", "deep_nesting.xml"):
            self.assertIn(expected, names)

    def test_fetch_sample(self):
        status, data = self.request("GET", "/api/samples/normal_document.xml")
        self.assertEqual(status, 200)
        self.assertIn(b"<catalog", data)

    def test_sample_path_traversal_rejected(self):
        for path in ("/api/samples/../README.md",
                     "/api/samples/..%2F..%2Fetc%2Fpasswd",
                     "/api/samples/no_such_file.xml"):
            status, _ = self.request("GET", path)
            self.assertEqual(status, 404, path)


class TestInspectApi(ServerTestCase):
    def post_xml(self, xml):
        body = json.dumps({"xml": xml}).encode("utf-8")
        status, data = self.request(
            "POST", "/api/inspect", body=body,
            headers={"Content-Type": "application/json"},
        )
        return status, json.loads(data)

    def test_inspect_normal(self):
        status, result = self.post_xml("<root a='1'>hello</root>")
        self.assertEqual(status, 200)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["stats"]["elements"], 1)

    def test_inspect_xxe(self):
        xml = ('<!DOCTYPE r [ <!ENTITY x SYSTEM "file:///etc/passwd"> ]>'
               "<r>&x;</r>")
        status, result = self.post_xml(xml)
        self.assertEqual(status, 200)
        self.assertEqual(result["status"], "blocked")
        self.assertNotIn("root:", json.dumps(result))

    def test_inspect_malformed(self):
        _, result = self.post_xml("<a><b></a>")
        self.assertEqual(result["status"], "error")

    def test_invalid_body_rejected(self):
        status, _ = self.request(
            "POST", "/api/inspect", body=b"not json",
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 400)

    def test_oversized_body_rejected(self):
        body = b'{"xml": "' + b"a" * (600 * 1024) + b'"}'
        status, _ = self.request(
            "POST", "/api/inspect", body=body,
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 413)

    def test_unknown_route_404(self):
        status, _ = self.request("GET", "/api/unknown")
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
