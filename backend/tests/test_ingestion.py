"""Ingestion endpoint: batch acceptance, idempotency, rejection isolation."""
from __future__ import annotations


def _ev(eid="e1", session="s1", player="p1", seq=1, etype="position", **over):
    base = {
        "event_id": eid,
        "session_id": session,
        "player_id": player,
        "event_type": etype,
        "occurred_at": "2026-11-10T10:00:00Z",
        "sequence": seq,
        "schema_version": "1.0",
        "payload": {"x": 1, "y": 2} if etype == "position" else {},
    }
    base.update(over)
    return base


def test_good_and_bad_events_in_same_batch_are_judged_independently(client):
    good = _ev("good-1", etype="session_start", payload={"mode": "ranked"})
    bad_payload = _ev("bad-1", etype="item_pickup", payload={})  # item_id required
    bad_schema = _ev("bad-2", schema_version="9.9")
    bad_shape = {"event_id": "bad-3", "no": "schema"}

    r = client.post("/api/events", json={"events": [good, bad_payload, bad_schema, bad_shape]})
    assert r.status_code == 200
    body = r.json()
    assert body["accepted"] == 1
    assert body["rejected"] == 3
    codes = {item["event_id"]: item["code"] for item in body["results"]}
    assert codes["good-1"] == "accepted"
    assert codes["bad-1"] == "payload_rejected"
    assert codes["bad-2"] == "unsupported_schema_version"
    assert codes["bad-3"] == "malformed_event"


def test_duplicate_event_id_is_idempotent_not_double_counted(client):
    ev = _ev("dup-1", etype="session_start", payload={})
    r1 = client.post("/api/events", json={"events": [ev]})
    assert r1.json()["accepted"] == 1

    r2 = client.post("/api/events", json={"events": [ev]})
    body = r2.json()
    assert body["accepted"] == 0
    assert body["duplicate"] == 1
    assert body["results"][0]["code"] == "duplicate_event_id"

    detail = client.get("/api/sessions/s1").json()
    assert detail["total_events"] == 1


def test_duplicate_within_one_batch_first_wins(client):
    ev = _ev("same-id")
    r = client.post("/api/events", json={"events": [ev, ev]})
    body = r.json()
    assert body["accepted"] == 1
    assert body["duplicate"] == 1
    assert body["results"][1]["code"] == "duplicate_in_batch"


def test_unknown_schema_version_is_never_silently_interpreted(client):
    r = client.post("/api/events", json={"events": [_ev("future", schema_version="2.0")]})
    result = r.json()["results"][0]
    assert result["accepted"] is False
    assert result["code"] == "unsupported_schema_version"


def test_timestamp_without_timezone_is_rejected(client):
    r = client.post(
        "/api/events",
        json={"events": [_ev("naive-ts", occurred_at="2026-11-10T10:00:00")]},
    )
    assert r.json()["results"][0]["code"] == "bad_timestamp"


def test_client_supplied_extra_field_is_rejected(client):
    ev = _ev("cheater")
    ev["client_summary"] = {"kdr": 99.0}
    r = client.post("/api/events", json={"events": [ev]})
    assert r.json()["results"][0]["code"] == "malformed_event"


def test_invalid_json_body_returns_400(client):
    r = client.post("/api/events", content=b"{not json", headers={"Content-Type": "application/json"})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "invalid_json"


def test_body_size_limit_enforced(client):
    big_payload = {"blob": "x" * (2 * 1024 * 1024)}
    r = client.post("/api/events", json={"events": [_ev("huge", payload=big_payload)]})
    assert r.status_code == 413


def test_batch_event_count_limit(client):
    from app.config import MAX_BATCH_EVENTS

    events = [_ev(f"e{i}", seq=i, etype="session_start", payload={}) for i in range(MAX_BATCH_EVENTS + 1)]
    r = client.post("/api/events", json={"events": events})
    body = r.json()
    assert body["accepted"] == 0
    assert all(item["code"] == "batch_limit_exceeded" for item in body["results"])
