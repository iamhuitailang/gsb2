"""Automated checks for authdemo. Run: python -m unittest discover -s tests -v

Covers: correct/wrong passwords, digest upgrade on login, failed-login
immutability, concurrent logins on one legacy account, interrupted
migration, corrupt/unknown/inconsistent import records, duplicate
imports, and log/report hygiene (no passwords or full digests).
"""

import json
import logging
import os
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from authdemo import digest  # noqa: E402
from authdemo.store import Store  # noqa: E402

ALICE_PW = "alice-demo-pass-1"
BOB_PW = "bob-demo-pass-2"
CAROL_PW = "carol-demo-pass-3"


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "test.db")
        self.store = Store(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def import_user(self, username, password, version):
        rec = {"username": username,
               "digest": self._make(password, version)}
        report = self.store.import_records([rec])
        self.assertEqual(report["imported"], 1, report)

    @staticmethod
    def _make(password, version):
        if version == 1:
            return digest.hash_v1(password)
        if version == 2:
            return digest.hash_v2(password)
        return digest.hash_current(password)


class TestLoginAndUpgrade(StoreTestCase):
    def test_v1_login_upgrades_and_stays_valid(self):
        self.import_user("alice", ALICE_PW, 1)
        r1 = self.store.login("alice", ALICE_PW)
        self.assertTrue(r1.ok)
        self.assertTrue(r1.migrated)
        acct = self.store.get_account("alice")
        self.assertEqual(acct["version"], 3)
        self.assertTrue(acct["digest"].startswith("v3:"))
        self.assertIsNotNone(acct["migrated_at"])
        # Upgraded digest keeps working on later logins, no re-migration.
        r2 = self.store.login("alice", ALICE_PW)
        self.assertTrue(r2.ok)
        self.assertFalse(r2.migrated)

    def test_v2_login_upgrades(self):
        self.import_user("bob", BOB_PW, 2)
        r = self.store.login("bob", BOB_PW)
        self.assertTrue((r.ok, r.migrated), (True, True))
        self.assertEqual(self.store.get_account("bob")["version"], 3)

    def test_current_version_login_does_not_rewrite(self):
        self.import_user("carol", CAROL_PW, 3)
        before = self.store.get_account("carol")["digest"]
        r = self.store.login("carol", CAROL_PW)
        self.assertTrue(r.ok)
        self.assertFalse(r.migrated)
        self.assertEqual(self.store.get_account("carol")["digest"], before)

    def test_wrong_password_does_not_modify_account(self):
        self.import_user("alice", ALICE_PW, 1)
        before = self.store.get_account("alice")
        r = self.store.login("alice", "wrong-password")
        self.assertFalse(r.ok)
        after = self.store.get_account("alice")
        self.assertEqual(before, after)  # nothing changed, incl. login_count

    def test_unknown_user_fails_like_wrong_password(self):
        r = self.store.login("nosuchuser", "whatever")
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, "invalid_credentials")

    def test_unknown_digest_version_fails_closed(self):
        self.store.import_records([{"username": "frank",
                                    "digest": "v9:deadbeef"}])
        r = self.store.login("frank", "anything")
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, "account_unavailable")

    def test_inconsistent_version_column_fails_closed(self):
        self.import_user("alice", ALICE_PW, 1)
        # Tamper: version column disagrees with the digest string.
        with self.store._tx() as conn:
            conn.execute("UPDATE accounts SET version = 2"
                         " WHERE username = 'alice'")
        r = self.store.login("alice", ALICE_PW)
        self.assertFalse(r.ok)
        self.assertEqual(r.reason, "account_unavailable")


class TestConcurrency(StoreTestCase):
    def test_concurrent_logins_no_lost_update(self):
        """Many threads log in to the same legacy account at once: exactly
        one digest upgrade wins, no stale legacy digest is written back,
        and unrelated account state (login_count) is preserved."""
        self.import_user("bob", BOB_PW, 2)
        with self.store._tx() as conn:
            conn.execute("UPDATE accounts SET login_count = 41"
                         " WHERE username = 'bob'")

        barrier = threading.Barrier(8)
        results = []

        def worker():
            barrier.wait()  # maximise overlap
            results.append(self.store.login("bob", BOB_PW))

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertTrue(all(r.ok for r in results))
        acct = self.store.get_account("bob")
        self.assertEqual(acct["version"], 3)
        self.assertTrue(acct["digest"].startswith("v3:"))
        # Migration must not reset other account state.
        self.assertEqual(acct["login_count"], 41 + 8)
        # Exactly one winning migration; others recorded as skipped.
        events = [e["event"] for e in self.store.migration_events("bob")]
        self.assertEqual(events.count("migrated"), 1, events)
        self.assertEqual(events.count("migration_skipped"), 7, events)
        # The surviving digest really works.
        self.assertTrue(self.store.login("bob", BOB_PW).ok)


class TestInterruptedMigration(StoreTestCase):
    def test_crash_before_upgrade_write_leaves_account_usable(self):
        self.import_user("alice", ALICE_PW, 1)
        before = self.store.get_account("alice")

        def boom():
            raise RuntimeError("simulated crash mid-migration")

        self.store.before_upgrade_write = boom
        r = self.store.login("alice", ALICE_PW)
        # Password was valid: login still succeeds, migration just deferred.
        self.assertTrue(r.ok)
        self.assertFalse(r.migrated)
        after = self.store.get_account("alice")
        # Digest untouched: still the old v1 value.
        self.assertEqual(after["digest"], before["digest"])
        self.assertEqual(after["version"], 1)

        # Next login (crash hook removed) migrates normally.
        self.store.before_upgrade_write = None
        r2 = self.store.login("alice", ALICE_PW)
        self.assertTrue(r2.ok)
        self.assertTrue(r2.migrated)
        self.assertEqual(self.store.get_account("alice")["version"], 3)


class TestImport(StoreTestCase):
    def test_problem_records(self):
        report = self.store.import_records([
            {"username": "ok1", "digest": digest.hash_v1("pw-one")},
            {"username": "unknown", "digest": "v9:deadbeef"},
            {"username": "corrupt", "digest": "v1:zz-not-hex"},
            {"username": "truncated", "digest": "v2:aabb"},       # too few fields
            {"username": "nodigest"},
            {"username": "inconsistent", "version": 2,
             "digest": digest.hash_v1("pw-two")},
            {"digest": digest.hash_v1("pw-three")},               # no username
            "not-a-dict",
        ])
        self.assertEqual(report["imported"], 1, report)
        self.assertEqual(report["needs_review"], 5, report)
        self.assertEqual(report["errors"], 2, report)

        states = {r["username"]: r["migration_state"]
                  for r in self.store.report()}
        self.assertEqual(states["ok1"], "unmigrated")
        for name in ("unknown", "corrupt", "truncated", "nodigest",
                     "inconsistent"):
            self.assertEqual(states[name], "needs_review", name)

    def test_duplicate_import_never_overwrites(self):
        self.import_user("alice", ALICE_PW, 1)
        original = self.store.get_account("alice")["digest"]
        # Re-import same username with a *different* digest: must be ignored.
        report = self.store.import_records(
            [{"username": "alice", "digest": digest.hash_v1("attacker-pass")}])
        self.assertEqual(report["duplicates"], 1)
        self.assertEqual(report["imported"], 0)
        self.assertEqual(self.store.get_account("alice")["digest"], original)
        self.assertTrue(self.store.login("alice", ALICE_PW).ok)
        self.assertFalse(self.store.login("alice", "attacker-pass").ok)

    def test_sample_file_import(self):
        path = os.path.join(os.path.dirname(__file__), "..", "data",
                            "legacy_accounts.jsonl")
        if not os.path.exists(path):
            self.skipTest("run scripts/generate_sample_data.py first")
        report = self.store.import_jsonl(path)
        self.assertEqual(report["imported"], 5, report)
        self.assertEqual(report["needs_review"], 4, report)
        self.assertEqual(report["errors"], 1, report)


class TestReportingAndHygiene(StoreTestCase):
    def test_report_distinguishes_states_and_hides_credentials(self):
        self.import_user("alice", ALICE_PW, 1)      # will be migrated
        self.import_user("bob", BOB_PW, 2)          # stays unmigrated
        self.import_user("carol", CAROL_PW, 3)      # already current
        self.store.import_records([{"username": "frank",
                                    "digest": "v9:deadbeef"}])
        self.store.login("alice", ALICE_PW)

        rows = {r["username"]: r for r in self.store.report()}
        self.assertEqual(rows["alice"]["migration_state"], "migrated")
        self.assertEqual(rows["bob"]["migration_state"], "unmigrated")
        self.assertEqual(rows["carol"]["migration_state"], "current")
        self.assertEqual(rows["frank"]["migration_state"], "needs_review")

        blob = json.dumps(list(rows.values()))
        self.assertNotIn(ALICE_PW, blob)
        self.assertNotIn("v1:", blob)
        self.assertNotIn("v2:", blob)
        self.assertNotIn("v3:", blob)
        for username in ("alice", "bob", "carol"):
            acct = self.store.get_account(username)
            self.assertNotIn(acct["digest"], blob)

    def test_logs_never_contain_password_or_full_digest(self):
        self.import_user("alice", ALICE_PW, 1)
        stored = self.store.get_account("alice")["digest"]
        logger = logging.getLogger("authdemo")
        with self.assertLogs(logger, level="DEBUG") as cm:
            self.store.login("alice", ALICE_PW)        # success + migration
            self.store.login("alice", "wrong-secret")  # failure
            self.store.login("ghost", "ghost-secret")  # unknown user
            self.store.import_records(
                [{"username": "bad", "digest": "v9:cafe"}])
        out = "\n".join(cm.output)
        for secret in (ALICE_PW, "wrong-secret", "ghost-secret", stored):
            self.assertNotIn(secret, out)

    def test_no_plaintext_in_database(self):
        self.import_user("alice", ALICE_PW, 1)
        self.store.login("alice", ALICE_PW)
        with open(self.db, "rb") as fh:
            raw = fh.read()
        self.assertNotIn(ALICE_PW.encode(), raw)


if __name__ == "__main__":
    unittest.main()
