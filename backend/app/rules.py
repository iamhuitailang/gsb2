"""Versioned processing rules.

RULES_VERSION identifies *this* module's behaviour. Every stored summary keeps
the rules_version it was produced with, so changing a formula here and bumping
the version makes old vs. new results distinguishable instead of silently
overwriting history.

Determinism contract: ``rebuild_session`` is a pure function of the stored raw
events plus RULES_VERSION. Wall-clock reception metadata (received_at) is only
used for the informational ``late_arrival`` / ``out_of_order_arrival`` flags and
is deliberately excluded from ``result_hash``.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .config import RULES_VERSION, SUPPORTED_SCHEMA_VERSIONS

# --- Event vocabulary for schema_version 1.0 --------------------------------

KNOWN_EVENT_TYPES = {
    "session_start",
    "player_action",
    "item_pickup",
    "position",
    "match_result",
    "session_end",
}

TERMINAL_EVENT_TYPES = {"match_result", "session_end"}

# player_action.action_type values counted as "key actions".
KEY_ACTION_TYPES = {"kill", "assist", "objective", "capture", "purchase"}

VALID_OUTCOMES = {"win", "loss", "draw"}

# Payload requirements per known event type:
#   field -> (required, python type)
PAYLOAD_SCHEMAS: dict[str, dict[str, tuple[bool, type | tuple[type, ...]]]] = {
    "session_start": {"mode": (False, str), "map": (False, str)},
    "player_action": {"action_type": (True, str)},
    "item_pickup": {"item_id": (True, str)},
    "position": {"x": (True, (int, float)), "y": (True, (int, float))},
    "match_result": {"outcome": (True, str), "score": (False, (int, float))},
    "session_end": {"reason": (False, str)},
}

ANOMALY_TYPES = (
    "missing_sequence",
    "duplicate_sequence",
    "time_regression",
    "unknown_event_type",
    "late_arrival",
    "out_of_order_arrival",
)


@dataclass
class StoredEvent:
    """Minimal event shape the engine consumes (decoupled from ORM)."""

    event_id: str
    session_id: str
    player_id: str
    event_type: str
    occurred_at: datetime
    sequence: int
    schema_version: str
    payload: dict[str, Any]
    received_at: datetime
    # Monotonic insertion order (the events-table row id). It disambiguates
    # events ingested in the same batch, which share one received_at.
    ingest_id: int = 0


def validate_payload(event_type: str, payload: Any) -> str | None:
    """Validate the payload of a *known* event type.

    Returns ``None`` when valid, otherwise a human-readable rejection reason.
    Unknown event types have no schema here; they are accepted at ingestion and
    flagged as ``unknown_event_type`` during timeline rebuild.
    """
    if not isinstance(payload, dict):
        return "payload must be an object"

    schema = PAYLOAD_SCHEMAS.get(event_type)
    if schema is None:
        return None  # unknown type: no payload contract to enforce

    for field, (required, expected_type) in schema.items():
        if field not in payload:
            if required:
                return f"payload.{field} is required for event_type '{event_type}'"
            continue
        value = payload[field]
        if isinstance(expected_type, tuple):
            if not isinstance(value, expected_type) or isinstance(value, bool):
                return f"payload.{field} has wrong type"
        elif not isinstance(value, expected_type):
            return f"payload.{field} has wrong type"

    if event_type == "match_result" and payload.get("outcome") not in VALID_OUTCOMES:
        return f"payload.outcome must be one of {sorted(VALID_OUTCOMES)}"

    return None


def _canonical_event_json(ev: StoredEvent) -> dict[str, Any]:
    return {
        "event_id": ev.event_id,
        "session_id": ev.session_id,
        "player_id": ev.player_id,
        "event_type": ev.event_type,
        "occurred_at": ev.occurred_at.astimezone(timezone.utc).isoformat(),
        "sequence": ev.sequence,
        "schema_version": ev.schema_version,
        "payload": ev.payload,
    }


_UTC = timezone.utc


def compute_result_hash(events: list[StoredEvent], rules_version: str) -> str:
    """Stable hash over canonical raw events + rule version.

    Same raw events and same rule version always hash identically, regardless
    of insert order, reception time or Python dict ordering.
    """
    canonical = sorted(
        (_canonical_event_json(ev) for ev in events),
        key=lambda e: e["event_id"],
    )
    blob = json.dumps(
        {"rules_version": rules_version, "events": canonical},
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def rebuild_session(
    session_id: str, events: list[StoredEvent], rules_version: str = RULES_VERSION
) -> dict[str, Any]:
    """Rebuild one session's timeline, anomalies and metrics from raw events."""
    anomaly_counts: dict[str, int] = {key: 0 for key in ANOMALY_TYPES}

    if not events:
        return {
            "session_id": session_id,
            "rules_version": rules_version,
            "status": "open",
            "outcome": None,
            "anomaly_counts": anomaly_counts,
            "timeline": [],
            "metrics": {},
            "result_hash": compute_result_hash([], rules_version),
        }

    # Deterministic ordering: sequence first, then occurred_at, then event_id.
    ordered = sorted(
        events,
        key=lambda e: (e.sequence, e.occurred_at, e.event_id),
    )

    # --- Sequence-based anomalies -------------------------------------------
    seen_sequences: dict[int, int] = {}
    for ev in ordered:
        seen_sequences[ev.sequence] = seen_sequences.get(ev.sequence, 0) + 1

    duplicate_sequences = {seq for seq, count in seen_sequences.items() if count > 1}
    anomaly_counts["duplicate_sequence"] = sum(c - 1 for c in seen_sequences.values() if c > 1)

    min_seq, max_seq = min(seen_sequences), max(seen_sequences)
    expected_range = set(range(min_seq, max_seq + 1))
    missing_sequences = sorted(expected_range - set(seen_sequences))
    anomaly_counts["missing_sequence"] = len(missing_sequences)

    # --- Reception-order anomalies -------------------------------------------
    # Arrival order is received_at, then insertion order within the same
    # batch, then event_id as a final deterministic tiebreak.
    arrival_order = sorted(events, key=lambda e: (e.received_at, e.ingest_id, e.event_id))
    arrival_rank = {ev.event_id: rank for rank, ev in enumerate(arrival_order)}

    # A "late" event arrives after the session's first terminal event was
    # received. Sessions without a terminal event cannot have late arrivals.
    terminal_received = [
        ev.received_at for ev in arrival_order if ev.event_type in TERMINAL_EVENT_TYPES
    ]
    terminal_cutoff = min(terminal_received) if terminal_received else None

    # --- Walk the timeline ---------------------------------------------------
    timeline: list[dict[str, Any]] = []
    previous_occurred_at: datetime | None = None
    previous_arrival_rank: int | None = None
    key_action_count = 0
    event_type_counts: dict[str, int] = {}
    key_action_breakdown: dict[str, int] = {}
    outcome: str | None = None

    for ev in ordered:
        flags: list[str] = []

        if ev.event_type not in KNOWN_EVENT_TYPES:
            flags.append("unknown_event_type")
            anomaly_counts["unknown_event_type"] += 1

        if ev.sequence in duplicate_sequences and seen_sequences[ev.sequence] > 1:
            flags.append("duplicate_sequence")

        if previous_occurred_at is not None and ev.occurred_at < previous_occurred_at:
            flags.append("time_regression")
            anomaly_counts["time_regression"] += 1

        rank = arrival_rank[ev.event_id]
        if previous_arrival_rank is not None and rank < previous_arrival_rank:
            flags.append("out_of_order_arrival")
            anomaly_counts["out_of_order_arrival"] += 1

        # Late arrival: a non-terminal event that logically belongs to the
        # session but was received only after the first terminal event.
        # Terminal events themselves are never marked late.
        if (
            ev.event_type not in TERMINAL_EVENT_TYPES
            and terminal_cutoff is not None
            and ev.received_at > terminal_cutoff
        ):
            flags.append("late_arrival")
            anomaly_counts["late_arrival"] += 1

        if ev.event_type == "player_action":
            action = ev.payload.get("action_type")
            if action in KEY_ACTION_TYPES:
                key_action_count += 1
                key_action_breakdown[action] = key_action_breakdown.get(action, 0) + 1

        if ev.event_type == "match_result":
            outcome = ev.payload.get("outcome")

        event_type_counts[ev.event_type] = event_type_counts.get(ev.event_type, 0) + 1

        timeline.append(
            {
                "event_id": ev.event_id,
                "event_type": ev.event_type,
                "sequence": ev.sequence,
                "player_id": ev.player_id,
                "occurred_at": ev.occurred_at.astimezone(_UTC).isoformat(),
                "received_at": ev.received_at.astimezone(_UTC).isoformat(),
                "schema_version": ev.schema_version,
                "payload": ev.payload,
                "flags": flags,
                "is_key_action": (
                    ev.event_type == "player_action"
                    and ev.payload.get("action_type") in KEY_ACTION_TYPES
                ),
            }
        )

        previous_occurred_at = ev.occurred_at
        previous_arrival_rank = rank

    # --- Metrics --------------------------------------------------------------
    start_event = next((ev for ev in ordered if ev.event_type == "session_start"), None)
    end_event = next(
        (ev for ev in reversed(ordered) if ev.event_type in TERMINAL_EVENT_TYPES), None
    )

    if start_event is not None and end_event is not None and end_event is not start_event:
        started_at = start_event.occurred_at
        ended_at = end_event.occurred_at
    else:
        started_at = min(ev.occurred_at for ev in ordered)
        ended_at = max(ev.occurred_at for ev in ordered)

    duration_seconds = max(0.0, (ended_at - started_at).total_seconds())

    span = max_seq - min_seq + 1
    completeness_rate = len(seen_sequences) / span if span > 0 else 1.0

    has_terminal = any(ev.event_type in TERMINAL_EVENT_TYPES for ev in ordered)
    status = "completed" if has_terminal else "open"

    player_ids = sorted({ev.player_id for ev in ordered})
    schema_versions = sorted({ev.schema_version for ev in ordered})

    metrics = {
        "missing_sequences": missing_sequences,
        "sequence_range": {"min": min_seq, "max": max_seq},
        "unique_sequences": len(seen_sequences),
        "event_type_counts": event_type_counts,
        "key_action_breakdown": key_action_breakdown,
        "player_ids": player_ids,
        "schema_versions": schema_versions,
    }

    return {
        "session_id": session_id,
        "rules_version": rules_version,
        "schema_version": schema_versions[0] if len(schema_versions) == 1 else None,
        "status": status,
        "outcome": outcome,
        "player_id": player_ids[0],
        "started_at": started_at.astimezone(_UTC).isoformat(),
        "ended_at": ended_at.astimezone(_UTC).isoformat(),
        "duration_seconds": round(duration_seconds, 3),
        "total_events": len(ordered),
        "key_action_count": key_action_count,
        "completeness_rate": round(completeness_rate, 6),
        "anomaly_counts": anomaly_counts,
        "anomaly_total": sum(anomaly_counts.values()),
        "metrics": metrics,
        "timeline": timeline,
        "result_hash": compute_result_hash(events, rules_version),
    }
