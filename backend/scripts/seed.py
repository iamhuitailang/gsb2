"""Seed demo data that exercises every ingestion/rebuild edge case.

Run:  python -m scripts.seed
The script talks to the HTTP API (same path real clients use), so it also
demonstrates retries, out-of-order delivery, late events and rejected items.
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

BASE_URL = os.environ.get("API_BASE_URL", "http://127.0.0.1:8000")
HERE = Path(__file__).resolve().parent


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def event(session, player, seq, etype, occurred_at, payload, eid=None, schema="1.0"):
    return {
        "event_id": eid or f"{session}-e{seq}",
        "session_id": session,
        "player_id": player,
        "event_type": etype,
        "occurred_at": iso(occurred_at),
        "sequence": seq,
        "schema_version": schema,
        "payload": payload,
    }


def build_batches() -> list[list[dict]]:
    t0 = datetime(2026, 11, 10, 10, 0, 0, tzinfo=timezone.utc)

    # --- Session A: clean, complete win -------------------------------------
    a = "sess-clean-001"
    clean = [
        event(a, "p_alpha", 1, "session_start", t0, {"mode": "ranked", "map": "dust"}),
        event(a, "p_alpha", 2, "player_action", t0 + timedelta(seconds=5), {"action_type": "kill"}),
        event(a, "p_alpha", 3, "item_pickup", t0 + timedelta(seconds=8), {"item_id": "sword_1"}),
        event(a, "p_alpha", 4, "position", t0 + timedelta(seconds=9), {"x": 12, "y": 7}),
        event(a, "p_alpha", 5, "player_action", t0 + timedelta(seconds=20), {"action_type": "capture"}),
        event(a, "p_alpha", 6, "match_result", t0 + timedelta(seconds=120), {"outcome": "win", "score": 3}),
        event(a, "p_alpha", 7, "session_end", t0 + timedelta(seconds=121), {"reason": "normal"}),
    ]

    # --- Session B: out-of-order arrival + time regression + unknown type ---
    b = "sess-messy-002"
    tb = datetime(2026, 11, 11, 14, 0, 0, tzinfo=timezone.utc)
    messy = [
        event(b, "p_beta", 1, "session_start", tb, {"mode": "casual"}),
        event(b, "p_beta", 3, "player_action", tb + timedelta(seconds=10), {"action_type": "kill"}),
        # seq 2 arrives AFTER seq 3: out-of-order; timeline reorders it back
        event(b, "p_beta", 2, "position", tb + timedelta(seconds=4), {"x": 1, "y": 1}),
        # unknown event type, and backdated: occurred_at (tb+2s) is earlier than
        # the preceding timeline rows -> unknown_event_type + time_regression
        event(b, "p_beta", 4, "emote_spin", tb + timedelta(seconds=2), {"note": "new client type"}),
        # duplicate sequence 3 (different event_id): duplicate_sequence anomaly
        event(b, "p_beta", 3, "item_pickup", tb + timedelta(seconds=11), {"item_id": "hp_potion"},
              eid=f"{b}-e3-dup"),
        # seq 6 present but seq 5 missing -> missing_sequence anomaly
        event(b, "p_beta", 6, "match_result", tb + timedelta(seconds=90), {"outcome": "loss", "score": 0}),
        event(b, "p_beta", 7, "session_end", tb + timedelta(seconds=91), {"reason": "normal"}),
    ]

    # --- Session C: late arrival after the session ended --------------------
    c = "sess-late-003"
    tc = datetime(2026, 11, 12, 9, 30, 0, tzinfo=timezone.utc)
    late = [
        event(c, "p_gamma", 1, "session_start", tc, {}),
        event(c, "p_gamma", 2, "player_action", tc + timedelta(seconds=6), {"action_type": "assist"}),
        event(c, "p_gamma", 3, "match_result", tc + timedelta(seconds=60), {"outcome": "draw"}),
        event(c, "p_gamma", 4, "session_end", tc + timedelta(seconds=61), {"reason": "normal"}),
    ]
    late_arrival = event(
        c, "p_gamma", 5, "item_pickup", tc + timedelta(seconds=30), {"item_id": "late_item"}
    )

    # --- Bad events that must be rejected without poisoning the batch -------
    bad = [
        # unknown schema version: must not be interpreted as 1.0
        {**event(a, "p_alpha", 99, "position", t0, {"x": 0, "y": 0}, eid="bad-schema"),
         "schema_version": "9.9"},
        # payload violates the type's contract
        event(a, "p_alpha", 98, "item_pickup", t0, {}, eid="bad-payload"),
        # timestamp without timezone
        {**event(a, "p_alpha", 97, "position", t0, {"x": 1, "y": 1}, eid="bad-ts"),
         "occurred_at": "2026-11-10T10:00:00"},
        # negative sequence
        {**event(a, "p_alpha", 96, "position", t0, {"x": 1, "y": 1}, eid="bad-seq"),
         "sequence": -1},
        # malformed: missing required field
        {"event_id": "bad-shape", "session_id": a, "foo": "bar"},
        # client-supplied statistic: extra top-level field is rejected
        {**event(a, "p_alpha", 95, "position", t0, {"x": 1, "y": 1}, eid="bad-extra"),
         "client_summary": {"kdr": 99.0}},
    ]

    return [clean, messy, late, [late_arrival], bad]


def main() -> None:
    client = httpx.Client(base_url=BASE_URL, timeout=10.0)
    client.get("/api/health").raise_for_status()

    clean, messy, late, late_arrival_batch, bad = build_batches()

    print("== 1. clean session (normal order) ==")
    r = client.post("/api/events", json={"events": clean})
    print(json.dumps(r.json(), indent=2))

    print("== 2. messy session: out-of-order, duplicate seq, unknown type, gap ==")
    r = client.post("/api/events", json={"events": messy})
    print(json.dumps(r.json(), indent=2))

    print("== 3. late session: terminal events first ... ==")
    r = client.post("/api/events", json={"events": late})
    print(json.dumps(r.json(), indent=2))
    time.sleep(1.1)  # ensure received_at is strictly after the terminal cutoff
    print("== 4. ... then the delayed event arrives ==")
    r = client.post("/api/events", json={"events": late_arrival_batch})
    print(json.dumps(r.json(), indent=2))

    print("== 5. retry: resend the first clean event, must be idempotent ==")
    r = client.post("/api/events", json={"events": [clean[0]]})
    print(json.dumps(r.json(), indent=2))

    print("== 6. bad events mixed with one good event ==")
    good_dup = clean[1]  # already stored -> duplicate, but proves the batch survives
    r = client.post("/api/events", json={"events": [*bad, good_dup]})
    print(json.dumps(r.json(), indent=2))

    print("\nSeeded sessions: sess-clean-001, sess-messy-002, sess-late-003")
    print(f"Open the UI or: curl {BASE_URL}/api/sessions")


if __name__ == "__main__":
    sys.exit(main())
