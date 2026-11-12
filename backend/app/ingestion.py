"""Ingestion service: per-event validation, idempotent insert, re-derivation."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import rules
from .config import MAX_BATCH_EVENTS, RULES_VERSION, SUPPORTED_SCHEMA_VERSIONS
from .database import Event, SessionSummary, utcnow
from .schemas import ItemResult

# Rejection / dedup codes. Kept stable so clients can branch on them.
CODE_INVALID_JSON = "invalid_json"
CODE_MALFORMED = "malformed_event"
CODE_BATCH_LIMIT = "batch_limit_exceeded"
CODE_UNSUPPORTED_SCHEMA = "unsupported_schema_version"
CODE_BAD_TIMESTAMP = "bad_timestamp"
CODE_BAD_SEQUENCE = "bad_sequence"
CODE_PAYLOAD_REJECTED = "payload_rejected"
CODE_DUPLICATE_EVENT_ID = "duplicate_event_id"
CODE_DUPLICATE_IN_BATCH = "duplicate_in_batch"
CODE_ACCEPTED = "accepted"


def _parse_occurred_at(raw: str) -> datetime:
    """Parse ISO-8601, requiring a timezone so ordering is unambiguous."""
    text = raw.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        raise ValueError("occurred_at must include a timezone offset")
    return dt.astimezone(timezone.utc)


def _validate_one(raw: dict) -> tuple[dict | None, ItemResult]:
    """Validate a single raw event dict. Returns (clean_dict, result)."""
    event_id = raw.get("event_id") if isinstance(raw, dict) else None

    # Structural validation through Pydantic.
    try:
        parsed = EventInShim.model_validate(raw)
    except Exception as exc:  # pydantic.ValidationError
        return None, ItemResult(
            event_id=event_id if isinstance(event_id, str) else None,
            accepted=False,
            reason=_shorten(str(exc)),
            code=CODE_MALFORMED,
        )

    if parsed.schema_version not in SUPPORTED_SCHEMA_VERSIONS:
        return None, ItemResult(
            event_id=parsed.event_id,
            accepted=False,
            reason=(
                f"schema_version '{parsed.schema_version}' is not supported; "
                f"supported: {sorted(SUPPORTED_SCHEMA_VERSIONS)}"
            ),
            code=CODE_UNSUPPORTED_SCHEMA,
        )

    try:
        occurred_at = _parse_occurred_at(parsed.occurred_at)
    except (ValueError, TypeError):
        return None, ItemResult(
            event_id=parsed.event_id,
            accepted=False,
            reason="occurred_at must be ISO-8601 with a timezone offset",
            code=CODE_BAD_TIMESTAMP,
        )

    if not isinstance(parsed.sequence, int) or isinstance(parsed.sequence, bool) or parsed.sequence < 0:
        return None, ItemResult(
            event_id=parsed.event_id,
            accepted=False,
            reason="sequence must be a non-negative integer",
            code=CODE_BAD_SEQUENCE,
        )

    payload_reason = rules.validate_payload(parsed.event_type, parsed.payload)
    if payload_reason is not None:
        return None, ItemResult(
            event_id=parsed.event_id,
            accepted=False,
            reason=payload_reason,
            code=CODE_PAYLOAD_REJECTED,
        )

    clean = {
        "event_id": parsed.event_id,
        "session_id": parsed.session_id,
        "player_id": parsed.player_id,
        "event_type": parsed.event_type,
        "occurred_at": occurred_at,
        "sequence": parsed.sequence,
        "schema_version": parsed.schema_version,
        "payload": parsed.payload,
    }
    return clean, ItemResult(
        event_id=parsed.event_id, accepted=True, reason=None, code=CODE_ACCEPTED
    )


def _shorten(text: str, limit: int = 300) -> str:
    return text if len(text) <= limit else text[: limit - 3] + "..."


# Imported lazily as an alias to avoid a circular import at module load.
from .schemas import EventIn as EventInShim  # noqa: E402


def ingest_batch(db: Session, body: dict) -> dict:
    """Process a batch dict. One bad event never fails the whole batch."""
    raw_events = body.get("events")
    if not isinstance(raw_events, list):
        return {
            "accepted": 0,
            "rejected": 0,
            "duplicate": 0,
            "results": [
                ItemResult(
                    accepted=False, reason="body must contain an 'events' array",
                    code=CODE_MALFORMED,
                )
            ],
            "session_ids": [],
        }

    if len(raw_events) > MAX_BATCH_EVENTS:
        return {
            "accepted": 0,
            "rejected": len(raw_events),
            "duplicate": 0,
            "results": [
                ItemResult(
                    event_id=(ev.get("event_id") if isinstance(ev, dict) else None),
                    accepted=False,
                    reason=f"batch exceeds limit of {MAX_BATCH_EVENTS} events",
                    code=CODE_BATCH_LIMIT,
                )
                for ev in raw_events
            ],
            "session_ids": [],
        }

    now = utcnow()
    results: list[ItemResult] = []
    clean_events: list[dict] = []
    seen_in_batch: set[str] = set()
    affected_sessions: set[str] = set()
    duplicate_count = 0

    for raw in raw_events:
        clean, result = _validate_one(raw if isinstance(raw, dict) else {})
        if clean is None:
            results.append(result)
            continue

        # Duplicate within this same batch: first wins, rest are rejected.
        if clean["event_id"] in seen_in_batch:
            duplicate_count += 1
            results.append(
                ItemResult(
                    event_id=clean["event_id"],
                    accepted=False,
                    reason="event_id already submitted earlier in this batch",
                    code=CODE_DUPLICATE_IN_BATCH,
                )
            )
            continue

        # Idempotency against already-stored events: re-submission is reported
        # as a duplicate, never counted twice.
        exists = db.execute(
            select(Event.id).where(Event.event_id == clean["event_id"])
        ).first()
        if exists is not None:
            duplicate_count += 1
            results.append(
                ItemResult(
                    event_id=clean["event_id"],
                    accepted=False,
                    reason="event_id already stored; resubmission ignored (idempotent)",
                    code=CODE_DUPLICATE_EVENT_ID,
                )
            )
            continue

        seen_in_batch.add(clean["event_id"])
        clean_events.append(clean)
        affected_sessions.add(clean["session_id"])
        results.append(result)

    if clean_events:
        db.add_all(
            [
                Event(
                    event_id=c["event_id"],
                    session_id=c["session_id"],
                    player_id=c["player_id"],
                    event_type=c["event_type"],
                    occurred_at=c["occurred_at"],
                    sequence=c["sequence"],
                    schema_version=c["schema_version"],
                    payload_json=json.dumps(c["payload"], sort_keys=True, ensure_ascii=False),
                    received_at=now,
                    is_canonical=True,
                )
                for c in clean_events
            ]
        )
        db.flush()

        # Re-derive every affected session synchronously so reads never see a
        # state where events are stored but metrics are stale.
        for session_id in affected_sessions:
            recompute_session(db, session_id)

    db.commit()

    return {
        "accepted": sum(1 for r in results if r.accepted),
        "rejected": sum(1 for r in results if not r.accepted) - duplicate_count,
        "duplicate": duplicate_count,
        "results": results,
        "session_ids": sorted(affected_sessions),
    }


def _load_stored_events(db: Session, session_id: str) -> list[rules.StoredEvent]:
    rows = db.execute(
        select(Event).where(Event.session_id == session_id)
    ).scalars().all()
    return [
        rules.StoredEvent(
            event_id=row.event_id,
            session_id=row.session_id,
            player_id=row.player_id,
            event_type=row.event_type,
            occurred_at=row.occurred_at,
            sequence=row.sequence,
            schema_version=row.schema_version,
            payload=json.loads(row.payload_json),
            received_at=row.received_at,
            ingest_id=row.id,
        )
        for row in rows
    ]


def recompute_session(db: Session, session_id: str) -> dict:
    """Rebuild one session's summary under the current RULES_VERSION."""
    stored = _load_stored_events(db, session_id)
    result = rules.rebuild_session(session_id, stored, RULES_VERSION)

    existing = db.execute(
        select(SessionSummary).where(
            SessionSummary.session_id == session_id,
            SessionSummary.rules_version == RULES_VERSION,
        )
    ).scalar_one_or_none()

    if existing is None:
        existing = SessionSummary(
            session_id=session_id, rules_version=RULES_VERSION
        )
        db.add(existing)

    existing.schema_version = result.get("schema_version")
    existing.status = result["status"]
    existing.outcome = result["outcome"]
    existing.player_id = result["player_id"]
    existing.started_at = _parse_iso(result.get("started_at"))
    existing.ended_at = _parse_iso(result.get("ended_at"))
    existing.duration_seconds = result["duration_seconds"]
    existing.total_events = result["total_events"]
    existing.key_action_count = result["key_action_count"]
    existing.completeness_rate = result["completeness_rate"]
    existing.anomaly_counts = result["anomaly_counts"]
    existing.metrics_json = json.dumps(result["metrics"], sort_keys=True, ensure_ascii=False)
    existing.timeline_json = json.dumps(result["timeline"], sort_keys=True, ensure_ascii=False)
    existing.result_hash = result["result_hash"]
    existing.updated_at = utcnow()
    db.flush()
    return result


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value)
