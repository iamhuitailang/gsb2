"""End-to-end API tests: filters, export, raw view, reprocessing."""
from __future__ import annotations


def _session_events(session, player, day, outcome="win", gap_seq=None):
    base = {
        "session_id": session,
        "player_id": player,
    }
    times = ["10:00:00", "10:00:05", "10:00:30", "10:00:31"]
    rows = [
        {**base, "event_id": f"{session}-1", "event_type": "session_start",
         "occurred_at": f"{day}T{times[0]}Z", "sequence": 1, "schema_version": "1.0",
         "payload": {}},
        {**base, "event_id": f"{session}-2", "event_type": "player_action",
         "occurred_at": f"{day}T{times[1]}Z", "sequence": 2, "schema_version": "1.0",
         "payload": {"action_type": "kill"}},
        {**base, "event_id": f"{session}-3", "event_type": "match_result",
         "occurred_at": f"{day}T{times[2]}Z", "sequence": 3, "schema_version": "1.0",
         "payload": {"outcome": outcome}},
        {**base, "event_id": f"{session}-4", "event_type": "session_end",
         "occurred_at": f"{day}T{times[3]}Z", "sequence": 4, "schema_version": "1.0",
         "payload": {"reason": "normal"}},
    ]
    if gap_seq is not None:
        rows = [r for r in rows if r["sequence"] != gap_seq]
    return rows


def _seed(client, *batches):
    for batch in batches:
        r = client.post("/api/events", json={"events": batch})
        assert r.status_code == 200, r.text


def test_filters_by_player_status_outcome_and_date(client):
    _seed(
        client,
        _session_events("s1", "alice", "2026-11-10", "win"),
        _session_events("s2", "bob", "2026-11-11", "loss"),
    )

    assert client.get("/api/sessions").json()["total"] == 2
    assert client.get("/api/sessions", params={"player_id": "alice"}).json()["total"] == 1
    assert client.get("/api/sessions", params={"outcome": "loss"}).json()["total"] == 1
    assert client.get("/api/sessions", params={"status": "completed"}).json()["total"] == 2
    assert client.get("/api/sessions", params={"date": "2026-11-10"}).json()["total"] == 1
    assert client.get(
        "/api/sessions", params={"start_date": "2026-11-11", "end_date": "2026-11-12"}
    ).json()["total"] == 1
    assert client.get("/api/sessions", params={"date": "2020-01-01"}).json()["total"] == 0


def test_has_anomaly_filter_and_completeness(client):
    good = _session_events("good", "alice", "2026-11-10")
    gappy = _session_events("gappy", "alice", "2026-11-10", gap_seq=2)
    _seed(client, good, gappy)

    assert client.get("/api/sessions", params={"has_anomaly": "true"}).json()["total"] == 1
    clean = client.get("/api/sessions/good").json()
    broken = client.get("/api/sessions/gappy").json()
    assert clean["completeness_rate"] == 1.0
    assert broken["completeness_rate"] < 1.0
    assert broken["anomaly_counts"]["missing_sequence"] == 1


def test_raw_events_returned_in_reception_order(client):
    _seed(client, _session_events("s1", "alice", "2026-11-10"))
    raw = client.get("/api/sessions/s1/raw").json()
    assert raw["order"] == "reception_order"
    assert len(raw["events"]) == 4
    assert "payload" in raw["events"][0]


def test_csv_export_respects_filters(client):
    _seed(
        client,
        _session_events("s1", "alice", "2026-11-10", "win"),
        _session_events("s2", "bob", "2026-11-11", "loss"),
    )
    r = client.get("/api/export/sessions.csv", params={"player_id": "alice"})
    assert r.status_code == 200
    assert "text/csv" in r.headers["content-type"]
    lines = r.text.strip().splitlines()
    assert len(lines) == 2  # header + one row
    assert "s1" in lines[1]
    assert "s2" not in r.text


def test_reprocess_endpoint_returns_hash_and_keeps_rules_version(client):
    _seed(client, _session_events("s1", "alice", "2026-11-10"))
    before = client.get("/api/sessions/s1").json()
    r = client.post("/api/sessions/s1/reprocess")
    assert r.status_code == 200
    assert r.json()["result_hash"] == before["result_hash"]
    assert r.json()["rules_version"] == before["rules_version"]


def test_unknown_session_returns_404(client):
    assert client.get("/api/sessions/nope").status_code == 404
    assert client.get("/api/sessions/nope/raw").status_code == 404


def test_players_endpoint(client):
    _seed(
        client,
        _session_events("s1", "alice", "2026-11-10"),
        _session_events("s2", "bob", "2026-11-10"),
    )
    assert client.get("/api/players").json()["players"] == ["alice", "bob"]


def test_health_reports_rules_and_schema_versions(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["rules_version"]
    assert body["supported_schema_versions"] == ["1.0"]


def test_timestamps_round_trip_in_utc_regardless_of_input_offset(client):
    # 2026-11-10T14:00+08:00 == 2026-11-10T06:00Z
    events = _session_events("tz1", "alice", "2026-11-10")
    for ev in events:
        ev["occurred_at"] = ev["occurred_at"].replace("Z", "+08:00")
    _seed(client, events)

    detail = client.get("/api/sessions/tz1").json()
    assert detail["started_at"].startswith("2026-11-10T02:00:00")  # 10:00+08 -> 02:00Z
    assert detail["started_at"].endswith("+00:00")
    # Date filter must work against the UTC instant, not the local wall clock.
    assert client.get("/api/sessions", params={"date": "2026-11-10"}).json()["total"] == 1
    assert client.get("/api/sessions", params={"date": "2026-11-09"}).json()["total"] == 0
