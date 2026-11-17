"""端到端 + 服务层测试。

并发场景通过真实的 ThreadingHTTPServer + 两个独立 Cookie 会话复现：
两名管理员几乎同时点击“退出机构”，验证 BEGIN IMMEDIATE 事务保证
恰好一人退出、另一人被拦截且仍能打开管理页。
"""

from __future__ import annotations

import http.cookiejar
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from app import db, service
from app.server import create_server

ORG_A = 1  # 甲方机构：jia、yi 管理员，bing 普通成员
ORG_B = 2  # 乙方机构：ding 管理员，wu 普通成员


class ServerTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "test.db"
        db.init_db(self.db_path)
        self.httpd = create_server(host="127.0.0.1", port=0, db_path=self.db_path)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)
        self.tmp.cleanup()

    def opener(self) -> urllib.request.OpenerDirector:
        jar = http.cookiejar.CookieJar()
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def login(self, opener, username: str, password: str = "pass1234"):
        data = urllib.parse.urlencode(
            {"username": username, "password": password}
        ).encode()
        resp = opener.open(
            urllib.request.Request(f"http://127.0.0.1:{self.port}/login", data=data)
        )
        return resp.status, resp.geturl(), resp.read().decode("utf-8")

    def post(self, opener, path: str):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}", data=b"", method="POST"
        )
        try:
            resp = opener.open(req)
            return resp.status, resp.geturl(), resp.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            return exc.code, exc.geturl(), exc.read().decode("utf-8")

    def get(self, opener, path: str):
        resp = opener.open(f"http://127.0.0.1:{self.port}{path}")
        return resp.status, resp.geturl(), resp.read().decode("utf-8")

    def conn(self) -> sqlite3.Connection:
        return db.connect(self.db_path)

    def user_id(self, username: str) -> int:
        conn = self.conn()
        try:
            row = service.get_user_by_username(conn, username)
            return row["id"]
        finally:
            conn.close()

    def org_b_snapshot(self) -> list[tuple]:
        conn = self.conn()
        try:
            return [
                (r["username"], r["role"], r["is_active"])
                for r in conn.execute(
                    "SELECT u.username, m.role, m.is_active "
                    "FROM memberships m JOIN users u ON u.id = m.user_id "
                    "WHERE m.org_id = ? ORDER BY u.username", (ORG_B,))
            ]
        finally:
            conn.close()


class ConcurrentLeaveTests(ServerTestBase):
    """需求主场景：甲乙同时退出，只走一个；留下的人升丙为管理员后再退出。"""

    def test_concurrent_leave_only_one_succeeds_then_promote_and_leave(self):
        jia = self.opener()
        yi = self.opener()
        self.login(jia, "jia")
        self.login(yi, "yi")

        org_b_before = self.org_b_snapshot()
        barrier = threading.Barrier(2)
        results: dict[str, tuple] = {}

        def leave(opener, name):
            barrier.wait()  # 两个请求尽量同时发出
            results[name] = self.post(opener, f"/orgs/{ORG_A}/leave")

        t1 = threading.Thread(target=leave, args=(jia, "jia"))
        t2 = threading.Thread(target=leave, args=(yi, "yi"))
        t1.start(); t2.start()
        t1.join(timeout=30); t2.join(timeout=30)

        statuses = {name: r[0] for name, r in results.items()}
        self.assertEqual(set(statuses.values()), {200})  # 均走完重定向，无 500

        # 恰好一人成功（回到机构列表页），另一人被拦截（停留在机构管理页）
        homes = [name for name, (_, url, _) in results.items()
                 if urllib.parse.urlparse(url).path == "/"]
        blocked = [name for name, (_, url, _) in results.items()
                   if f"/orgs/{ORG_A}" in urllib.parse.urlparse(url).path]
        self.assertEqual(len(homes), 1, results)
        self.assertEqual(len(blocked), 1, results)

        blocked_name = blocked[0]
        blocked_body = results[blocked_name][2]
        self.assertIn("没有任何可登录的有效管理员", blocked_body)

        # 被拦截的人仍是管理员，仍能打开管理页
        survivor = jia if blocked_name == "jia" else yi
        status, url, body = self.get(survivor, f"/orgs/{ORG_A}")
        self.assertEqual(status, 200)
        self.assertIn("成员管理", body)

        # 机构 A 此时只剩一名有效管理员
        conn = self.conn()
        try:
            self.assertEqual(service.count_active_admins(conn, ORG_A), 1)
        finally:
            conn.close()

        # 留下的人把普通成员丙升为管理员
        bing_id = self.user_id("bing")
        status, url, body = self.post(
            survivor, f"/orgs/{ORG_A}/members/{bing_id}/promote")
        self.assertEqual(status, 200)
        self.assertIn("角色由普通成员调整为管理员", body)

        # 之后留下的人自己退出即可成功
        status, url, body = self.post(survivor, f"/orgs/{ORG_A}/leave")
        self.assertEqual(status, 200)
        self.assertNotIn(f"/orgs/{ORG_A}", url)
        self.assertIn("退出机构，其成员关系已移除", body)

        # 最终机构 A 只剩丙，且是有效管理员
        conn = self.conn()
        try:
            members = service.list_members(conn, ORG_A)
            self.assertEqual([(m["username"], m["role"], m["is_active"]) for m in members],
                             [("bing", "admin", 1)])
            self.assertEqual(service.count_active_admins(conn, ORG_A), 1)

            # 审计：有一次被拦截的退出、两次成功退出、一次升级，详情都落库
            logs = service.list_audit_logs(conn, ORG_A)
            blocked_logs = [l for l in logs if l["result"] == "blocked"]
            self.assertEqual(len(blocked_logs), 1)
            self.assertEqual(blocked_logs[0]["action"], "leave")
            self.assertIn("没有任何可登录的有效管理员", blocked_logs[0]["detail"])
            successes = sorted(l["action"] for l in logs if l["result"] == "success")
            self.assertEqual(successes, ["leave", "leave", "promote"])
        finally:
            conn.close()

        # 另一个机构的管理名单保持原样
        self.assertEqual(self.org_b_snapshot(), org_b_before)
        self.assertEqual(
            self.org_b_snapshot(),
            [("ding", "admin", 1), ("wu", "member", 1)],
        )


class ServiceGuardTests(ServerTestBase):
    """服务层：降级/停用/移除的最后管理员保护与停用不计入规则。"""

    def setUp(self):
        super().setUp()
        conn = self.conn()
        try:
            self.jia = service.get_user_by_username(conn, "jia")["id"]
            self.yi = service.get_user_by_username(conn, "yi")["id"]
            self.bing = service.get_user_by_username(conn, "bing")["id"]
        finally:
            conn.close()

    def test_demote_sole_admin_blocked(self):
        # 先把乙降为普通成员（此时还剩甲一个管理员，允许）
        ok = service.set_role(self.db_path, ORG_A, self.jia, self.yi, "member")
        self.assertTrue(ok.ok)
        blocked = service.set_role(self.db_path, ORG_A, self.jia, self.jia, "member")
        self.assertFalse(blocked.ok)
        self.assertIn("没有任何可登录的有效管理员", blocked.message)
        conn = self.conn()
        try:
            self.assertEqual(service.count_active_admins(conn, ORG_A), 1)
        finally:
            conn.close()

    def test_disable_sole_admin_blocked_and_disabled_not_counted(self):
        # 停用乙：允许，停用后有效管理员只剩甲（乙虽仍是 admin 角色但不计入）
        ok = service.set_active(self.db_path, ORG_A, self.jia, self.yi, False)
        self.assertTrue(ok.ok)
        conn = self.conn()
        try:
            self.assertEqual(service.count_active_admins(conn, ORG_A), 1)
            yi_m = service.get_membership(conn, ORG_A, self.yi)
            self.assertEqual(yi_m["role"], "admin")  # 角色还在，只是停用
            self.assertEqual(yi_m["is_active"], 0)
        finally:
            conn.close()
        # 甲再停用自己必须被拦截
        blocked = service.set_active(self.db_path, ORG_A, self.jia, self.jia, False)
        self.assertFalse(blocked.ok)
        self.assertIn("停用的账号不计入", blocked.message)

    def test_remove_sole_admin_blocked(self):
        service.set_role(self.db_path, ORG_A, self.jia, self.yi, "member")
        blocked = service.remove_member(self.db_path, ORG_A, self.jia, self.jia)
        self.assertFalse(blocked.ok)
        self.assertIn("没有任何可登录的有效管理员", blocked.message)

    def test_two_admins_one_can_be_removed(self):
        ok = service.remove_member(self.db_path, ORG_A, self.jia, self.yi)
        self.assertTrue(ok.ok)
        conn = self.conn()
        try:
            self.assertEqual(service.count_active_admins(conn, ORG_A), 1)
            self.assertIsNone(service.get_membership(conn, ORG_A, self.yi))
        finally:
            conn.close()

    def test_non_admin_cannot_manage(self):
        with self.assertRaises(service.ServiceError):
            service.set_role(self.db_path, ORG_A, self.bing, self.jia, "member")
        with self.assertRaises(service.ServiceError):
            service.leave_org(self.db_path, ORG_A, self.bing)

    def test_blocked_and_success_both_audited_with_changes(self):
        service.set_role(self.db_path, ORG_A, self.jia, self.yi, "member")
        service.set_role(self.db_path, ORG_A, self.jia, self.jia, "member")  # blocked
        service.set_role(self.db_path, ORG_A, self.jia, self.bing, "admin")  # success
        conn = self.conn()
        try:
            logs = service.list_audit_logs(conn, ORG_A)
        finally:
            conn.close()
        blocked = [l for l in logs if l["result"] == "blocked"]
        self.assertEqual(len(blocked), 1)
        self.assertIn("未执行任何变更", blocked[0]["detail"])
        promoted = [l for l in logs if l["action"] == "promote" and l["result"] == "success"]
        self.assertEqual(len(promoted), 1)
        self.assertIn("丙", promoted[0]["detail"])

    def test_disabled_admin_cannot_operate(self):
        # 甲停用乙（允许，剩甲一名有效管理员）；乙虽仍是 admin 角色但已停用
        service.set_active(self.db_path, ORG_A, self.jia, self.yi, False)
        with self.assertRaises(service.ServiceError) as ctx:
            service.set_role(self.db_path, ORG_A, self.yi, self.bing, "admin")
        self.assertIn("已在本机构停用", str(ctx.exception))
        with self.assertRaises(service.ServiceError):
            service.leave_org(self.db_path, ORG_A, self.yi)
        # 丙没有被升级，数据未变
        conn = self.conn()
        try:
            self.assertEqual(
                service.get_membership(conn, ORG_A, self.bing)["role"], "member")
        finally:
            conn.close()

    def test_other_org_unchanged_after_org_a_changes(self):
        before = self.org_b_snapshot()
        service.set_active(self.db_path, ORG_A, self.jia, self.yi, False)
        service.set_active(self.db_path, ORG_A, self.jia, self.yi, True)
        service.remove_member(self.db_path, ORG_A, self.jia, self.bing)
        self.assertEqual(self.org_b_snapshot(), before)


class AuthTests(ServerTestBase):
    def test_login_wrong_password(self):
        opener = self.opener()
        status, url, body = self.login_with(opener, "jia", "wrong")
        self.assertIn("/login", url)
        self.assertIn("用户名或密码不正确", body)

    def login_with(self, opener, username, password):
        data = urllib.parse.urlencode(
            {"username": username, "password": password}
        ).encode()
        try:
            resp = opener.open(urllib.request.Request(
                f"http://127.0.0.1:{self.port}/login", data=data))
            return resp.status, resp.geturl(), resp.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            return exc.code, exc.geturl(), exc.read().decode("utf-8")

    def test_login_success_and_view_page(self):
        opener = self.opener()
        status, url, _ = self.login(opener, "jia")
        self.assertEqual(url, f"http://127.0.0.1:{self.port}/")
        status, _, body = self.get(opener, f"/orgs/{ORG_A}")
        self.assertEqual(status, 200)
        self.assertIn("甲方机构", body)


if __name__ == "__main__":
    unittest.main(verbosity=2)
