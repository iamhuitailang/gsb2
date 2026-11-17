"""HTTP-level integration tests for the local workbench."""

from __future__ import annotations

import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from workbench import db as dbm
from workbench.server import serve


class ServerTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.db_path = root / "workbench.db"
        cls.secret_path = root / "secret.bin"
        cls.httpd = serve(cls.db_path, cls.secret_path, "127.0.0.1", 0, quiet=True)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.httpd.server_address[1]

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=5)
        cls.tmp.cleanup()

    def setUp(self) -> None:
        dbm.reset_db(self.db_path)
        self.cookie = ""
        self.csrf = ""

    def request(self, method: str, path: str, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"Content-Type": "application/json"}
        if self.cookie:
            headers["Cookie"] = self.cookie
        if self.csrf:
            headers["X-CSRF-Token"] = self.csrf
        payload = None
        if method == "POST":
            payload = json.dumps(body or {}, ensure_ascii=False).encode("utf-8")
        conn.request(method, path, body=payload, headers=headers)
        response = conn.getresponse()
        raw = response.read()
        set_cookie = response.getheader("Set-Cookie")
        if set_cookie:
            self.cookie = set_cookie.split(";", 1)[0]
        conn.close()
        data = json.loads(raw.decode("utf-8")) if raw else {}
        return response.status, data

    def login(self):
        status, data = self.request(
            "POST",
            "/api/login",
            {"username": dbm.DEFAULT_USERNAME, "password": dbm.DEFAULT_PASSWORD},
        )
        self.assertEqual(status, 200, data)
        self.csrf = data["csrf"]
        return data

    def folder_ids(self):
        status, data = self.request("GET", "/api/state")
        self.assertEqual(status, 200, data)
        return {folder["name"]: folder["id"] for folder in data["folders"]}

    def test_unauthenticated_requests_are_rejected(self):
        status, data = self.request("GET", "/api/state")
        self.assertEqual(status, 401)
        self.assertEqual(data["error"], "unauthorized")

    def test_mutation_requires_csrf(self):
        self.login()
        csrf, self.csrf = self.csrf, ""
        status, data = self.request("POST", "/api/scope", {"folder_id": 1})
        self.assertEqual(status, 403)
        self.assertEqual(data["error"], "csrf_rejected")
        self.csrf = csrf

    def test_full_flow_across_folders(self):
        self.login()
        folders = self.folder_ids()
        jia = folders["甲目录"]
        yi = folders["乙目录"]

        status, manifest = self.request(
            "POST", "/api/scope", {"folder_id": jia, "batch": "", "keyword": ""}
        )
        self.assertEqual(status, 200, manifest)
        self.assertEqual(manifest["count"], 2)

        status, permit = self.request(
            "POST",
            "/api/confirm",
            {
                "folder_id": jia,
                "batch": "",
                "keyword": "",
                "digest": manifest["digest"],
                "password": dbm.DEFAULT_PASSWORD,
            },
        )
        self.assertEqual(status, 200, permit)

        # Switch to the other folder: the permit must not be accepted there.
        self.request("POST", "/api/scope", {"folder_id": yi})
        status, data = self.request(
            "POST", "/api/submit", {"permit": permit["permit"]}
        )
        self.assertEqual(status, 409)
        self.assertEqual(data["error"], "scope_changed")

        status, state = self.request("GET", "/api/state")
        self.assertEqual(state["manifest"]["count"], 1)

        # Back to the confirmed scope: the untouched record set is still there.
        self.request("POST", "/api/scope", {"folder_id": jia})
        status, done = self.request(
            "POST", "/api/submit", {"permit": permit["permit"]}
        )
        self.assertEqual(status, 200, done)
        self.assertEqual(done["operation"]["record_count"], 2)

        # A second submission reports that this operation is processed.
        status, again = self.request(
            "POST", "/api/submit", {"permit": permit["permit"]}
        )
        self.assertEqual(status, 409)
        self.assertEqual(again["error"], "already_processed")

        # 乙目录 still has its one record, 甲目录 is empty.
        self.request("POST", "/api/scope", {"folder_id": yi})
        status, yi_manifest = self.request("GET", "/api/preview")
        self.assertEqual(yi_manifest["count"], 1)

        # The cleanup page records the deleted list and the operator.
        status, history = self.request("GET", "/api/history")
        self.assertEqual(status, 200, history)
        self.assertEqual(len(history["operations"]), 1)
        entry = history["operations"][0]
        self.assertEqual(entry["record_count"], 2)
        self.assertEqual(entry["username"], dbm.DEFAULT_USERNAME)
        self.assertEqual(
            [record["title"] for record in entry["records"]],
            ["2026年第三季度采购合同（归档）", "2026年第三季度验收材料（归档）"],
        )

    def test_confirm_rejects_changed_filter(self):
        self.login()
        folders = self.folder_ids()
        jia = folders["甲目录"]
        status, manifest = self.request(
            "POST", "/api/scope", {"folder_id": jia}
        )
        self.assertEqual(status, 200)
        self.request(
            "POST", "/api/scope", {"folder_id": jia, "keyword": "采购"}
        )
        status, data = self.request(
            "POST",
            "/api/confirm",
            {
                "folder_id": jia,
                "batch": "",
                "keyword": "",
                "digest": manifest["digest"],
                "password": dbm.DEFAULT_PASSWORD,
            },
        )
        self.assertEqual(status, 409)
        self.assertEqual(data["error"], "scope_changed")
        self.assertEqual(data["manifest"]["count"], 1)


if __name__ == "__main__":
    unittest.main()
