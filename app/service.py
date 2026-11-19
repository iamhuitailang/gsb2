"""Core business rules: batch ingestion, window aggregates and recomputation.

Concurrency model
-----------------
Every write affecting one device holds that device's exclusive lock, so two
batches containing the same (device, reading) are serialized end to end.
Different devices keep processing in parallel. SQLite itself serializes the
physical writes (BEGIN IMMEDIATE), and each batch commits its received
versions, the current-reading pointers and the affected window rows in a
single transaction, so a partially applied batch is never visible.

A recomputation job takes the device lock for its whole run. Any batch for the
same device that arrives while the job runs therefore waits, and is processed
after the job finishes -- its new versions are consequently included in the
final stored windows. Other devices are never blocked.
"""
from __future__ import annotations

import json
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from .db import get_conn

NEW = "new"
CORRECTION = "correction"
DUPLICATE = "duplicate"
STALE = "stale"
CONFLICT = "conflict"
INVALID = "invalid"

WINDOW_MINUTES = 5

# Per-device locks and the lock guarding the dict itself.
_device_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()

# Test seam: invoked inside recompute_device_range while the device lock is
# held, so tests can start an overlapping ingestion deterministically.
recompute_sync_hook: Optional[Any] = None


def _device_lock(device_id: str) -> threading.Lock:
    with _locks_guard:
        lock = _device_locks.get(device_id)
        if lock is None:
            lock = threading.Lock()
            _device_locks[device_id] = lock
        return lock


# --------------------------------------------------------------------------- #
# Time helpers
# --------------------------------------------------------------------------- #
def parse_instant(value: Any) -> datetime:
    """Parse an ISO-8601 instant, normalize to aware UTC.

    Naive strings are interpreted as UTC; a 'Z' suffix is accepted.
    """
    if not isinstance(value, str):
        raise ValueError("measured_at must be an ISO-8601 string")
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def window_start_for(instant: datetime) -> datetime:
    """Floor an instant to its five-minute window start (UTC).

    An instant exactly on a boundary belongs to the window starting at that
    boundary, i.e. the later of the two neighbouring groups.
    """
    instant = instant.astimezone(timezone.utc)
    floored_minute = (instant.minute // WINDOW_MINUTES) * WINDOW_MINUTES
    return instant.replace(minute=floored_minute, second=0, microsecond=0)


def window_iso(instant: datetime) -> str:
    return iso(window_start_for(instant))


# --------------------------------------------------------------------------- #
# Window maintenance
# --------------------------------------------------------------------------- #
def _recompute_window(conn, device_id: str, window_start: str) -> Optional[dict]:
    """Recompute one window from the retained current readings.

    Returns the new aggregate dict, or None when the window became empty.
    """
    row = conn.execute(
        """
        SELECT COUNT(*) AS cnt,
               MIN(temperature) AS min_temp,
               MAX(temperature) AS max_temp,
               SUM(temperature) AS sum_temp
        FROM current_readings
        WHERE device_id = ? AND window_start = ?
        """,
        (device_id, window_start),
    ).fetchone()

    if row["cnt"] == 0:
        conn.execute(
            "DELETE FROM windows WHERE device_id = ? AND window_start = ?",
            (device_id, window_start),
        )
        return None

    agg = {
        "device_id": device_id,
        "window_start": window_start,
        "count": row["cnt"],
        "min_temp": row["min_temp"],
        "max_temp": row["max_temp"],
        "sum_temp": row["sum_temp"],
        "avg_temp": row["sum_temp"] / row["cnt"],
    }
    conn.execute(
        """
        INSERT INTO windows (device_id, window_start, count, min_temp, max_temp,
                             sum_temp, avg_temp)
        VALUES (:device_id, :window_start, :count, :min_temp, :max_temp,
                :sum_temp, :avg_temp)
        ON CONFLICT(device_id, window_start) DO UPDATE SET
            count=excluded.count, min_temp=excluded.min_temp,
            max_temp=excluded.max_temp, sum_temp=excluded.sum_temp,
            avg_temp=excluded.avg_temp
        """,
        agg,
    )
    return agg


# --------------------------------------------------------------------------- #
# Ingestion
# --------------------------------------------------------------------------- #
def _validate_record(record: Any) -> dict:
    if not isinstance(record, dict):
        raise ValueError("record must be an object")
    missing = [k for k in ("device_id", "reading_id", "version", "measured_at", "temperature")
               if k not in record]
    if missing:
        raise ValueError(f"missing fields: {', '.join(missing)}")
    device_id = record["device_id"]
    reading_id = record["reading_id"]
    if not isinstance(device_id, str) or not device_id:
        raise ValueError("device_id must be a non-empty string")
    if not isinstance(reading_id, str) or not reading_id:
        raise ValueError("reading_id must be a non-empty string")
    version = record["version"]
    if isinstance(version, bool) or not isinstance(version, int):
        raise ValueError("version must be an integer")
    if version < 1:
        raise ValueError("version must be >= 1")
    instant = parse_instant(record["measured_at"])
    temperature = record["temperature"]
    if isinstance(temperature, bool) or not isinstance(temperature, (int, float)):
        raise ValueError("temperature must be a number")
    return {
        "device_id": device_id,
        "reading_id": reading_id,
        "version": version,
        "instant": instant,
        "temperature": float(temperature),
        "measured_at_raw": record["measured_at"],
    }


def _ingest_one(conn, batch_id: int, received_at: str, raw: Any) -> dict:
    """Process one record inside the open batch transaction."""
    try:
        rec = _validate_record(raw)
    except (ValueError, TypeError) as exc:
        item_cur = conn.execute(
            """INSERT INTO batch_items (batch_id, device_id, reading_id, version,
                                        classification, detail)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (batch_id, str(raw.get("device_id", "?")) if isinstance(raw, dict) else "?",
             str(raw.get("reading_id", "?")) if isinstance(raw, dict) else "?",
             raw.get("version", -1) if isinstance(raw, dict) else -1,
             INVALID, str(exc)),
        )
        return {"classification": INVALID, "batch_item_id": item_cur.lastrowid}

    device_id = rec["device_id"]
    reading_id = rec["reading_id"]
    version = rec["version"]
    instant = rec["instant"]
    temperature = rec["temperature"]
    measured_iso = iso(instant)
    win = window_iso(instant)

    existing_version_row = conn.execute(
        "SELECT id FROM readings WHERE device_id=? AND reading_id=? AND version=?",
        (device_id, reading_id, version),
    ).fetchone()

    current_row = conn.execute(
        "SELECT * FROM current_readings WHERE device_id=? AND reading_id=?",
        (device_id, reading_id),
    ).fetchone()

    classification: str
    reading_pk: Optional[int] = None
    detail: Optional[str] = None
    affected_windows: set[str] = set()

    if existing_version_row is not None:
        # This version number was received before.
        existing = conn.execute(
            "SELECT * FROM readings WHERE id=?",
            (existing_version_row["id"],),
        ).fetchone()
        same_content = (
            existing["temperature"] == temperature
            and existing["measured_at"] == measured_iso
        )
        if same_content:
            # Exact retransmission: duplicate, nothing changes.
            classification = DUPLICATE
            reading_pk = existing["id"]
        else:
            # Same version, different content: conflict. Keep the already
            # received version, do not store or apply the incoming one.
            classification = CONFLICT
            detail = json.dumps(
                {
                    "existing": {
                        "version": version,
                        "measured_at": existing["measured_at"],
                        "measured_at_raw": existing["measured_at_raw"],
                        "temperature": existing["temperature"],
                        "received_at": existing["received_at"],
                    },
                    "incoming": {
                        "version": version,
                        "measured_at": measured_iso,
                        "measured_at_raw": rec["measured_at_raw"],
                        "temperature": temperature,
                    },
                },
                ensure_ascii=False,
            )
    elif current_row is not None and version <= current_row["version"]:
        # A newer version already wins: a late old version must not overwrite.
        classification = STALE
        cur = conn.execute(
            """INSERT INTO readings (device_id, reading_id, version, measured_at,
                                     measured_at_raw, temperature, received_at,
                                     batch_id, classification)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (device_id, reading_id, version, measured_iso, rec["measured_at_raw"],
             temperature, received_at, batch_id, STALE),
        )
        reading_pk = cur.lastrowid
    else:
        is_correction = current_row is not None
        classification = CORRECTION if is_correction else NEW
        cur = conn.execute(
            """INSERT INTO readings (device_id, reading_id, version, measured_at,
                                     measured_at_raw, temperature, received_at,
                                     batch_id, classification)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (device_id, reading_id, version, measured_iso, rec["measured_at_raw"],
             temperature, received_at, batch_id, classification),
        )
        reading_pk = cur.lastrowid

        if is_correction:
            old_window = current_row["window_start"]
            # Move the reading out of the old window (and later into the new one).
            conn.execute(
                "DELETE FROM current_readings WHERE device_id=? AND reading_id=?",
                (device_id, reading_id),
            )
            # Recompute immediately: if this reading held the min/max (or was
            # the last reading), the old window must reflect its removal.
            _recompute_window(conn, device_id, old_window)
            affected_windows.add(old_window)

        conn.execute(
            """INSERT INTO current_readings (device_id, reading_id, reading_pk,
                                             version, window_start, measured_at,
                                             temperature)
               VALUES (?,?,?,?,?,?,?)""",
            (device_id, reading_id, reading_pk, version, win, measured_iso,
             temperature),
        )
        affected_windows.add(win)

    item_cur = conn.execute(
        """INSERT INTO batch_items (batch_id, device_id, reading_id, version,
                                    classification, reading_pk, detail)
           VALUES (?,?,?,?,?,?,?)""",
        (batch_id, device_id, reading_id, version, classification, reading_pk,
         detail),
    )

    for w in affected_windows:
        _recompute_window(conn, device_id, w)

    return {
        "classification": classification,
        "device_id": device_id,
        "batch_item_id": item_cur.lastrowid,
    }


def ingest_batch(records: list[dict], note: Optional[str] = None) -> dict:
    """Accept one batch and apply it under per-device locks.

    Returns the batch id and per-classification counts.
    """
    received_at = iso(datetime.now(timezone.utc))

    # Locks first, write transaction second: a batch overlapping a running
    # recomputation waits on the lock instead of holding a SQLite write lock.
    devices = sorted(
        {
            r["device_id"]
            for r in records
            if isinstance(r, dict) and isinstance(r.get("device_id"), str) and r["device_id"]
        }
    )
    locks = [_device_lock(d) for d in devices]
    for lock in locks:
        lock.acquire()

    conn = get_conn()
    try:
        conn.execute("BEGIN IMMEDIATE")
        cur = conn.execute(
            "INSERT INTO batches (received_at, note) VALUES (?, ?)",
            (received_at, note),
        )
        batch_id = cur.lastrowid

        try:
            counts = {NEW: 0, CORRECTION: 0, DUPLICATE: 0, STALE: 0,
                      CONFLICT: 0, INVALID: 0}
            conflicts: list[dict] = []
            for raw in records:
                result = _ingest_one(conn, batch_id, received_at, raw)
                counts[result["classification"]] += 1
                if result["classification"] == CONFLICT:
                    item = conn.execute(
                        "SELECT * FROM batch_items WHERE id=?",
                        (result["batch_item_id"],),
                    ).fetchone()
                    conflicts.append(
                        {
                            "device_id": item["device_id"],
                            "reading_id": item["reading_id"],
                            "version": item["version"],
                            "detail": json.loads(item["detail"]),
                        }
                    )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

        return {
            "batch_id": batch_id,
            "received_at": received_at,
            "counts": counts,
            "conflicts": conflicts,
        }
    finally:
        conn.close()
        for lock in locks:
            lock.release()


# --------------------------------------------------------------------------- #
# Recomputation
# --------------------------------------------------------------------------- #
def recompute_device_range(device_id: str, start_instant: datetime,
                           end_instant: datetime) -> dict:
    """Recompute stored windows of one device over a half-open UTC range.

    Runs with the device lock held for the whole job, so overlapping batches
    for this device wait and are applied afterwards; other devices keep
    accepting data. Only windows inside [start, end) may be touched.
    """
    # Half-open range [start_instant, end_instant), snapped out to window
    # boundaries. A boundary exactly at the end is excluded; an end falling
    # inside a window means that whole window is covered.
    start = window_start_for(start_instant)
    end_utc = end_instant.astimezone(timezone.utc)
    step = timedelta(minutes=WINDOW_MINUTES)

    lock = _device_lock(device_id)
    lock.acquire()
    conn = get_conn()
    try:
        conn.execute("BEGIN IMMEDIATE")
        started_at = iso(datetime.now(timezone.utc))
        job_row = conn.execute(
            """INSERT INTO recompute_jobs (device_id, window_start, window_end,
                                           started_at, status)
               VALUES (?,?,?,?, 'running')""",
            (device_id, iso(start), iso(end_utc), started_at),
        )
        job_id = job_row.lastrowid

        if recompute_sync_hook is not None:
            recompute_sync_hook(device_id, job_id)

        covered: list[str] = []
        changes: list[dict] = []

        # Rebuild every covered boundary strictly from retained raw versions.
        cur_dt = start
        while cur_dt < end_utc:
            w = iso(cur_dt)
            covered.append(w)
            before = conn.execute(
                "SELECT * FROM windows WHERE device_id=? AND window_start=?",
                (device_id, w),
            ).fetchone()
            before_dict = dict(before) if before is not None else None
            after = _recompute_window(conn, device_id, w)
            after_dict = after
            if before_dict is None and after_dict is not None:
                change_type = "created"
            elif before_dict is not None and after_dict is None:
                change_type = "removed"
            elif before_dict is not None and after_dict is not None and (
                before_dict["count"] != after_dict["count"]
                or before_dict["min_temp"] != after_dict["min_temp"]
                or before_dict["max_temp"] != after_dict["max_temp"]
                or abs(before_dict["avg_temp"] - after_dict["avg_temp"]) > 1e-12
            ):
                change_type = "updated"
            else:
                change_type = None
            if change_type:
                conn.execute(
                    """INSERT INTO recompute_changes (job_id, device_id,
                                                      window_start, change_type,
                                                      before_json, after_json)
                       VALUES (?,?,?,?,?,?)""",
                    (job_id, device_id, w, change_type,
                     json.dumps(before_dict) if before_dict else None,
                     json.dumps(after_dict) if after_dict else None),
                )
                changes.append(
                    {"window_start": w, "change_type": change_type,
                     "before": before_dict, "after": after_dict}
                )
            cur_dt += step

        finished_at = iso(datetime.now(timezone.utc))
        conn.execute(
            "UPDATE recompute_jobs SET status='done', finished_at=? WHERE id=?",
            (finished_at, job_id),
        )
        conn.execute("COMMIT")
        return {
            "job_id": job_id,
            "device_id": device_id,
            "range_start": iso(start),
            "range_end": iso(end_utc),
            "covered_windows": covered,
            "changes": changes,
            "started_at": started_at,
            "finished_at": finished_at,
        }
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
        lock.release()


# --------------------------------------------------------------------------- #
# Queries
# --------------------------------------------------------------------------- #
def list_devices() -> list[str]:
    conn = get_conn()
    try:
        return [r["device_id"] for r in conn.execute(
            "SELECT DISTINCT device_id FROM current_readings ORDER BY device_id"
        )]
    finally:
        conn.close()


def get_windows(device_id: str, start: Optional[datetime] = None,
                end: Optional[datetime] = None) -> list[dict]:
    sql = "SELECT * FROM windows WHERE device_id=?"
    params: list[Any] = [device_id]
    if start is not None:
        sql += " AND window_start >= ?"
        params.append(iso(window_start_for(start)))
    if end is not None:
        sql += " AND window_start < ?"
        params.append(iso(window_start_for(end)))
    sql += " ORDER BY window_start"
    conn = get_conn()
    try:
        return [dict(r) for r in conn.execute(sql, params)]
    finally:
        conn.close()


def get_window_readings(device_id: str, window_start: str) -> list[dict]:
    conn = get_conn()
    try:
        return [
            dict(r)
            for r in conn.execute(
                """SELECT * FROM current_readings
                   WHERE device_id=? AND window_start=?
                   ORDER BY reading_id""",
                (device_id, window_start),
            )
        ]
    finally:
        conn.close()


def get_reading_history(device_id: str, reading_id: str) -> dict:
    conn = get_conn()
    try:
        versions = [
            dict(r)
            for r in conn.execute(
                """SELECT r.id, r.device_id, r.reading_id, r.version,
                          r.measured_at, r.measured_at_raw, r.temperature,
                          r.received_at, r.batch_id, r.classification,
                          (c.reading_pk = r.id) AS is_current
                   FROM readings r
                   LEFT JOIN current_readings c
                     ON c.device_id = r.device_id AND c.reading_id = r.reading_id
                   WHERE r.device_id=? AND r.reading_id=?
                   ORDER BY r.version DESC, r.received_at DESC""",
                (device_id, reading_id),
            )
        ]
        current = conn.execute(
            "SELECT * FROM current_readings WHERE device_id=? AND reading_id=?",
            (device_id, reading_id),
        ).fetchone()
        return {
            "device_id": device_id,
            "reading_id": reading_id,
            "current": dict(current) if current else None,
            "versions": versions,
        }
    finally:
        conn.close()


def list_batches(limit: int = 100) -> list[dict]:
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT * FROM batches ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        result = []
        for row in rows:
            counts = {
                r["classification"]: r["n"]
                for r in conn.execute(
                    "SELECT classification, COUNT(*) AS n FROM batch_items WHERE batch_id=? GROUP BY classification",
                    (row["id"],),
                )
            }
            item = dict(row)
            item["counts"] = counts
            result.append(item)
        return result
    finally:
        conn.close()


def get_batch(batch_id: int) -> Optional[dict]:
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM batches WHERE id=?", (batch_id,)).fetchone()
        if row is None:
            return None
        items = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM batch_items WHERE batch_id=? ORDER BY id", (batch_id,)
            )
        ]
        for item in items:
            if item.get("detail"):
                try:
                    item["detail"] = json.loads(item["detail"])
                except (TypeError, json.JSONDecodeError):
                    pass
        counts: dict[str, int] = {}
        for item in items:
            counts[item["classification"]] = counts.get(item["classification"], 0) + 1
        result = dict(row)
        result["items"] = items
        result["counts"] = counts
        return result
    finally:
        conn.close()


def list_recompute_jobs() -> list[dict]:
    conn = get_conn()
    try:
        jobs = [dict(r) for r in conn.execute(
            "SELECT * FROM recompute_jobs ORDER BY id DESC"
        )]
        for job in jobs:
            job["changes"] = [
                dict(r)
                for r in conn.execute(
                    "SELECT window_start, change_type, before_json, after_json FROM recompute_changes WHERE job_id=? ORDER BY window_start",
                    (job["id"],),
                )
            ]
        return jobs
    finally:
        conn.close()


def get_recompute_job(job_id: int) -> Optional[dict]:
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT * FROM recompute_jobs WHERE id=?", (job_id,)
        ).fetchone()
        if row is None:
            return None
        job = dict(row)
        job["changes"] = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM recompute_changes WHERE job_id=? ORDER BY window_start",
                (job_id,),
            )
        ]
        return job
    finally:
        conn.close()
