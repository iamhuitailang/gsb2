"""End-to-end tests against the real HTTP server (localhost only)."""

from __future__ import annotations

import json
import os
import threading
import unittest
import urllib.error
import urllib.request

from tests.support import WorkbenchTestCase
from workbench.server import make_server


def request(base, path, method="GET", body=None, headers=None):
    data = None
    headers = dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            payload = response.read()
            content_type = response.headers.get("Content-Type", "")
            if "application/json" in content_type:
                return response.status, json.loads(payload)
            return response.status, payload.decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, raw.decode("utf-8", "replace")


class ServerTests(WorkbenchTestCase):
    def setUp(self):
        super().setUp()
        self.server = make_server(self.workbench, "127.0.0.1", 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.server.server_address[:2]
        self.base = "http://%s:%s" % (host, port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        super().tearDown()

    def test_index_and_static_are_served(self):
        status, body = request(self.base, "/")
        self.assertEqual(status, 200)
        self.assertIn("本地源码安全审查", body)
        status, _ = request(self.base, "/app.js")
        self.assertEqual(status, 200)

    def test_static_traversal_rejected(self):
        status, _ = request(self.base, "/../workbench/core.py")
        self.assertEqual(status, 404)

    def test_mutation_requires_csrf_header(self):
        root = self.make_project({"x.env": "hello"})
        status, payload = request(self.base, "/api/scans", "POST", {"root": root}, {"Content-Type": "application/json"})
        self.assertEqual(status, 403)
        self.assertEqual(payload["error"]["code"], "missing_request_header")

    def test_full_scan_flow_over_http(self):
        root = self.make_project(
            {"src/creds.env": 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"\n'}
        )
        status, payload = request(
            self.base,
            "/api/scans",
            "POST",
            {"root": root},
            {"X-Workbench-Request": "1", "Content-Type": "application/json"},
        )
        self.assertEqual(status, 201, payload)
        scan_id = payload["scan"]["id"]
        scan = self.workbench.wait_for_scan(scan_id, timeout=60)
        self.assertEqual(scan["status"], "completed")

        status, payload = request(self.base, "/api/scans/%s/findings" % scan_id)
        self.assertEqual(status, 200)
        self.assertEqual(len(payload["items"]), 1)
        finding = payload["items"][0]
        self.assertNotIn("wJalrXUtnFEMI", json.dumps(finding))

        status, payload = request(
            self.base,
            "/api/findings/%s/review" % finding["id"],
            "POST",
            {"decision": "accept", "reason": "确认", "expected_fingerprint": finding["fingerprint"]},
            {"X-Workbench-Request": "1", "Content-Type": "application/json"},
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["finding"]["review_state"], "accepted")

        status, report = request(self.base, "/api/scans/%s/report?format=json" % scan_id)
        self.assertEqual(status, 200)
        self.assertNotIn("wJalrXUtnFEMI", report)

    def test_host_header_is_enforced(self):
        req = urllib.request.Request(self.base + "/api/health", headers={"Host": "evil.example"})
        try:
            urllib.request.urlopen(req, timeout=10)
            self.fail("expected rejection")
        except urllib.error.HTTPError as exc:
            self.assertEqual(exc.code, 403)

    def test_rules_validate_endpoint(self):
        status, payload = request(
            self.base,
            "/api/rules/validate",
            "POST",
            {"text": "{\"rules\": []}"},
            {"X-Workbench-Request": "1", "Content-Type": "application/json"},
        )
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "rules_invalid")

    def test_rules_put_endpoint_requires_valid_json(self):
        status, payload = request(
            self.base,
            "/api/rules",
            "PUT",
            {"text": "{not json"},
            {"X-Workbench-Request": "1", "Content-Type": "application/json"},
        )
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "rules_invalid")

    def test_read_endpoints_do_not_require_header(self):
        status, payload = request(self.base, "/api/config")
        self.assertEqual(status, 200)
        self.assertIn("severities", payload)
        status, payload = request(self.base, "/api/rules")
        self.assertEqual(status, 200)
        self.assertIn("rules", payload["snapshot"])

    def test_cannot_scan_workbench_data_dir(self):
        status, payload = request(
            self.base,
            "/api/scans",
            "POST",
            {"root": self.workbench.data_dir},
            {"X-Workbench-Request": "1", "Content-Type": "application/json"},
        )
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "root_overlaps_data")


if __name__ == "__main__":
    unittest.main()
