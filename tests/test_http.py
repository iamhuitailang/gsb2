"""HTTP 层测试：走真实 socket，验证鉴权、CSRF 与题目场景端到端。"""

from __future__ import annotations

import json
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from ticket_system.db import init_db
from ticket_system.seed import seed_demo
from ticket_system.server import serve_in_thread


class HttpTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tmpdir.name) / "http.db")
        conn = init_db(self.db_path)
        self.ids = seed_demo(conn)
        conn.close()
        self.server, self.thread = serve_in_thread(self.db_path)
        host, port = self.server.server_address[:2]
        self.base = f"http://{host}:{port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.tmpdir.cleanup()

    def request(self, method, path, body=None, *, session=None, csrf=True):
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if session:
            req.add_header("X-Session-Token", session["token"])
            if csrf:
                req.add_header("X-CSRF-Token", session["csrf_token"])
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read().decode("utf-8"))

    def login(self, username, password="demo1234"):
        status, body = self.request(
            "POST", "/api/login", {"username": username, "password": password}
        )
        self.assertEqual(status, 200, body)
        return body


class HttpApiTest(HttpTestBase):
    def test_login_required(self) -> None:
        status, body = self.request("GET", "/api/tickets")
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "not_authenticated")

    def test_csrf_required_for_batch(self) -> None:
        session = self.login("supervisor_a")
        status, body = self.request(
            "POST",
            "/api/close-batches/preview",
            {"ticket_ids": [self.ids["ticket_first"]]},
            session=session,
            csrf=False,
        )
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["code"], "invalid_csrf")

    def test_pagination_shape(self) -> None:
        session = self.login("supervisor_a")
        status, body = self.request(
            "GET", "/api/tickets?page=1&page_size=1", session=session
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["total"], 2)
        self.assertEqual(body["total_pages"], 2)
        self.assertEqual(len(body["items"]), 1)

    def test_full_scenario_over_http(self) -> None:
        supervisor = self.login("supervisor_a")
        admin = self.login("admin")
        first = self.ids["ticket_first"]
        second = self.ids["ticket_second"]
        foreign = self.ids["ticket_other_group"]

        status, preview = self.request(
            "POST",
            "/api/close-batches/preview",
            {"ticket_ids": [first, second, foreign]},
            session=supervisor,
        )
        self.assertEqual(status, 200)
        self.assertEqual(preview["closable_count"], 2)

        status, _ = self.request(
            "POST",
            f"/api/tickets/{second}/transfer",
            {"to_group_id": self.ids["group_b"]},
            session=admin,
        )
        self.assertEqual(status, 200)

        status, body = self.request(
            "POST",
            "/api/close-batches",
            {"ticket_ids": [first, second, foreign], "batch_key": "http-1"},
            session=supervisor,
        )
        self.assertEqual(status, 200)
        batch = body["batch"]
        self.assertEqual([item["ticket_id"] for item in batch["closed"]], [first])
        reasons = {i["ticket_id"]: i["reason"] for i in batch["unprocessed"]}
        self.assertEqual(reasons, {second: "no_permission", foreign: "no_permission"})
        # 组外条目不得携带标题或状态
        unprocessed_raw = json.dumps(batch["unprocessed"], ensure_ascii=False)
        self.assertNotIn("打印机", unprocessed_raw)
        self.assertNotIn('"status"', unprocessed_raw)

        # 重复提交同一批：结果一致且不新增关闭记录
        status, again = self.request(
            "POST",
            "/api/close-batches",
            {"ticket_ids": [first, second, foreign], "batch_key": "http-1"},
            session=supervisor,
        )
        self.assertEqual(status, 200)
        self.assertTrue(again["batch"]["replayed"])
        self.assertEqual(again["batch"]["closed"], batch["closed"])

    def test_supervisor_cannot_transfer(self) -> None:
        supervisor = self.login("supervisor_a")
        status, body = self.request(
            "POST",
            f"/api/tickets/{self.ids['ticket_second']}/transfer",
            {"to_group_id": self.ids["group_b"]},
            session=supervisor,
        )
        self.assertEqual(status, 403)

    def test_cannot_read_foreign_batch(self) -> None:
        a = self.login("supervisor_a")
        b = self.login("supervisor_b")
        status, body = self.request(
            "POST",
            "/api/close-batches",
            {"ticket_ids": [self.ids["ticket_first"]], "batch_key": "own"},
            session=a,
        )
        batch_id = body["batch"]["batch_id"]
        status, _ = self.request(
            "GET", f"/api/close-batches/{batch_id}", session=b
        )
        self.assertEqual(status, 404)

    def test_static_index_served(self) -> None:
        with urllib.request.urlopen(self.base + "/", timeout=5) as resp:
            html = resp.read().decode("utf-8")
        self.assertIn("批量关闭", html)


if __name__ == "__main__":
    unittest.main()
