"""Tests for canonicalisation, verification order, nonce replay and rotation."""

from __future__ import annotations

import hashlib
import json
from datetime import timedelta
from pathlib import Path

import pytest

from app.audit import AuditStore
from app.canonical import CanonicalError, build_canonical
from app.config import ConfigError, Settings, build_settings, utc_now
from app.verifier import (
    PreparedRequest,
    VerificationError,
    compute_signature,
    key_public_view,
    verify_request,
)

SECRET_A = "a" * 32
SECRET_B = "b" * 32


def make_settings(tmp_path: Path, *, grace_until: str | None = None) -> Settings:
    data = {
        "time_window_seconds": 300,
        "future_skew_seconds": 60,
        "nonce_retention_seconds": 900,
        "database_path": "data/audit.sqlite3",
        "keys": [
            {"key_id": "old-key", "secret": SECRET_A, "status": "active", "grace_until": None},
        ],
    }
    if grace_until is not None:
        data["keys"] = [
            {
                "key_id": "old-key",
                "secret": SECRET_A,
                "status": "grace",
                "grace_until": grace_until,
            },
            {"key_id": "new-key", "secret": SECRET_B, "status": "active", "grace_until": None},
        ]
    return build_settings(data, tmp_path / "config.local.json")


def make_request(**overrides):
    base = dict(
        method="POST",
        path="/api/demo/echo",
        query="a=1&b=2",
        timestamp=int(utc_now().timestamp()),
        nonce="nonce-0123456789abcdef",
        key_id="old-key",
        signature="",
        body=b'{"x":1}',
        source="test",
    )
    base.update(overrides)
    return PreparedRequest(**base)


def sign_request(settings, prepared: PreparedRequest) -> PreparedRequest:
    canonical = build_canonical(
        method=prepared.method,
        path=prepared.path,
        query=prepared.query,
        timestamp=prepared.timestamp,
        nonce=prepared.nonce,
        key_id=prepared.key_id,
        body=prepared.body,
    )
    key = settings.key_by_id(prepared.key_id)
    assert key is not None
    prepared.signature = compute_signature(key.secret, canonical.canonical_string)
    return prepared


@pytest.fixture()
def settings(tmp_path: Path):
    return make_settings(tmp_path)


@pytest.fixture()
def store(settings):
    return AuditStore(settings.database_path)


# ---------------------------------------------------------------------------
# Canonicalisation
# ---------------------------------------------------------------------------


def test_canonical_layout_is_eight_lf_joined_lines():
    canonical = build_canonical(
        method="post",
        path="/api/Demo/Echo",
        query="b=2&a=1",
        timestamp=1700000000,
        nonce="abcdefgh",
        key_id="demo",
        body=b'{"a": 1}',
    )
    lines = canonical.canonical_string.split("\n")
    assert len(lines) == 8
    assert lines[0] == "HMAC-SHA256-V1"
    assert lines[1] == "METHOD:POST"
    assert lines[2] == "PATH:/api/Demo/Echo"
    assert lines[3] == "QUERY:a=1&b=2"
    assert lines[4] == "TIMESTAMP:1700000000"
    assert lines[5] == "NONCE:abcdefgh"
    assert lines[6] == "KEY-ID:demo"
    assert lines[7] == "BODY-SHA256:" + hashlib.sha256(b'{"a": 1}').hexdigest()
    assert not canonical.canonical_string.endswith("\n")


def test_empty_body_hash_is_sha256_of_zero_bytes():
    canonical = build_canonical(
        method="GET",
        path="/api/demo/ping",
        query="",
        timestamp=1700000000,
        nonce="abcdefgh",
        key_id="demo",
        body=b"",
    )
    assert canonical.body_sha256 == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    assert canonical.query == ""


def test_query_order_and_encoding_are_stable():
    a = build_canonical(
        method="GET", path="/x", query="z=9&a=hello world&a=1", timestamp=1,
        nonce="abcdefgh", key_id="demo", body=b"",
    )
    b = build_canonical(
        method="GET", path="/x", query="a=1&a=hello%20world&z=9", timestamp=1,
        nonce="abcdefgh", key_id="demo", body=b"",
    )
    c = build_canonical(
        method="GET", path="/x", query="?a=1&a=hello+world&z=9&", timestamp=1,
        nonce="abcdefgh", key_id="demo", body=b"",
    )
    assert a.canonical_string == b.canonical_string == c.canonical_string
    assert a.query == "a=1&a=hello%20world&z=9"


def test_empty_query_value_is_kept_but_empty_segment_is_dropped():
    canonical = build_canonical(
        method="GET", path="/x", query="a=&b=1&&c", timestamp=1,
        nonce="abcdefgh", key_id="demo", body=b"",
    )
    # "a=" is a real empty value; bare "c" is a flag-style empty value; the
    # empty segment between "&&" is dropped.
    assert canonical.query == "a=&b=1&c="


def test_field_order_in_body_is_preserved():
    first = build_canonical(
        method="POST", path="/x", query="", timestamp=1, nonce="abcdefgh",
        key_id="demo", body=b'{"a":1,"b":2}',
    )
    second = build_canonical(
        method="POST", path="/x", query="", timestamp=1, nonce="abcdefgh",
        key_id="demo", body=b'{"b":2,"a":1}',
    )
    assert first.body_sha256 != second.body_sha256


def test_path_is_percent_encoded_consistently():
    a = build_canonical(
        method="GET", path="/api/文件/空格 名", query="", timestamp=1,
        nonce="abcdefgh", key_id="demo", body=b"",
    )
    b = build_canonical(
        method="GET", path="/api/%E6%96%87%E4%BB%B6/%E7%A9%BA%E6%A0%BC%20%E5%90%8D",
        query="", timestamp=1, nonce="abcdefgh", key_id="demo", body=b"",
    )
    c = build_canonical(
        method="GET", path="api/文件/空格 名", query="", timestamp=1,
        nonce="abcdefgh", key_id="demo", body=b"",
    )
    assert a.canonical_string == b.canonical_string == c.canonical_string


def test_literal_percent_survives_round_trip():
    # %25 decodes to a literal "%", which is then re-encoded as %25 again.
    # This is the case a double-decoding server would get wrong.
    canonical = build_canonical(
        method="GET", path="/api/100%25done", query="", timestamp=1,
        nonce="abcdefgh", key_id="demo", body=b"",
    )
    assert canonical.path == "/api/100%25done"


@pytest.mark.parametrize(
    "path",
    ["/a//b", "/api//", "/a/%2Fb", "/api/trailing/", "/api/100%done"],
)
def test_ambiguous_paths_are_rejected(path: str):
    with pytest.raises(CanonicalError):
        build_canonical(
            method="GET", path=path, query="", timestamp=1, nonce="abcdefgh",
            key_id="demo", body=b"",
        )


@pytest.mark.parametrize(
    "overrides",
    [
        {"timestamp": "1700000000.5"},
        {"timestamp": "1700000000 "},
        {"nonce": "short"},
        {"nonce": "has space inside"},
        {"method": "G ET"},
        {"path": "/x?y=1"},
        {"query": "=badvalue"},
    ],
)
def test_invalid_inputs_raise_canonical_error(overrides):
    kwargs = dict(
        method="GET", path="/x", query="", timestamp=1, nonce="abcdefgh",
        key_id="demo", body=b"",
    )
    kwargs.update(overrides)
    with pytest.raises(CanonicalError):
        build_canonical(**kwargs)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


def test_config_requires_exactly_one_active_key(tmp_path: Path):
    data = {
        "keys": [
            {"key_id": "a", "secret": SECRET_A, "status": "active"},
            {"key_id": "b", "secret": SECRET_B, "status": "active"},
        ]
    }
    with pytest.raises(ConfigError):
        build_settings(data, tmp_path / "c.json")


def test_config_rejects_short_secret(tmp_path: Path):
    data = {"keys": [{"key_id": "a", "secret": "short", "status": "active"}]}
    with pytest.raises(ConfigError):
        build_settings(data, tmp_path / "c.json")


def test_config_rejects_nonce_retention_shorter_than_window(tmp_path: Path):
    data = {
        "time_window_seconds": 300,
        "future_skew_seconds": 60,
        "nonce_retention_seconds": 120,
        "keys": [{"key_id": "a", "secret": SECRET_A, "status": "active"}],
    }
    with pytest.raises(ConfigError):
        build_settings(data, tmp_path / "c.json")


def test_grace_key_requires_grace_until(tmp_path: Path):
    data = {"keys": [{"key_id": "a", "secret": SECRET_A, "status": "grace"}]}
    with pytest.raises(ConfigError):
        build_settings(data, tmp_path / "c.json")


def test_public_key_view_contains_no_secret(settings):
    view = key_public_view(settings)
    dumped = json.dumps(view, ensure_ascii=False)
    assert SECRET_A not in dumped
    assert [k["key_id"] for k in view["keys"]] == ["old-key"]


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


def test_valid_request_is_accepted(settings, store):
    prepared = sign_request(settings, make_request())
    result = verify_request(settings, prepared, store, clock=prepared.timestamp)
    assert result.accepted
    assert result.signature_ok
    assert result.key_status == "active"
    events = store.list_audit()
    assert events[0]["decision"] == "accepted"
    assert events[0]["reason_code"] == "accepted"


def test_signature_mismatch_is_rejected(settings, store):
    prepared = sign_request(settings, make_request())
    prepared.signature = "0" * 64
    with pytest.raises(VerificationError) as exc:
        verify_request(settings, prepared, store, clock=prepared.timestamp)
    assert exc.value.code == "signature_mismatch"
    assert exc.value.status == 401
    assert store.list_audit()[0]["reason_code"] == "signature_mismatch"


def test_tampered_body_is_rejected(settings, store):
    prepared = sign_request(settings, make_request())
    prepared.body = b'{"x":2}'
    with pytest.raises(VerificationError) as exc:
        verify_request(settings, prepared, store, clock=prepared.timestamp)
    assert exc.value.code == "signature_mismatch"


def test_empty_body_round_trip(settings, store):
    prepared = sign_request(settings, make_request(method="GET", body=b"", path="/api/demo/ping"))
    result = verify_request(settings, prepared, store, clock=prepared.timestamp)
    assert result.accepted


def test_timestamp_outside_window_is_rejected(settings, store):
    ts = int(utc_now().timestamp()) - 400
    prepared = sign_request(settings, make_request(timestamp=ts))
    with pytest.raises(VerificationError) as exc:
        verify_request(settings, prepared, store, clock=ts + 400)
    assert exc.value.code == "timestamp_expired"


def test_timestamp_in_future_is_rejected(settings, store):
    ts = int(utc_now().timestamp()) + 120
    prepared = sign_request(settings, make_request(timestamp=ts))
    with pytest.raises(VerificationError) as exc:
        verify_request(settings, prepared, store, clock=ts - 120)
    assert exc.value.code == "timestamp_in_future"


def test_timestamp_within_allowance_is_accepted(settings, store):
    prepared = sign_request(settings, make_request())
    # 290 seconds of age is inside the 300s window.
    result = verify_request(settings, prepared, store, now=utc_now(), clock=prepared.timestamp + 290)
    assert result.accepted


def test_nonce_replay_is_rejected(settings, store):
    prepared = sign_request(settings, make_request())
    verify_request(settings, prepared, store, clock=prepared.timestamp)
    with pytest.raises(VerificationError) as exc:
        verify_request(settings, prepared, store, clock=prepared.timestamp)
    assert exc.value.code == "nonce_replayed"
    assert exc.value.status == 409
    events = store.list_audit()
    assert [e["reason_code"] for e in events] == ["nonce_replayed", "accepted"]
    assert store.stats()["reject_reasons"] == [{"reason_code": "nonce_replayed", "count": 1}]


def test_distinct_nonces_are_accepted(settings, store):
    first = sign_request(settings, make_request(nonce="nonce-aaaaaaaaaaaa"))
    verify_request(settings, first, store, clock=first.timestamp)
    second = sign_request(settings, make_request(nonce="nonce-bbbbbbbbbbbb"))
    verify_request(settings, second, store, clock=second.timestamp)
    assert store.stats()["accepted"] == 2


def test_unknown_key_is_rejected(settings, store):
    prepared = sign_request(settings, make_request(key_id="old-key"))
    prepared.key_id = "nope"
    with pytest.raises(VerificationError) as exc:
        verify_request(settings, prepared, store, clock=prepared.timestamp)
    assert exc.value.code == "unknown_key_id"


def test_malformed_signature_is_rejected(settings, store):
    prepared = sign_request(settings, make_request())
    prepared.signature = "jjjj"
    with pytest.raises(VerificationError) as exc:
        verify_request(settings, prepared, store, clock=prepared.timestamp)
    assert exc.value.code == "malformed_signature"
    assert exc.value.status == 400


# ---------------------------------------------------------------------------
# Rotation
# ---------------------------------------------------------------------------


def _rotation_settings(tmp_path: Path, grace_until: str):
    return make_settings(tmp_path, grace_until=grace_until)


def test_grace_key_is_accepted_during_rotation(tmp_path: Path, store):
    now = utc_now()
    settings = _rotation_settings(tmp_path, (now + timedelta(minutes=10)).isoformat())
    prepared = sign_request(settings, make_request(key_id="old-key"))
    result = verify_request(settings, prepared, store, now=now, clock=prepared.timestamp)
    assert result.accepted
    assert result.key_status == "grace"


def test_new_key_is_active_during_rotation(tmp_path: Path):
    now = utc_now()
    settings = _rotation_settings(tmp_path, (now + timedelta(minutes=10)).isoformat())
    store = AuditStore(settings.database_path)
    prepared = sign_request(settings, make_request(key_id="new-key"))
    result = verify_request(settings, prepared, store, now=now, clock=prepared.timestamp)
    assert result.accepted
    assert result.key_status == "active"


def test_old_key_is_rejected_after_grace_window(tmp_path: Path):
    now = utc_now()
    settings = _rotation_settings(tmp_path, (now + timedelta(minutes=10)).isoformat())
    store = AuditStore(settings.database_path)
    later = now + timedelta(minutes=20)
    later_ts = int(later.timestamp())
    prepared = sign_request(settings, make_request(key_id="old-key", timestamp=later_ts))
    # Signature is still mathematically valid, but the key is retired by time.
    with pytest.raises(VerificationError) as exc:
        verify_request(settings, prepared, store, now=later, clock=later_ts)
    assert exc.value.code == "retired_key"
    assert exc.value.status == 401


def test_retired_key_rejected_even_with_valid_signature(tmp_path: Path):
    data = {
        "keys": [
            {"key_id": "old-key", "secret": SECRET_A, "status": "retired"},
            {"key_id": "new-key", "secret": SECRET_B, "status": "active"},
        ]
    }
    settings = build_settings(data, tmp_path / "c.json")
    store = AuditStore(settings.database_path)
    prepared = sign_request(settings, make_request(key_id="old-key"))
    with pytest.raises(VerificationError) as exc:
        verify_request(settings, prepared, store, clock=prepared.timestamp)
    assert exc.value.code == "retired_key"


# ---------------------------------------------------------------------------
# Audit redaction
# ---------------------------------------------------------------------------


def test_audit_never_stores_raw_signature_or_nonce(settings, store):
    prepared = sign_request(settings, make_request(nonce="nonce-uniquesecret123"))
    verify_request(settings, prepared, store, clock=prepared.timestamp)
    row = store.list_audit()[0]
    assert "…" in row["signature_masked"]
    assert len(row["signature_masked"]) < 64
    assert prepared.signature not in row["signature_masked"]
    assert row["nonce_masked"] != "nonce-uniquesecret123"
    assert "nonce-uniquesecret123" not in json.dumps(row, ensure_ascii=False)
    assert row["nonce_hash"]
    assert row["body_sha256"] == build_canonical(
        method="POST", path="/api/demo/echo", query="a=1&b=2",
        timestamp=prepared.timestamp, nonce="nonce-uniquesecret123",
        key_id="old-key", body=b'{"x":1}',
    ).body_sha256


def test_audit_row_is_bounded_and_single_line(settings, store):
    long_path = "/api/demo/echo/" + "a" * 400
    prepared = sign_request(settings, make_request(path=long_path))
    prepared.signature = "0" * 64  # force a rejection with a long path
    with pytest.raises(VerificationError):
        verify_request(settings, prepared, store, clock=prepared.timestamp)
    row = store.list_audit()[0]
    assert "\n" not in row["reason_detail"]
    assert len(row["path"]) <= 513
    assert row["reason_detail"].startswith("HMAC")


def test_audit_keeps_unicode_reason_text(settings, store):
    # A syntactically valid signature gets us past the "missing header" and
    # signature checks so the timestamp canonicalisation error is audited.
    prepared = make_request(timestamp="not-a-number", signature="0" * 64)
    with pytest.raises(VerificationError):
        verify_request(settings, prepared, store, clock=0.0)
    row = store.list_audit()[0]
    assert "timestamp" in row["reason_detail"]
    # Chinese text must survive sanitisation, not be stripped away.
    assert "整数秒" in row["reason_detail"]


def test_audit_masks_sensitive_query_values(settings, store):
    prepared = sign_request(
        settings, make_request(query="a=1&token=supersecret&api_key=abc")
    )
    prepared.signature = "0" * 64
    with pytest.raises(VerificationError):
        verify_request(settings, prepared, store, clock=prepared.timestamp)
    row = store.list_audit()[0]
    assert "supersecret" not in row["query"]
    assert "abc" not in row["query"]
    assert row["query"] == "a=1&token=***&api_key=***"
