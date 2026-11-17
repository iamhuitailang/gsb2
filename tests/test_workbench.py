"""End-to-end tests for the archive-purge workbench domain logic."""

from __future__ import annotations

import tempfile
import threading
import unittest
from pathlib import Path

from workbench import db as dbm
from workbench.service import (
    AlreadyProcessed,
    BadCredentials,
    Expired,
    Forbidden,
    ScopeChanged,
    ScopeDrift,
    Unauthorized,
    Workbench,
)

PASSWORD = dbm.DEFAULT_PASSWORD
USERNAME = dbm.DEFAULT_USERNAME


class Clock:
    def __init__(self, start: float = 1_000_000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class WorkbenchTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "workbench.db"
        self.clock = Clock()
        dbm.init_db(self.db_path, seed=True)
        self.wb = Workbench(
            self.db_path, b"test-secret", permit_ttl=180, clock=self.clock
        )
        self.raw, self.session, self.csrf = self.wb.login(USERNAME, PASSWORD)
        self.session = self.wb.session_for_token(self.raw)
        self.folders = {f["name"]: f["id"] for f in self.wb.folders()}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    # ----------------------------------------------------------------- helpers

    def scope(self, folder: str, batch: str = "", keyword: str = ""):
        manifest = self.wb.set_scope(
            self.session, self.folders[folder], batch, keyword
        )
        self.session = self.wb.session_for_token(self.raw)
        return manifest

    def confirm(self, manifest, password: str = PASSWORD):
        self.session = self.wb.session_for_token(self.raw)
        return self.wb.confirm(
            self.session,
            folder_id=manifest["folder_id"],
            batch=manifest["batch"],
            keyword=manifest["keyword"],
            expected_digest=manifest["digest"],
            password=password,
        )

    def submit(self, permit: str):
        self.session = self.wb.session_for_token(self.raw)
        return self.wb.submit(self.session, permit)

    def records(self, folder: str) -> list[dict]:
        conn = self.wb.connect()
        try:
            return [
                dict(r)
                for r in conn.execute(
                    "SELECT id, title, batch FROM records WHERE folder_id = ? ORDER BY id",
                    (self.folders[folder],),
                )
            ]
        finally:
            conn.close()


class ConfirmationFlowTests(WorkbenchTestCase):
    def test_seeded_fixture(self):
        self.assertEqual(len(self.records("甲目录")), 2)
        self.assertEqual(len(self.records("乙目录")), 1)

    def test_confirmation_shows_scope_and_count(self):
        manifest = self.scope("甲目录")
        self.assertEqual(manifest["count"], 2)
        self.assertEqual(manifest["folder_name"], "甲目录")
        self.assertEqual(
            [r["title"] for r in manifest["records"]],
            ["2026年第三季度采购合同（归档）", "2026年第三季度验收材料（归档）"],
        )
        result = self.confirm(manifest)
        self.assertTrue(result["permit"].startswith("wbp_"))
        self.assertEqual(result["manifest"]["count"], 2)

    def test_wrong_password_issues_no_permit(self):
        manifest = self.scope("甲目录")
        with self.assertRaises(BadCredentials):
            self.confirm(manifest, password="wrong-password")
        conn = self.wb.connect()
        try:
            self.assertEqual(
                conn.execute("SELECT COUNT(*) FROM permits").fetchone()[0], 0
            )
        finally:
            conn.close()
        self.assertEqual(len(self.records("甲目录")), 2)

    def test_confirmation_requires_matching_filter(self):
        manifest = self.scope("甲目录")
        other = self.scope("乙目录")
        with self.assertRaises(ScopeChanged):
            self.confirm(manifest)
        # The manifest returned by the error describes the new scope.
        result = self.confirm(other)
        self.assertEqual(result["manifest"]["count"], 1)

    def test_stale_digest_is_rejected(self):
        manifest = self.scope("甲目录")
        self.wb.add_record(self.folders["甲目录"], "新进资料", "2026-Q3")
        with self.assertRaises(ScopeChanged) as caught:
            self.confirm(manifest)
        self.assertEqual(caught.exception.manifest["count"], 3)

    def test_permit_expires(self):
        result = self.confirm(self.scope("甲目录"))
        self.clock.advance(181)
        with self.assertRaises(Expired):
            self.submit(result["permit"])
        self.assertEqual(len(self.records("甲目录")), 2)


class PermitScopingTests(WorkbenchTestCase):
    def test_permit_rejected_in_other_folder_then_usable_again(self):
        result = self.confirm(self.scope("甲目录"))
        permit = result["permit"]

        self.scope("乙目录")
        with self.assertRaises(ScopeChanged):
            self.submit(permit)
        self.assertEqual(len(self.records("乙目录")), 1)

        back = self.scope("甲目录")
        self.assertEqual(back["count"], 2)
        done = self.submit(permit)
        self.assertEqual(done["status"], "deleted")
        self.assertEqual(len(self.records("甲目录")), 0)
        self.assertEqual(len(self.records("乙目录")), 1)

    def test_permit_rejected_after_filter_change(self):
        result = self.confirm(self.scope("甲目录"))
        self.scope("甲目录", batch="2026-Q3", keyword="采购")
        with self.assertRaises(ScopeChanged):
            self.submit(result["permit"])

    def test_permit_bound_to_session(self):
        result = self.confirm(self.scope("甲目录"))
        other_token, _, _ = self.wb.login(USERNAME, PASSWORD)
        other_session = self.wb.session_for_token(other_token)
        with self.assertRaises(Forbidden):
            self.wb.submit(other_session, result["permit"])
        self.assertEqual(len(self.records("甲目录")), 2)

    def test_second_permit_for_same_operation_cannot_delete_twice(self):
        first = self.confirm(self.scope("甲目录"))
        second = self.confirm(self.scope("甲目录"))
        self.assertEqual(self.submit(second["permit"])["status"], "deleted")
        with self.assertRaises(AlreadyProcessed):
            self.submit(first["permit"])
        self.assertEqual(len(self.records("甲目录")), 0)

    def test_scope_drift_after_confirmation_requires_reconfirm(self):
        result = self.confirm(self.scope("甲目录"))
        self.wb.add_record(self.folders["甲目录"], "新进资料", "2026-Q3")

        with self.assertRaises(ScopeDrift) as caught:
            self.submit(result["permit"])
        self.assertEqual(caught.exception.manifest["count"], 3)
        self.assertEqual(len(self.records("甲目录")), 3)

        # This permit is revoked as soon as the list it was bound to changed,
        # so it can never be used for the old or the new set.
        with self.assertRaises(Forbidden):
            self.submit(result["permit"])

        fresh = self.confirm(self.scope("甲目录"))
        self.assertEqual(fresh["manifest"]["count"], 3)
        self.assertEqual(self.submit(fresh["permit"])["status"], "deleted")
        self.assertEqual(len(self.records("甲目录")), 0)


class RepeatSubmissionTests(WorkbenchTestCase):
    def test_second_submit_reports_already_processed(self):
        result = self.confirm(self.scope("甲目录"))
        self.submit(result["permit"])
        with self.assertRaises(AlreadyProcessed) as caught:
            self.submit(result["permit"])
        self.assertEqual(caught.exception.operation["record_count"], 2)
        self.assertEqual(len(self.records("乙目录")), 1)

    def test_reconfirm_after_completion_is_blocked(self):
        result = self.confirm(self.scope("甲目录"))
        self.submit(result["permit"])
        empty = self.scope("甲目录")
        self.assertEqual(empty["count"], 0)
        # With nothing left in scope there is nothing to confirm, and the API
        # offers no way to re-delete the already purged set.
        with self.assertRaises(ScopeChanged):
            self.confirm(empty)
        with self.assertRaises(AlreadyProcessed):
            self.submit(result["permit"])
        self.assertEqual(len(self.records("甲目录")), 0)

    def test_discarded_permit_cannot_be_submitted(self):
        result = self.confirm(self.scope("甲目录"))
        self.wb.discard_permit(self.session, result["permit"])
        with self.assertRaises(Forbidden):
            self.submit(result["permit"])
        self.assertEqual(len(self.records("甲目录")), 2)

    def test_discard_denied_for_other_session(self):
        result = self.confirm(self.scope("甲目录"))
        other_token, _, _ = self.wb.login(USERNAME, PASSWORD)
        other = self.wb.session_for_token(other_token)
        with self.assertRaises(Forbidden):
            self.wb.discard_permit(other, result["permit"])

    def test_concurrent_submits_delete_once(self):
        result = self.confirm(self.scope("甲目录"))
        permit = result["permit"]
        outcomes: list[str] = []
        barrier = threading.Barrier(4)
        lock = threading.Lock()

        def worker():
            session = self.wb.session_for_token(self.raw)
            barrier.wait()
            try:
                self.wb.submit(session, permit)
                outcome = "deleted"
            except (AlreadyProcessed, Forbidden) as exc:
                outcome = type(exc).__name__
            with lock:
                outcomes.append(outcome)

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(outcomes.count("deleted"), 1)
        self.assertEqual(len(outcomes), 4)
        self.assertEqual(len(self.records("甲目录")), 0)

    def test_concurrent_confirms_allow_only_one_deletion(self):
        manifest = self.scope("甲目录")
        permits: list[str] = []
        lock = threading.Lock()
        barrier = threading.Barrier(4)

        def worker():
            session = self.wb.session_for_token(self.raw)
            barrier.wait()
            try:
                result = self.wb.confirm(
                    session,
                    folder_id=manifest["folder_id"],
                    batch=manifest["batch"],
                    keyword=manifest["keyword"],
                    expected_digest=manifest["digest"],
                    password=PASSWORD,
                )
                with lock:
                    permits.append(result["permit"])
            except Exception as exc:  # pragma: no cover - diagnostic
                with lock:
                    permits.append(f"error:{type(exc).__name__}")

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        usable = [p for p in permits if p.startswith("wbp_")]
        self.assertTrue(usable, permits)
        outcomes: list[str] = []
        for permit in usable:
            session = self.wb.session_for_token(self.raw)
            try:
                self.wb.submit(session, permit)
                outcomes.append("deleted")
            except AlreadyProcessed:
                outcomes.append("already_processed")
            except (ScopeDrift, Forbidden) as exc:
                outcomes.append(type(exc).__name__)
        self.assertEqual(outcomes.count("deleted"), 1, outcomes)
        # Every surviving sibling permit must read as "already processed",
        # not as a list-changed error, because the same scope was cleaned.
        self.assertEqual(
            outcomes.count("already_processed"), len(outcomes) - 1, outcomes
        )
        self.assertEqual(len(self.records("甲目录")), 0)


class AuditAndHistoryTests(WorkbenchTestCase):
    def test_history_lists_records_and_operator(self):
        self.wb.add_record(self.folders["甲目录"], "第三条", "2026-Q3")
        manifest = self.scope("甲目录")
        result = self.confirm(manifest)
        self.submit(result["permit"])
        history = self.wb.cleanup_history()
        self.assertEqual(len(history), 1)
        entry = history[0]
        self.assertEqual(entry["username"], USERNAME)
        self.assertEqual(entry["completed_by"], USERNAME)
        self.assertEqual(entry["record_count"], 3)
        self.assertEqual(len(entry["records"]), 3)
        self.assertEqual(entry["folder_name"], "甲目录")
        self.assertTrue(entry["filter_label"].startswith("目录：甲目录"))

    def test_audit_log_contains_no_credentials(self):
        result = self.confirm(self.scope("甲目录"))
        permit = result["permit"]
        self.submit(permit)
        conn = self.wb.connect()
        try:
            rows = conn.execute("SELECT detail FROM audit_log").fetchall()
            blob = "\n".join(row["detail"] for row in rows)
            self.assertNotIn(permit, blob)
            self.assertNotIn(self.raw, blob)
            self.assertNotIn(PASSWORD, blob)
            permit_rows = conn.execute(
                "SELECT token_hash FROM permits"
            ).fetchall()
            self.assertTrue(
                all(permit not in row["token_hash"] for row in permit_rows)
            )
            session_rows = conn.execute(
                "SELECT token_hash FROM sessions"
            ).fetchall()
            self.assertTrue(
                all(self.raw not in row["token_hash"] for row in session_rows)
            )
        finally:
            conn.close()

    def test_audit_log_excerpt_for_operation(self):
        result = self.confirm(self.scope("甲目录"))
        self.submit(result["permit"])
        events = self.wb.audit_for_operation(result["operation_id"])
        actions = [event["action"] for event in events]
        self.assertIn("permit_issued", actions)
        self.assertIn("cleanup_completed", actions)


class SessionTests(WorkbenchTestCase):
    def test_logout_revokes_pending_permits(self):
        result = self.confirm(self.scope("甲目录"))
        self.wb.logout(self.session)
        self.assertIsNone(self.wb.session_for_token(self.raw))
        with self.assertRaises(Unauthorized):
            self.wb.submit(self.session, result["permit"])

    def test_csrf_is_session_bound(self):
        self.assertTrue(self.wb.verify_csrf(self.session, self.csrf))
        other_token, other, other_csrf = self.wb.login(USERNAME, PASSWORD)
        self.assertFalse(self.wb.verify_csrf(other, self.csrf))
        self.assertNotEqual(self.csrf, other_csrf)

    def test_password_hash_roundtrip(self):
        from workbench.security import hash_password, verify_password

        encoded = hash_password("example-password")
        self.assertTrue(verify_password("example-password", encoded))
        self.assertFalse(verify_password("example-passworD", encoded))


if __name__ == "__main__":
    unittest.main()
