"""Tests for the SQLite audit store: atomicity, replay, cleanup, redaction."""

from __future__ import annotations

import threading
from pathlib import Path

from app.audit import (
    AuditStore,
    VerificationContext,
    mask_nonce,
    mask_signature,
    nonce_hash,
    _sanitize,
    _sanitize_query,
)


def ctx(**overrides) -> VerificationContext:
    base = dict(
        request_id="local-abc123",
        source="test",
        method="POST",
        path="/api/demo/echo",
        query="a=1",
        key_id="k1",
        key_status="active",
        timestamp=1700000000,
        nonce="nonce-abcdef123456",
        signature="a" * 64,
        body_sha256="b" * 64,
        body_bytes=2,
    )
    base.update(overrides)
    return VerificationContext(**base)


def test_mask_helpers_hide_the_exact_value():
    assert mask_signature("a" * 64) == "aaaa…aaaa"
    assert mask_nonce("nonce-abcdef123456") == "non…56"
    assert mask_nonce("short") == "***"
    assert mask_signature("abc") == "***"


def test_sanitize_keeps_unicode_and_drops_controls():
    assert _sanitize("中文\n文本") == "中文文本"
    assert _sanitize("a\x00b") == "ab"
    assert _sanitize("x" * 10, limit=4) == "xxxx…"


def test_sanitize_query_masks_sensitive_names():
    assert _sanitize_query("a=1&token=abc&api-key=z") == "a=1&token=***&api-key=***"
    assert _sanitize_query("shadow_word=1") == "shadow_word=1"
    # Percent-encoded parameter names must not bypass the masker.
    masked = _sanitize_query("tok%65n=abc")
    assert "abc" not in masked
    assert masked.endswith("=***")


def test_accept_then_replay_is_atomic(tmp_path: Path):
    store = AuditStore(tmp_path / "audit.sqlite3")
    row, accepted = store.accept(ctx(), nonce_retention_seconds=900, now=1_000.0)
    assert accepted is True
    assert row["decision"] == "accepted"

    row2, accepted2 = store.accept(ctx(request_id="local-other"), nonce_retention_seconds=900, now=1_000.0)
    assert accepted2 is False
    assert row2["decision"] == "rejected"
    assert row2["reason_code"] == "nonce_replayed"

    assert store.stats()["accepted"] == 1
    assert store.stats()["rejected"] == 1


def test_concurrent_replays_only_one_accepted(tmp_path: Path):
    store = AuditStore(tmp_path / "audit.sqlite3")
    results: list[bool] = []
    lock = threading.Lock()

    def attempt(i: int) -> None:
        _, ok = store.accept(ctx(request_id=f"local-{i}"), nonce_retention_seconds=900, now=2_000.0)
        with lock:
            results.append(ok)

    threads = [threading.Thread(target=attempt, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert results.count(True) == 1
    assert results.count(False) == 7


def test_nonce_expiry_allows_reuse_after_retention(tmp_path: Path):
    store = AuditStore(tmp_path / "audit.sqlite3")
    store.accept(ctx(), nonce_retention_seconds=900, now=1_000.0)
    # Same nonce, 901 seconds later: the row has expired and is cleaned up.
    _, accepted = store.accept(ctx(), nonce_retention_seconds=900, now=1_901.0)
    assert accepted is True


def test_nonce_is_global_across_keys(tmp_path: Path):
    store = AuditStore(tmp_path / "audit.sqlite3")
    _, first = store.accept(ctx(key_id="k1"), nonce_retention_seconds=900, now=1_000.0)
    assert first is True
    # Reusing the same nonce under another key is still a replay.
    _, second = store.accept(
        ctx(key_id="k2", request_id="other"), nonce_retention_seconds=900, now=1_000.0
    )
    assert second is False


def test_audit_list_filters_and_pagination(tmp_path: Path):
    store = AuditStore(tmp_path / "audit.sqlite3")
    store.accept(ctx(nonce="n-1-aaaaaaaa"), nonce_retention_seconds=900, now=1_000.0)
    store.reject(ctx(nonce="n-2-bbbbbbbb", request_id="x2"), reason_code="signature_mismatch", reason_detail="bad", now=1_001.0)
    store.reject(ctx(nonce="n-3-cccccccc", request_id="x3"), reason_code="timestamp_expired", reason_detail="old", now=1_002.0)

    rejected = store.list_audit(decision="rejected")
    assert [r["reason_code"] for r in rejected] == ["timestamp_expired", "signature_mismatch"]

    page1 = store.list_audit(limit=2)
    assert len(page1) == 2
    oldest = page1[-1]["id"]
    page2 = store.list_audit(limit=2, before_id=oldest)
    assert len(page2) == 1


def test_audit_rows_never_contain_raw_secrets(tmp_path: Path):
    store = AuditStore(tmp_path / "audit.sqlite3")
    secret_nonce = "nonce-super-secret-value"
    secret_sig = "c" * 64
    store.reject(
        ctx(nonce=secret_nonce, signature=secret_sig, query="token=leak"),
        reason_code="signature_mismatch",
        reason_detail="mismatch",
        now=1_000.0,
    )
    rows = store.list_audit()
    import json as _json

    dumped = _json.dumps(rows, ensure_ascii=False)
    assert secret_nonce not in dumped
    assert secret_sig not in dumped
    assert "leak" not in dumped
    assert nonce_hash(secret_nonce) in dumped  # hashed form is allowed


def test_export_json_is_valid(tmp_path: Path):
    import json as _json

    store = AuditStore(tmp_path / "audit.sqlite3")
    store.accept(ctx(), nonce_retention_seconds=900, now=1_000.0)
    payload = store.export_json(limit=10)
    parsed = _json.loads(payload)
    assert isinstance(parsed, list) and parsed[0]["decision"] == "accepted"
