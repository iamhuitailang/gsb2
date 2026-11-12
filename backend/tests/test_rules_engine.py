"""Timeline rebuild: anomaly detection, metrics, determinism, late events."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app import rules
from app.rules import StoredEvent


def _stored(eid, seq, etype="position", occurred=None, received=None, payload=None,
            session="s1", player="p1", schema="1.0", ingest_id=None):
    base = datetime(2026, 11, 10, 10, 0, 0, tzinfo=timezone.utc)
    return StoredEvent(
        event_id=eid,
        session_id=session,
        player_id=player,
        event_type=etype,
        occurred_at=occurred or (base + timedelta(seconds=seq)),
        sequence=seq,
        schema_version=schema,
        payload=payload if payload is not None else ({"x": 1, "y": 2} if etype == "position" else {}),
        received_at=received or (base + timedelta(seconds=seq)),
        ingest_id=ingest_id if ingest_id is not None else seq,
    )


def _full_session(prefix="s1"):
    base = datetime(2026, 11, 10, 10, 0, 0, tzinfo=timezone.utc)
    return [
        _stored(f"{prefix}-1", 1, "session_start", base + timedelta(seconds=0),
                base + timedelta(seconds=0), {"mode": "ranked"}),
        _stored(f"{prefix}-2", 2, "player_action", base + timedelta(seconds=5),
                base + timedelta(seconds=5), {"action_type": "kill"}),
        _stored(f"{prefix}-3", 3, "player_action", base + timedelta(seconds=9),
                base + timedelta(seconds=9), {"action_type": "assist"}),
        _stored(f"{prefix}-4", 4, "item_pickup", base + timedelta(seconds=12),
                base + timedelta(seconds=12), {"item_id": "sword"}),
        _stored(f"{prefix}-5", 5, "match_result", base + timedelta(seconds=60),
                base + timedelta(seconds=60), {"outcome": "win", "score": 2}),
        _stored(f"{prefix}-6", 6, "session_end", base + timedelta(seconds=61),
                base + timedelta(seconds=61), {"reason": "normal"}),
    ]


def test_clean_session_metrics():
    result = rules.rebuild_session("s1", _full_session())
    assert result["status"] == "completed"
    assert result["outcome"] == "win"
    assert result["duration_seconds"] == 61.0
    assert result["key_action_count"] == 2
    assert result["completeness_rate"] == 1.0
    assert result["total_events"] == 6
    assert sum(result["anomaly_counts"].values()) == 0


def test_missing_sequence_detected_and_lowers_completeness():
    events = _full_session()
    events = [e for e in events if e.sequence != 3]  # gap at 3
    result = rules.rebuild_session("s1", events)
    assert result["anomaly_counts"]["missing_sequence"] == 1
    assert result["metrics"]["missing_sequences"] == [3]
    # 5 unique sequences over range 1..6 -> 5/6
    assert result["completeness_rate"] == round(5 / 6, 6)


def test_duplicate_sequence_flagged():
    events = _full_session()
    events.append(_stored("s1-2-dup", 2, "item_pickup", payload={"item_id": "potion"}))
    result = rules.rebuild_session("s1", events)
    assert result["anomaly_counts"]["duplicate_sequence"] == 1
    flagged = [t for t in result["timeline"] if "duplicate_sequence" in t["flags"]]
    assert len(flagged) == 2  # both rows carrying the duplicated sequence


def test_time_regression_detected():
    base = datetime(2026, 11, 10, 10, 0, 0, tzinfo=timezone.utc)
    events = [
        _stored("a", 1, "position", base + timedelta(seconds=10), base + timedelta(seconds=1)),
        _stored("b", 2, "position", base + timedelta(seconds=4), base + timedelta(seconds=2)),
    ]
    result = rules.rebuild_session("s1", events)
    assert result["anomaly_counts"]["time_regression"] == 1


def test_unknown_event_type_flagged_but_kept():
    events = [
        _stored("a", 1, "session_start", payload={}),
        _stored("b", 2, "future_emote", payload={"anything": True}),
    ]
    result = rules.rebuild_session("s1", events)
    assert result["anomaly_counts"]["unknown_event_type"] == 1
    types = [t["event_type"] for t in result["timeline"]]
    assert "future_emote" in types


def test_out_of_order_arrival_flagged():
    base = datetime(2026, 11, 10, 10, 0, 0, tzinfo=timezone.utc)
    events = [
        # seq 2 received first, seq 1 received after
        _stored("a", 1, "position", base + timedelta(seconds=1), base + timedelta(seconds=2)),
        _stored("b", 2, "position", base + timedelta(seconds=2), base + timedelta(seconds=1)),
    ]
    result = rules.rebuild_session("s1", events)
    assert result["anomaly_counts"]["out_of_order_arrival"] == 1


def test_out_of_order_within_one_batch_uses_insertion_order():
    # All events share one received_at (same batch); only ingest_id differs.
    base = datetime(2026, 11, 10, 10, 0, 0, tzinfo=timezone.utc)
    received = base + timedelta(seconds=100)
    events = [
        # Arrival order in the batch: seq1, seq3, seq2 -> seq2 is out of order
        _stored("a", 1, "position", base + timedelta(seconds=1), received, ingest_id=1),
        _stored("c", 3, "position", base + timedelta(seconds=3), received, ingest_id=2),
        _stored("b", 2, "position", base + timedelta(seconds=2), received, ingest_id=3),
    ]
    result = rules.rebuild_session("s1", events)
    assert result["anomaly_counts"]["out_of_order_arrival"] == 1


def test_late_event_arriving_after_terminal_is_flagged_not_dropped():
    base = datetime(2026, 11, 10, 10, 0, 0, tzinfo=timezone.utc)
    events = [
        _stored("a", 1, "session_start", base, base, {}),
        _stored("b", 2, "match_result", base + timedelta(seconds=30),
                base + timedelta(seconds=30), {"outcome": "loss"}),
        _stored("c", 3, "session_end", base + timedelta(seconds=31),
                base + timedelta(seconds=31), {}),
        # occurs in the middle of the game, received long after the end event
        _stored("d", 4, "item_pickup", base + timedelta(seconds=10),
                base + timedelta(seconds=300), {"item_id": "late"}),
    ]
    result = rules.rebuild_session("s1", events)
    assert result["anomaly_counts"]["late_arrival"] == 1
    assert result["total_events"] == 4  # late event still counts
    assert result["status"] == "completed"
    # timeline order follows sequence/occurred_at, not reception order
    seq_order = [t["sequence"] for t in result["timeline"]]
    assert seq_order == sorted(seq_order)
    assert result["timeline"][-1]["event_id"] == "d"


def test_deterministic_hash_independent_of_insert_order():
    events = _full_session()
    r1 = rules.rebuild_session("s1", events)
    r2 = rules.rebuild_session("s1", list(reversed(events)))
    assert r1["result_hash"] == r2["result_hash"]
    assert r1["timeline"] == r2["timeline"]


def test_hash_changes_when_raw_data_changes():
    events = _full_session()
    h1 = rules.rebuild_session("s1", events)["result_hash"]
    events[1].payload = {"action_type": "capture"}
    h2 = rules.rebuild_session("s1", events)["result_hash"]
    assert h1 != h2


def test_received_at_does_not_affect_hash():
    e1 = _full_session()
    e2 = [
        StoredEvent(**{**ev.__dict__, "received_at": ev.received_at + timedelta(hours=5)})
        for ev in _full_session()
    ]
    assert rules.rebuild_session("s1", e1)["result_hash"] == rules.rebuild_session("s1", e2)["result_hash"]


def test_open_session_without_terminal_event():
    events = [
        _stored("a", 1, "session_start", payload={}),
        _stored("b", 2, "position"),
    ]
    result = rules.rebuild_session("s1", events)
    assert result["status"] == "open"
    assert result["outcome"] is None


def test_rules_version_is_recorded_in_result():
    result = rules.rebuild_session("s1", _full_session(), rules_version="9.9.9")
    assert result["rules_version"] == "9.9.9"
    assert result["result_hash"] != rules.rebuild_session("s1", _full_session())["result_hash"]
