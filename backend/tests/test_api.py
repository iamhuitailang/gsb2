"""End-to-end API tests using FastAPI's TestClient and a throwaway config."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from app import main as app_main
from app.canonical import build_canonical
from app.config import utc_now
from app.verifier import compute_signature

SECRET_A = "test-secret-alpha-0123456789abcdef"
SECRET_B = "test-secret-beta-0123456789abcdef"


@pytest.fixture()
def client(tmp_path: Path, monkeypatch):
    from fastapi.testclient import TestClient

    config_path = tmp_path / "config.local.json"
    config_path.write_text(
        json.dumps(
            {
                "time_window_seconds": 300,
                "future_skew_seconds": 60,
                "nonce_retention_seconds": 900,
                "database_path": "data/audit.sqlite3",
                "keys": [
                    {"key_id": "demo-local-01", "secret": SECRET_A, "status": "active"},
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("SIGN_TOOL_CONFIG", str(config_path))
    with TestClient(app_main.app) as test_client:
        yield test_client
    # The lifespan loads real env-based settings into module state; reset so
    # later tests in the same process do not reuse a stale store.
    app_main.state.__dict__.clear()


def _sign(method: str, path: str, query: str = "", body: bytes = b"", key_id: str = "demo-local-01"):
    settings = app_main.state.settings
    key = settings.key_by_id(key_id)
    assert key is not None
    ts = int(utc_now().timestamp())
    nonce = "api-nonce-" + os.urandom(8).hex()
    canonical = build_canonical(
        method=method,
        path=path,
        query=query,
        timestamp=ts,
        nonce=nonce,
        key_id=key_id,
        body=body,
    )
    headers = {
        "X-Key-Id": key_id,
        "X-Timestamp": str(ts),
        "X-Nonce": nonce,
        "X-Signature": compute_signature(key.secret, canonical.canonical_string),
    }
    return headers, canonical


def test_meta_never_exposes_secrets(client):
    response = client.get("/api/meta")
    assert response.status_code == 200
    body = response.json()
    assert body["active_key_id"] == "demo-local-01"
    assert body["scheme"] == "HMAC-SHA256-V1"
    text = json.dumps(body, ensure_ascii=False)
    assert SECRET_A not in text
    assert "secret" not in text.lower()


def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_sign_endpoint_returns_headers_without_secret(client):
    response = client.post(
        "/api/sign",
        json={"method": "POST", "path": "/api/demo/echo", "query": "a=1", "body": "{}"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["headers"]["X-Signature"]
    assert SECRET_A not in json.dumps(body)


def test_signed_demo_get_is_accepted(client):
    headers, canonical = _sign("GET", "/api/demo/echo", query="z=1&a=2")
    response = client.get("/api/demo/echo?z=1&a=2", headers=headers)
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["audit_id"]
    assert payload["canonical_string"] == canonical.canonical_string


def test_signed_demo_post_is_accepted_and_echoes(client):
    body = b'{"msg":"hello"}'
    headers, canonical = _sign("POST", "/api/demo/echo", query="", body=body)
    headers["Content-Type"] = "application/json"
    response = client.post("/api/demo/echo", content=body, headers=headers)
    assert response.status_code == 200
    assert response.json()["echo"] == {"msg": "hello"}


def test_unsigned_request_is_rejected(client):
    response = client.post("/api/demo/echo", content=b"{}")
    assert response.status_code == 401
    payload = response.json()
    assert payload["accepted"] is False
    assert payload["code"] == "missing_signature"


def test_bad_signature_is_rejected(client):
    headers, _ = _sign("GET", "/api/demo/ping")
    headers["X-Signature"] = "f" * 64
    response = client.get("/api/demo/ping", headers=headers)
    assert response.status_code == 401
    assert response.json()["code"] == "signature_mismatch"


def test_replay_is_rejected(client):
    headers, _ = _sign("GET", "/api/demo/ping")
    first = client.get("/api/demo/ping", headers=headers)
    assert first.status_code == 200
    second = client.get("/api/demo/ping", headers=headers)
    assert second.status_code == 409
    assert second.json()["code"] == "nonce_replayed"


def test_expired_timestamp_is_rejected(client):
    settings = app_main.state.settings
    key = settings.key_by_id("demo-local-01")
    ts = int(utc_now().timestamp()) - 500
    nonce = "expired-nonce-123456"
    canonical = build_canonical(
        method="GET", path="/api/demo/ping", query="", timestamp=ts,
        nonce=nonce, key_id="demo-local-01", body=b"",
    )
    headers = {
        "X-Key-Id": "demo-local-01",
        "X-Timestamp": str(ts),
        "X-Nonce": nonce,
        "X-Signature": compute_signature(key.secret, canonical.canonical_string),
    }
    response = client.get("/api/demo/ping", headers=headers)
    assert response.status_code == 401
    assert response.json()["code"] == "timestamp_expired"


def test_retired_key_is_rejected_via_api(tmp_path: Path, monkeypatch):
    from fastapi.testclient import TestClient

    config_path = tmp_path / "retired.json"
    config_path.write_text(
        json.dumps(
            {
                "keys": [
                    {"key_id": "old", "secret": SECRET_A, "status": "retired"},
                    {"key_id": "new", "secret": SECRET_B, "status": "active"},
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("SIGN_TOOL_CONFIG", str(config_path))
    with TestClient(app_main.app) as test_client:
        settings = app_main.state.settings
        key = settings.key_by_id("old")
        ts = int(utc_now().timestamp())
        nonce = "retired-nonce-123456"
        canonical = build_canonical(
            method="GET", path="/api/demo/ping", query="", timestamp=ts,
            nonce=nonce, key_id="old", body=b"",
        )
        headers = {
            "X-Key-Id": "old",
            "X-Timestamp": str(ts),
            "X-Nonce": nonce,
            "X-Signature": compute_signature(key.secret, canonical.canonical_string),
        }
        response = test_client.get("/api/demo/ping", headers=headers)
        assert response.status_code == 401
        assert response.json()["code"] == "retired_key"
    app_main.state.__dict__.clear()


def test_audit_lists_events_and_redacts(client):
    headers, _ = _sign("GET", "/api/demo/ping")
    client.get("/api/demo/ping", headers=headers)
    response = client.get("/api/audit?limit=10")
    assert response.status_code == 200
    payload = response.json()
    assert payload["stats"]["total"] >= 1
    event = payload["events"][0]
    assert event["decision"] == "accepted"
    assert event["signature_masked"] != headers["X-Signature"]
    assert headers["X-Signature"] not in json.dumps(payload)
    assert headers["X-Nonce"] not in json.dumps(payload)


def test_audit_decision_filter(client):
    headers, _ = _sign("GET", "/api/demo/ping")
    client.get("/api/demo/ping", headers=headers)
    headers["X-Signature"] = "e" * 64
    client.get("/api/demo/ping", headers=headers)
    rejected = client.get("/api/audit?decision=rejected").json()
    accepted = client.get("/api/audit?decision=accepted").json()
    assert all(e["decision"] == "rejected" for e in rejected["events"])
    assert all(e["decision"] == "accepted" for e in accepted["events"])


def test_samples_are_signed_and_runnable(client):
    response = client.get("/api/samples")
    assert response.status_code == 200
    samples = response.json()["samples"]
    assert samples
    for sample in samples:
        headers = sample["signing"]["headers"]
        url = sample["path"]
        if sample["query"]:
            url += f"?{sample['query']}"
        if sample["method"] == "GET":
            reply = client.get(url, headers=headers)
        else:
            reply = client.post(url, content=sample["body"].encode(), headers=headers)
        assert reply.status_code == 200, (sample["id"], reply.json())
        # Each sample carries a ready-to-run curl command.
        assert sample["curl"].startswith("curl -X " + sample["method"])


def test_oversized_body_is_rejected(client):
    body = b"x" * (app_main.MAX_BODY_BYTES + 1)
    headers, _ = _sign("POST", "/api/demo/echo", body=b"")
    headers["X-Signature"] = "a" * 64
    headers["Content-Type"] = "application/json"
    response = client.post("/api/demo/echo", content=body, headers=headers)
    assert response.status_code == 413
    assert response.json()["code"] == "body_too_large"
