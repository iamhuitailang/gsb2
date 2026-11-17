"""End-to-end tests for role management, auditing and verification."""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from app.canonical import (
    GENESIS_HASH,
    PAYLOAD_FIELDS,
    canonical_json,
    contains_sensitive,
    payload_digest,
    payload_from_record,
    record_hash,
    redact,
    sha256_hex,
)
from app.demo import ORG_ALPHA, ORG_BETA, PASSWORD, build_records, seed
from app.report import build_bundle, load_baseline, verify_bundle, write_bundle
from app.service import Actor, PermissionDenied, RoleService
from app.store import Store


def make_store(root: Path) -> Store:
    return Store(root / "gsb2.db", root / "audit-baseline.db")


class BaseCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.store = make_store(self.root)
        self.store.initialize()
        seed(self.store)
        build_records(self.store)
        self.service = RoleService(self.store)
        self.jia = Actor("admin-jia", "jia", ORG_ALPHA)
        self.yi = Actor("admin-yi", "yi", ORG_BETA)

    def tearDown(self) -> None:
        self._tmp.cleanup()


class RedactionTests(unittest.TestCase):
    def test_key_and_value_redaction(self) -> None:
        value = {
            "password": "hunter2",
            "nested": {"api_key": "sk-123", "note": "token=abc123 ok"},
            "list": ["Bearer abc.def.ghi", {"secret": "x"}],
        }
        cleaned = redact(value)
        serialized = canonical_json(cleaned)
        for leak in ("hunter2", "sk-123", "abc123", "abc.def.ghi"):
            self.assertNotIn(leak, serialized)
        self.assertFalse(contains_sensitive(cleaned))

    def test_jwt_redacted(self) -> None:
        token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJl"
        self.assertNotIn(token, redact({"detail": token})["detail"])

    def test_bearer_reason_is_stored_redacted(self) -> None:
        cleaned = redact({"reason": "使用了 Bearer abcdef123456 调用接口"})
        self.assertEqual(cleaned["reason"], "使用了 Bearer [REDACTED] 调用接口")
        self.assertFalse(contains_sensitive(cleaned))


class AuditChainTests(BaseCase):
    def test_two_orgs_six_ordinary_records(self) -> None:
        alpha = self.store.list_audit(ORG_ALPHA)
        beta = self.store.list_audit(ORG_BETA)
        self.assertEqual([r["seq"] for r in alpha], [1, 2, 3])
        self.assertEqual([r["seq"] for r in beta], [1, 2, 3])
        self.assertEqual(len(self.store.all_audit()), 6)

    def test_audit_fields_identify_who_what_which_rules(self) -> None:
        grant = self.store.list_audit(ORG_ALPHA)[0]
        self.assertEqual(grant["actor"], "jia")
        self.assertEqual(grant["target"], "user-1001")
        self.assertEqual(grant["role"], "operator")
        self.assertEqual(grant["action"], "role.grant")
        self.assertEqual(grant["outcome"], "success")
        self.assertEqual(grant["rule_set"], "rbac-cn-2026.1")
        self.assertIn("rule_set_digest", grant["detail"])
        self.assertEqual(grant["changes"]["before"], [])
        self.assertEqual(grant["changes"]["after"], ["operator"])

    def test_failed_attempts_are_recorded(self) -> None:
        alpha = self.store.list_audit(ORG_ALPHA)
        self.assertEqual([r["outcome"] for r in alpha], ["success", "success", "failure"])
        beta = self.store.list_audit(ORG_BETA)
        self.assertEqual([r["outcome"] for r in beta], ["success", "success", "failure"])

    def test_chain_links_and_digests(self) -> None:
        prev = GENESIS_HASH
        for record in self.store.list_audit(ORG_ALPHA):
            payload = payload_from_record(record)
            digest = payload_digest(payload)
            self.assertEqual(digest, record["digest"])
            self.assertEqual(record["prev_hash"], prev)
            self.assertEqual(record_hash(prev, digest), record["record_hash"])
            prev = record["record_hash"]

    def test_success_change_and_audit_commit_together(self) -> None:
        before_assignments = self.store.list_assignments(ORG_ALPHA)
        before_records = self.store.list_audit(ORG_ALPHA)
        record = self.service.grant_role(
            self.jia, org_id=ORG_ALPHA, subject="user-1003", role="viewer"
        )
        after_assignments = self.store.list_assignments(ORG_ALPHA)
        after_records = self.store.list_audit(ORG_ALPHA)
        self.assertEqual(len(after_assignments), len(before_assignments) + 1)
        self.assertEqual(len(after_records), len(before_records) + 1)
        self.assertEqual(after_records[-1]["audit_id"], record["audit_id"])

    def test_atomic_rollback_leaves_no_orphan_record(self) -> None:
        before = self.store.list_audit(ORG_ALPHA)
        original = self.store.append_audit

        def explode(*args, **kwargs):
            raise RuntimeError("simulated crash before commit")

        self.store.append_audit = explode  # type: ignore[assignment]
        try:
            with self.assertRaises(RuntimeError):
                self.service.grant_role(
                    self.jia, org_id=ORG_ALPHA, subject="user-1004", role="viewer"
                )
        finally:
            self.store.append_audit = original  # type: ignore[assignment]
        assignments = self.store.list_assignments(ORG_ALPHA)
        self.assertNotIn(
            ("user-1004", "viewer"),
            {(a["subject"], a["role"]) for a in assignments},
        )
        self.assertEqual(self.store.list_audit(ORG_ALPHA), before)

    def test_failed_change_does_not_alter_assignments(self) -> None:
        before = self.store.list_assignments(ORG_ALPHA)
        with self.assertRaises(PermissionDenied):
            self.service.revoke_role(
                self.jia, org_id=ORG_ALPHA, subject="user-1001", role="viewer"
            )
        self.assertEqual(self.store.list_assignments(ORG_ALPHA), before)
        records = self.store.list_audit(ORG_ALPHA)
        self.assertEqual(records[-1]["outcome"], "failure")

    def test_records_are_append_only(self) -> None:
        for statement in (
            "UPDATE audit_records SET actor = 'mallory'",
            "DELETE FROM audit_records",
        ):
            with self.assertRaises(sqlite3.IntegrityError):
                with self.store.tx() as conn:
                    conn.execute(statement)

    def test_baseline_is_append_only(self) -> None:
        conn = sqlite3.connect(self.store.baseline_path)
        try:
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute("DELETE FROM baseline_entries")
        finally:
            conn.close()

    def test_cross_org_access_denied_and_audited(self) -> None:
        with self.assertRaises(PermissionDenied):
            self.service.grant_role(
                self.jia, org_id=ORG_BETA, subject="user-2009", role="viewer"
            )
        self.assertEqual(self.store.list_assignments(ORG_BETA)[-1]["subject"], "user-2001")
        alpha = self.store.list_audit(ORG_ALPHA)
        self.assertEqual(alpha[-1]["action"], "access.denied")
        self.assertEqual(alpha[-1]["detail"]["requested_org"], ORG_BETA)

    def test_sensitive_values_never_stored(self) -> None:
        record = self.service.grant_role(
            self.jia,
            org_id=ORG_ALPHA,
            subject="user-1005",
            role="viewer",
            reason="password=S3cr3t-pass token=abc.def",
        )
        serialized = json.dumps(record, ensure_ascii=False)
        self.assertNotIn("S3cr3t-pass", serialized)
        self.assertFalse(contains_sensitive(payload_from_record(record)))
        for stored in self.store.list_audit(ORG_ALPHA):
            self.assertFalse(contains_sensitive(payload_from_record(stored)))

    def test_baseline_mirrors_every_record(self) -> None:
        entries = load_baseline(self.store.baseline_path)
        self.assertEqual(len(entries), 6)
        for record in self.store.all_audit():
            entry = next(e for e in entries if e["audit_id"] == record["audit_id"])
            self.assertEqual(entry["digest"], record["digest"])
            self.assertEqual(entry["record_hash"], record["record_hash"])


class ExportVerifyTests(BaseCase):
    def setUp(self) -> None:
        super().setUp()
        self.exports = self.root / "exports"
        self.exports.mkdir()

    def test_full_export_verifies(self) -> None:
        bundle = build_bundle(self.store, ORG_ALPHA, exported_by="jia")
        path = write_bundle(bundle, self.exports / "full.json")
        report = verify_bundle(
            json.loads(path.read_text("utf-8")),
            self.store.baseline_path,
            live_db_path=self.store.db_path,
            expected_org_id=ORG_ALPHA,
        )
        self.assertEqual(report["status"], "verified", report["errors"])
        self.assertEqual(report["checks"]["record_order"]["sequence"], [1, 2, 3])
        self.assertTrue(report["checks"]["baseline_anchor"]["all_anchored"])
        self.assertTrue(report["checks"]["coverage"]["complete_for_org"])
        self.assertEqual(report["missing_ranges"], [])

    def test_truncated_copy_reports_missing_segment(self) -> None:
        alpha = self.store.list_audit(ORG_ALPHA)
        bundle = build_bundle(self.store, ORG_ALPHA, first_seq=alpha[1]["seq"])
        path = write_bundle(bundle, self.exports / "tail.json")
        report = verify_bundle(
            json.loads(path.read_text("utf-8")),
            self.store.baseline_path,
            live_db_path=self.store.db_path,
            expected_org_id=ORG_ALPHA,
        )
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual(report["missing_ranges"], [[1, 1]])
        self.assertIn("缺少", report["summary"])
        self.assertEqual(report["errors"], [])

    def test_verification_is_read_only(self) -> None:
        before_main = self.store.db_path.read_bytes()
        before_baseline = self.store.baseline_path.read_bytes()
        records_before = self.store.list_audit(ORG_ALPHA)
        bundle = build_bundle(self.store, ORG_ALPHA, exported_by="jia")
        verify_bundle(
            bundle,
            self.store.baseline_path,
            live_db_path=self.store.db_path,
            expected_org_id=ORG_ALPHA,
        )
        self.assertEqual(self.store.db_path.read_bytes(), before_main)
        self.assertEqual(self.store.baseline_path.read_bytes(), before_baseline)
        self.assertEqual(self.store.list_audit(ORG_ALPHA), records_before)

    def test_tampered_content_fails(self) -> None:
        bundle = build_bundle(self.store, ORG_ALPHA)
        bundle["records"][1]["target"] = "mallory"
        report = verify_bundle(bundle, self.store.baseline_path, expected_org_id=ORG_ALPHA)
        self.assertEqual(report["status"], "failed")
        self.assertTrue(any("不一致" in e or "无法" in e for e in report["errors"]))

    def test_tampered_digest_cannot_be_self_healed(self) -> None:
        bundle = build_bundle(self.store, ORG_ALPHA)
        record = bundle["records"][0]
        record["target"] = "mallory"
        # Attacker also updates every embedded value to stay self-consistent.
        payload = payload_from_record(record)
        new_digest = payload_digest(payload)
        record["digest"] = new_digest
        record["record_hash"] = record_hash(record["prev_hash"], new_digest)
        for entry in bundle["integrity"]["manifest"]:
            if entry["audit_id"] == record["audit_id"]:
                entry["digest"] = new_digest
                entry["record_hash"] = record["record_hash"]
        report = verify_bundle(bundle, self.store.baseline_path, expected_org_id=ORG_ALPHA)
        self.assertEqual(report["status"], "failed")
        self.assertTrue(
            any("本地审计基准" in e for e in report["errors"]), report["errors"]
        )

    def test_reordered_copy_fails(self) -> None:
        bundle = build_bundle(self.store, ORG_ALPHA)
        bundle["records"].reverse()
        report = verify_bundle(bundle, self.store.baseline_path, expected_org_id=ORG_ALPHA)
        self.assertEqual(report["status"], "failed")
        self.assertFalse(report["checks"]["record_order"]["ascending"])

    def test_other_org_copy_rejected(self) -> None:
        bundle = build_bundle(self.store, ORG_BETA)
        report = verify_bundle(bundle, self.store.baseline_path, expected_org_id=ORG_ALPHA)
        self.assertEqual(report["status"], "failed")

    def test_unknown_records_fail(self) -> None:
        bundle = build_bundle(self.store, ORG_ALPHA, first_seq=2)
        bundle["records"].insert(0, dict(bundle["records"][0]))
        bundle["records"][0]["audit_id"] = "forged"
        report = verify_bundle(bundle, self.store.baseline_path, expected_org_id=ORG_ALPHA)
        self.assertEqual(report["status"], "failed")

    def test_bundle_digest_is_independently_checkable(self) -> None:
        bundle = build_bundle(self.store, ORG_ALPHA)
        recalculated = sha256_hex(
            canonical_json(
                {
                    "selection": bundle["selection"],
                    "manifest": bundle["integrity"]["manifest"],
                }
            ).encode("utf-8")
        )
        self.assertEqual(bundle["integrity"]["bundle_digest"], recalculated)
        self.assertEqual(
            bundle["integrity"]["payload_fields"], list(PAYLOAD_FIELDS)
        )

    def test_audit_page_still_shows_all_three(self) -> None:
        before = self.store.list_audit(ORG_ALPHA)
        bundle = build_bundle(self.store, ORG_ALPHA, first_seq=2)
        verify_bundle(bundle, self.store.baseline_path, expected_org_id=ORG_ALPHA)
        after = self.store.list_audit(ORG_ALPHA)
        self.assertEqual(len(after), 3)
        self.assertEqual([r["audit_id"] for r in after], [r["audit_id"] for r in before])


class PasswordTests(unittest.TestCase):
    def test_password_roundtrip_and_mismatch(self) -> None:
        from app.auth import hash_password, verify_password

        encoded = hash_password(PASSWORD)
        self.assertTrue(verify_password(PASSWORD, encoded))
        self.assertFalse(verify_password("wrong", encoded))
        self.assertFalse(verify_password(PASSWORD, "bogus"))


if __name__ == "__main__":
    unittest.main()
