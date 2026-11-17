"""HTTP-level tests for the web UI: login, org scoping, export and verify."""

from __future__ import annotations

import http.cookiejar
import json
import re
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from app.demo import ORG_ALPHA, ORG_BETA, PASSWORD, build_records, run_demo, seed
from app.store import Store
from app.web import App, serve


class WebCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.store = Store(self.root / "gsb2.db", self.root / "audit-baseline.db")
        self.store.initialize()
        seed(self.store)
        build_records(self.store)
        self.copies = self.root / "exports"
        run_demo(self.store, self.copies)
        from app.report import build_bundle, write_bundle

        write_bundle(
            build_bundle(self.store, ORG_BETA, exported_by="yi"),
            self.copies / "org-beta-full.json",
        )

        self.app = App(self.store, copies_dir=self.copies)
        self.server = serve(self.app, "127.0.0.1", 0)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self._tmp.cleanup()

    # -- helpers -------------------------------------------------------------

    def opener(self) -> urllib.request.OpenerDirector:
        jar = http.cookiejar.CookieJar()
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def get(self, opener, path: str) -> str:
        with opener.open(self.base() + path, timeout=10) as response:
            return response.read().decode("utf-8")

    def login(self, username: str) -> urllib.request.OpenerDirector:
        opener = self.opener()
        data = urllib.parse.urlencode(
            {"username": username, "password": PASSWORD}
        ).encode()
        with opener.open(self.base() + "/login", data=data, timeout=10) as response:
            return opener

    def csrf(self, opener, path: str) -> str:
        html = self.get(opener, path)
        match = re.search(r'name="csrf" value="([^"]+)"', html)
        self.assertIsNotNone(match, "页面中应包含 CSRF 令牌")
        return match.group(1)

    def post_form(self, opener, path: str, data: dict[str, str]) -> str:
        with opener.open(
            self.base() + path, data=urllib.parse.urlencode(data).encode(), timeout=10
        ) as response:
            return response.read().decode("utf-8")

    def post_file(self, opener, path: str, fields: dict[str, str], filename: str, payload: bytes) -> str:
        boundary = "----gsb2test"
        chunks: list[bytes] = []
        for key, value in fields.items():
            chunks.append(
                (
                    f"--{boundary}\r\n"
                    f'Content-Disposition: form-data; name="{key}"\r\n\r\n'
                    f"{value}\r\n"
                ).encode()
            )
        chunks.append(
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="copy"; filename="{filename}"\r\n'
                "Content-Type: application/json\r\n\r\n"
            ).encode()
            + payload
            + b"\r\n"
        )
        chunks.append(f"--{boundary}--\r\n".encode())
        request = urllib.request.Request(
            self.base() + path,
            data=b"".join(chunks),
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        with opener.open(request, timeout=10) as response:
            return response.read().decode("utf-8")

    # -- tests ---------------------------------------------------------------

    def test_login_required(self) -> None:
        opener = self.opener()
        with opener.open(self.base() + "/roles", timeout=10) as response:
            body = response.read().decode("utf-8")
        self.assertIn("登录", body)

    def test_audit_page_scoped_to_own_org(self) -> None:
        jia = self.login("jia")
        html = self.get(jia, "/audit")
        self.assertIn("甲公司", html)
        self.assertIn("user-1001", html)
        self.assertNotIn("user-2001", html)
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.get(jia, "/audit?org=" + ORG_BETA)
        self.assertEqual(ctx.exception.code, 403)

    def test_audit_page_has_no_edit_controls(self) -> None:
        jia = self.login("jia")
        html = self.get(jia, "/audit")
        for forbidden in (
            "/audit/delete",
            "/audit/edit",
            "编辑记录",
            "删除记录",
            "method=\"post\" action=\"/audit",
        ):
            self.assertNotIn(forbidden, html)
        self.assertIn("不可编辑或删除", html)

    def test_cross_org_export_denied(self) -> None:
        jia = self.login("jia")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.get(jia, "/audit/export?org=" + ORG_BETA)
        self.assertEqual(ctx.exception.code, 403)

    def test_export_and_verify_full_copy(self) -> None:
        jia = self.login("jia")
        with jia.open(self.base() + "/audit/export?org=" + ORG_ALPHA, timeout=10) as response:
            self.assertIn("application/json", response.headers["Content-Type"])
            bundle = json.loads(response.read().decode("utf-8"))
        self.assertEqual([r["seq"] for r in bundle["records"]], [1, 2, 3])

        csrf = self.csrf(jia, "/verify")
        page = self.post_file(
            jia,
            "/verify",
            {"csrf": csrf},
            "full.json",
            json.dumps(bundle).encode("utf-8"),
        )
        self.assertIn("顺序与内容一致", page)
        self.assertIn("本次校验以只读方式", page)

    def test_verify_truncated_copy_reports_missing_segment(self) -> None:
        jia = self.login("jia")
        tail = json.loads((self.copies / "org-alpha-tail-only.json").read_text("utf-8"))
        csrf = self.csrf(jia, "/verify")
        page = self.post_file(
            jia, "/verify", {"csrf": csrf}, "tail.json", json.dumps(tail).encode("utf-8")
        )
        self.assertIn("覆盖不完整", page)
        self.assertIn("缺少", page)
        self.assertIn("seq 1", page)

    def test_local_copy_selection_works(self) -> None:
        jia = self.login("jia")
        csrf = self.csrf(jia, "/verify")
        page = self.post_form(
            jia,
            "/verify",
            {"csrf": csrf, "source": "local:org-alpha-full.json"},
        )
        self.assertIn("顺序与内容一致", page)

    def test_cross_org_local_copy_hidden(self) -> None:
        jia = self.login("jia")
        html = self.get(jia, "/verify")
        self.assertNotIn("org-beta", html)

    def test_role_change_requires_csrf(self) -> None:
        jia = self.login("jia")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.post_form(
                jia,
                "/roles/grant",
                {"org": ORG_ALPHA, "subject": "user-9", "role": "viewer"},
            )
        self.assertEqual(ctx.exception.code, 403)
        self.assertEqual(len(self.store.list_audit(ORG_ALPHA)), 3)

    def test_grant_through_ui_writes_audit(self) -> None:
        jia = self.login("jia")
        csrf = self.csrf(jia, "/roles")
        self.post_form(
            jia,
            "/roles/grant",
            {
                "csrf": csrf,
                "org": ORG_ALPHA,
                "subject": "user-1010",
                "role": "viewer",
                "reason": "新成员",
            },
        )
        records = self.store.list_audit(ORG_ALPHA)
        self.assertEqual(len(records), 4)
        self.assertEqual(records[-1]["target"], "user-1010")
        self.assertEqual(records[-1]["outcome"], "success")

    def test_failed_grant_through_ui_is_audited(self) -> None:
        jia = self.login("jia")
        csrf = self.csrf(jia, "/roles")
        self.post_form(
            jia,
            "/roles/grant",
            {
                "csrf": csrf,
                "org": ORG_ALPHA,
                "subject": "admin-jia",
                "role": "org_admin",
            },
        )
        records = self.store.list_audit(ORG_ALPHA)
        self.assertEqual(len(records), 4)
        self.assertEqual(records[-1]["outcome"], "failure")

    def test_audit_page_still_shows_all_three_after_verification(self) -> None:
        jia = self.login("jia")
        csrf = self.csrf(jia, "/verify")
        self.post_form(
            jia, "/verify", {"csrf": csrf, "source": "local:org-alpha-tail-only.json"}
        )
        html = self.get(jia, "/audit")
        for target in ("user-1001", "admin-jia"):
            self.assertIn(target, html)
        self.assertIn("共 3 条", html)


if __name__ == "__main__":
    unittest.main()
