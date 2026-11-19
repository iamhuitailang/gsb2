"""HTTP API 冒烟测试：启动真实本机服务，覆盖导入、告警、处置、导出全链路。"""
from __future__ import annotations

import json
import os
import threading
import unittest
import urllib.request
import uuid
from urllib.error import HTTPError

from secbench import server, storage

from helpers import TempDB


def http_get(url: str):
    with urllib.request.urlopen(url, timeout=10) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def http_post_json(url: str, payload: dict):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))


def multipart_body(filename: str, content: bytes) -> tuple[bytes, str]:
    boundary = f"----secbench{uuid.uuid4().hex}"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        "Content-Type: application/x-ndjson\r\n\r\n"
    ).encode() + content + f"\r\n--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


class ApiSmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.db = TempDB()
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.db.close()

    def test_01_full_flow(self) -> None:
        status, health = http_get(f"{self.base}/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(health["ok"])

        samples = os.path.join(os.path.dirname(__file__), "..", "samples")
        for name in ("sample_auth.jsonl", "sample_proxy.jsonl", "sample_endpoint.jsonl"):
            with open(os.path.join(samples, name), "rb") as fh:
                body, ctype = multipart_body(name, fh.read())
            req = urllib.request.Request(
                f"{self.base}/api/import", data=body,
                headers={"Content-Type": ctype}, method="POST",
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read().decode("utf-8"))
            self.assertGreater(result["counts"]["accepted"], 0)

        _, data = http_get(f"{self.base}/api/alerts")
        rule_ids = {a["rule_id"] for a in data["alerts"]}
        self.assertEqual(rule_ids, {"R1_BRUTE_FORCE", "R2_PROBE_THEN_ACCESS", "R3_CROSS_IP_EXPORT"})

        alert_id = data["alerts"][0]["id"]
        _, ev = http_get(f"{self.base}/api/alerts/{alert_id}/evidence")
        self.assertGreater(len(ev["evidence"]), 1)

        status, _ = http_post_json(
            f"{self.base}/api/alerts/{alert_id}/status",
            {"status": "confirmed", "disposition_note": "API 处置"},
        )
        self.assertEqual(status, 200)
        _, filtered = http_get(f"{self.base}/api/alerts?status=confirmed")
        self.assertTrue(all(a["status"] == "confirmed" for a in filtered["alerts"]))

        with urllib.request.urlopen(f"{self.base}/api/export?format=json", timeout=10) as resp:
            exported = json.loads(resp.read().decode("utf-8"))
        self.assertEqual(exported["engine_rule_version"], storage.RULE_VERSION)
        self.assertGreater(exported["alert_count"], 0)

    def test_02_messy_import_counters(self) -> None:
        samples = os.path.join(os.path.dirname(__file__), "..", "samples")
        with open(os.path.join(samples, "sample_messy.jsonl"), "rb") as fh:
            body, ctype = multipart_body("sample_messy.jsonl", fh.read())
        req = urllib.request.Request(
            f"{self.base}/api/import", data=body,
            headers={"Content-Type": ctype}, method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode("utf-8"))
        c = result["counts"]
        self.assertEqual(c["duplicate"], 1)    # AUTH-1003 与已入库记录完全相同
        self.assertEqual(c["quarantined"], 2)  # AUTH-1005 内容冲突；AUTH-1002 时间格式不同导致指纹不同
        self.assertEqual(c["error"], 4)        # 坏 JSON / 坏时间 / 未知来源 / 缺字段
        self.assertEqual(c["accepted"], 0)

    def test_03_late_event_keeps_disposition(self) -> None:
        _, alerts = http_get(f"{self.base}/api/alerts")
        r3 = next(a for a in alerts["alerts"] if a["rule_id"] == "R3_CROSS_IP_EXPORT")
        http_post_json(
            f"{self.base}/api/alerts/{r3['id']}/status",
            {"status": "false_positive", "disposition_note": "先标记误报"},
        )
        samples = os.path.join(os.path.dirname(__file__), "..", "samples")
        with open(os.path.join(samples, "sample_late.jsonl"), "rb") as fh:
            body, ctype = multipart_body("sample_late.jsonl", fh.read())
        req = urllib.request.Request(
            f"{self.base}/api/import", data=body,
            headers={"Content-Type": ctype}, method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            json.loads(resp.read().decode("utf-8"))
        _, refreshed = http_get(f"{self.base}/api/alerts")
        r3_after = next(a for a in refreshed["alerts"] if a["id"] == r3["id"])
        self.assertEqual(r3_after["status"], "false_positive")  # 处置保留
        _, ev = http_get(f"{self.base}/api/alerts/{r3['id']}/evidence")
        event_ids = {e["event_id"] for e in ev["evidence"]}
        self.assertIn("EP-3003", event_ids)                     # 迟到证据补齐

    def test_04_oversized_rejected_with_413(self) -> None:
        _, settings = http_get(f"{self.base}/api/settings")
        tiny = {"max_import_bytes": 50}
        http_post_json(f"{self.base}/api/settings", tiny)
        try:
            body, ctype = multipart_body("big.jsonl", b'{"x":1}\n' * 100)
            req = urllib.request.Request(
                f"{self.base}/api/import", data=body,
                headers={"Content-Type": ctype}, method="POST",
            )
            with self.assertRaises(HTTPError) as ctx:
                urllib.request.urlopen(req, timeout=10)
            self.assertEqual(ctx.exception.code, 413)
        finally:
            http_post_json(f"{self.base}/api/settings",
                           {"max_import_bytes": settings["max_import_bytes"]})

    def test_05_static_index_served(self) -> None:
        with urllib.request.urlopen(f"{self.base}/", timeout=10) as resp:
            html = resp.read().decode("utf-8")
        self.assertIn("secbench", html)

    def test_06_single_event_endpoint_and_missing_404(self) -> None:
        status, ev = http_get(f"{self.base}/api/events/1")
        self.assertEqual(status, 200)
        self.assertEqual(ev["event_id"], "AUTH-1001")
        self.assertIn("raw_line", ev)
        try:
            urllib.request.urlopen(f"{self.base}/api/events/99999", timeout=10)
            self.fail("应返回 404")
        except HTTPError as exc:
            self.assertEqual(exc.code, 404)


if __name__ == "__main__":
    unittest.main()
