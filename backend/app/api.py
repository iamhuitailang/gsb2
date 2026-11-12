"""HTTP API: ingestion, session queries, export, rule reprocessing."""
from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import MAX_BODY_BYTES, RULES_VERSION
from .database import Event, SessionSummary, get_db
from .ingestion import CODE_INVALID_JSON, ingest_batch, recompute_session
from .schemas import BatchResponse

router = APIRouter(prefix="/api")


@router.post("/events", response_model=BatchResponse)
async def submit_events(request: Request, db: Session = Depends(get_db)):
    """Batch event ingestion with per-item acceptance/rejection verdicts."""
    raw_body = await request.body()
    if len(raw_body) > MAX_BODY_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"request body is {len(raw_body)} bytes, "
                f"limit is {MAX_BODY_BYTES} bytes"
            ),
        )
    try:
        body = json.loads(raw_body.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(
            status_code=400,
            detail={"code": CODE_INVALID_JSON, "message": "request body is not valid JSON"},
        )
    if not isinstance(body, dict):
        raise HTTPException(
            status_code=400,
            detail={"code": CODE_INVALID_JSON, "message": "request body must be a JSON object"},
        )

    result = ingest_batch(db, body)
    return result  # type: ignore[return-value]


def _summary_to_dict(row: SessionSummary) -> dict:
    return {
        "session_id": row.session_id,
        "rules_version": row.rules_version,
        "schema_version": row.schema_version,
        "status": row.status,
        "outcome": row.outcome,
        "player_id": row.player_id,
        "started_at": _iso(row.started_at),
        "ended_at": _iso(row.ended_at),
        "duration_seconds": row.duration_seconds,
        "total_events": row.total_events,
        "key_action_count": row.key_action_count,
        "completeness_rate": row.completeness_rate,
        "anomaly_counts": row.anomaly_counts,
        "anomaly_total": sum(row.anomaly_counts.values()),
        "result_hash": row.result_hash,
        "updated_at": _iso(row.updated_at),
    }


def _iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat() if value else None


def _query_sessions(
    db: Session,
    *,
    player_id: str | None = None,
    status: str | None = None,
    outcome: str | None = None,
    date: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    has_anomaly: bool | None = None,
) -> list[SessionSummary]:
    """Shared filter logic for the list API and CSV export."""
    stmt = select(SessionSummary).where(SessionSummary.rules_version == RULES_VERSION)

    if player_id:
        stmt = stmt.where(SessionSummary.player_id == player_id)
    if status:
        stmt = stmt.where(SessionSummary.status == status)
    if outcome:
        stmt = stmt.where(SessionSummary.outcome == outcome)

    date_filters = _date_bounds(date, start_date, end_date)
    if date_filters:
        low, high = date_filters
        stmt = stmt.where(SessionSummary.started_at >= low, SessionSummary.started_at < high)

    stmt = stmt.order_by(SessionSummary.started_at.desc().nullslast(), SessionSummary.session_id)

    rows = db.execute(stmt).scalars().all()
    if has_anomaly is not None:
        rows = [r for r in rows if (sum(r.anomaly_counts.values()) > 0) == has_anomaly]
    return list(rows)


@router.get("/sessions")
def list_sessions(
    player_id: str | None = Query(None),
    status: str | None = Query(None, pattern="^(open|completed)$"),
    outcome: str | None = Query(None, pattern="^(win|loss|draw)$"),
    date: str | None = Query(None, description="UTC date YYYY-MM-DD, matched on started_at"),
    start_date: str | None = Query(None, description="UTC YYYY-MM-DD inclusive"),
    end_date: str | None = Query(None, description="UTC YYYY-MM-DD inclusive"),
    has_anomaly: bool | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    db: Session = Depends(get_db),
):
    all_rows = _query_sessions(
        db,
        player_id=player_id,
        status=status,
        outcome=outcome,
        date=date,
        start_date=start_date,
        end_date=end_date,
        has_anomaly=has_anomaly,
    )

    total = len(all_rows)
    offset = (page - 1) * page_size
    page_rows = all_rows[offset : offset + page_size]

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "rules_version": RULES_VERSION,
        "items": [_summary_to_dict(r) for r in page_rows],
    }


def _date_bounds(date: str | None, start_date: str | None, end_date: str | None):
    low = high = None
    if date:
        low = _parse_date(date)
        high = low + timedelta(days=1)
        return low, high
    if start_date:
        low = _parse_date(start_date)
    if end_date:
        high = _parse_date(end_date) + timedelta(days=1)
    if low or high:
        return low or datetime.min.replace(tzinfo=timezone.utc), high or datetime.max.replace(
            tzinfo=timezone.utc
        )
    return None


def _parse_date(text: str) -> datetime:
    try:
        return datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"invalid date '{text}', use YYYY-MM-DD")


@router.get("/sessions/{session_id}")
def get_session(session_id: str, db: Session = Depends(get_db)):
    row = db.execute(
        select(SessionSummary).where(
            SessionSummary.session_id == session_id,
            SessionSummary.rules_version == RULES_VERSION,
        )
    ).scalar_one_or_none()
    if row is None:
        # Maybe raw events exist but were never summarized under current rules.
        event_count = db.execute(
            select(Event.id).where(Event.session_id == session_id).limit(1)
        ).first()
        if event_count is None:
            raise HTTPException(status_code=404, detail="session not found")
        row = _get_or_recompute(db, session_id)

    return {
        **_summary_to_dict(row),
        "metrics": json.loads(row.metrics_json),
        "timeline": json.loads(row.timeline_json),
    }


def _get_or_recompute(db: Session, session_id: str) -> SessionSummary:
    result = recompute_session(db, session_id)
    db.commit()
    row = db.execute(
        select(SessionSummary).where(
            SessionSummary.session_id == session_id,
            SessionSummary.rules_version == RULES_VERSION,
        )
    ).scalar_one()
    return row


@router.get("/sessions/{session_id}/raw")
def get_raw_events(session_id: str, db: Session = Depends(get_db)):
    rows = db.execute(
        select(Event)
        .where(Event.session_id == session_id)
        .order_by(Event.received_at, Event.id)
    ).scalars().all()
    if not rows:
        raise HTTPException(status_code=404, detail="session not found")
    return {
        "session_id": session_id,
        "order": "reception_order",
        "events": [
            {
                "event_id": r.event_id,
                "session_id": r.session_id,
                "player_id": r.player_id,
                "event_type": r.event_type,
                "occurred_at": _iso(r.occurred_at),
                "sequence": r.sequence,
                "schema_version": r.schema_version,
                "payload": json.loads(r.payload_json),
                "received_at": _iso(r.received_at),
            }
            for r in rows
        ],
    }


@router.get("/players")
def list_players(db: Session = Depends(get_db)):
    rows = db.execute(
        select(SessionSummary.player_id)
        .where(SessionSummary.rules_version == RULES_VERSION)
        .distinct()
        .order_by(SessionSummary.player_id)
    ).scalars().all()
    return {"players": rows}


@router.get("/export/sessions.csv")
def export_sessions_csv(
    player_id: str | None = None,
    status: str | None = None,
    outcome: str | None = None,
    date: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    has_anomaly: bool | None = None,
    db: Session = Depends(get_db),
):
    """Export exactly what the current filter shows (same query as /sessions)."""
    rows = _query_sessions(
        db,
        player_id=player_id,
        status=status,
        outcome=outcome,
        date=date,
        start_date=start_date,
        end_date=end_date,
        has_anomaly=has_anomaly,
    )
    buffer = io.StringIO()
    columns = [
        "session_id", "player_id", "status", "outcome", "started_at", "ended_at",
        "duration_seconds", "total_events", "key_action_count", "completeness_rate",
        "anomaly_total", "rules_version", "result_hash",
    ]
    writer = csv.DictWriter(buffer, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow(_summary_to_dict(row))

    filename = f"sessions_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.csv"
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/sessions/{session_id}/reprocess")
def reprocess_session(session_id: str, db: Session = Depends(get_db)):
    """Re-run the current rules over stored raw events for one session."""
    exists = db.execute(
        select(Event.id).where(Event.session_id == session_id).limit(1)
    ).first()
    if not exists:
        raise HTTPException(status_code=404, detail="session not found")
    result = recompute_session(db, session_id)
    db.commit()
    return {
        "session_id": session_id,
        "rules_version": RULES_VERSION,
        "result_hash": result["result_hash"],
        "reprocessed": True,
    }
