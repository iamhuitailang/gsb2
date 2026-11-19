import os
import tempfile
import threading

import pytest

# Point the service at an isolated database before importing app modules.
_TMP = tempfile.mkdtemp(prefix="tempservice-test-")
os.environ["TEMP_DB_PATH"] = os.path.join(_TMP, "test.db")

from app import service  # noqa: E402
from app.db import init_db, reset_db  # noqa: E402


@pytest.fixture(autouse=True)
def clean_db():
    reset_db()
    init_db()
    yield


W1 = "2024-01-01T10:00:00.000Z"
W2 = "2024-01-01T10:05:00.000Z"


def window(device, start):
    rows = service.get_windows(device)
    match = [r for r in rows if r["window_start"] == start]
    return match[0] if match else None


def test_sample_scenario_expected_averages_and_counts():
    # Batch 1: three new readings.
    r1 = service.ingest_batch([
        {"device_id": "probe-A", "reading_id": "A-r1", "version": 1,
         "measured_at": "2024-01-01T10:00:00Z", "temperature": 18},
        {"device_id": "probe-A", "reading_id": "A-r2", "version": 1,
         "measured_at": "2024-01-01T10:04:00Z", "temperature": 22},
        {"device_id": "probe-A", "reading_id": "A-r3", "version": 1,
         "measured_at": "2024-01-01T10:05:00Z", "temperature": 26},
    ])
    assert r1["counts"]["new"] == 3
    # 10:05:00 exactly on the boundary belongs to the later window.
    assert window("probe-A", W1)["count"] == 2
    assert window("probe-A", W2)["count"] == 1
    assert window("probe-A", W2)["avg_temp"] == 26

    # Batch 2: late new reading lands only in its own window -> avg 18.67.
    r2 = service.ingest_batch([
        {"device_id": "probe-A", "reading_id": "A-r4", "version": 1,
         "measured_at": "2024-01-01T10:01:00Z", "temperature": 16},
    ])
    assert r2["counts"]["new"] == 1
    w1 = window("probe-A", W1)
    assert w1["count"] == 3
    assert round(w1["avg_temp"], 2) == 18.67
    assert w1["min_temp"] == 16 and w1["max_temp"] == 22
    # Untouched window stays the same.
    assert window("probe-A", W2)["avg_temp"] == 26

    # Batch 3: correction moves A-r2 across the window boundary.
    r3 = service.ingest_batch([
        {"device_id": "probe-A", "reading_id": "A-r2", "version": 2,
         "measured_at": "2024-01-01T10:05:10Z", "temperature": 28},
    ])
    assert r3["counts"]["correction"] == 1
    w1 = window("probe-A", W1)
    w2 = window("probe-A", W2)
    # Old window: 16 and 18 remain -> avg 17; min/max recomputed.
    assert w1["count"] == 2 and round(w1["avg_temp"], 2) == 17
    assert w1["min_temp"] == 16 and w1["max_temp"] == 18
    # New window: 26 and 28 -> avg 27.
    assert w2["count"] == 2 and round(w2["avg_temp"], 2) == 27
    assert w2["min_temp"] == 26 and w2["max_temp"] == 28

    # Batch 4: old and new versions retransmitted together, both duplicates.
    r4 = service.ingest_batch([
        {"device_id": "probe-A", "reading_id": "A-r2", "version": 1,
         "measured_at": "2024-01-01T10:04:00Z", "temperature": 22},
        {"device_id": "probe-A", "reading_id": "A-r2", "version": 2,
         "measured_at": "2024-01-01T10:05:10Z", "temperature": 28},
    ])
    assert r4["counts"]["duplicate"] == 2
    assert window("probe-A", W1)["count"] == 2
    assert window("probe-A", W2)["count"] == 2
    assert round(window("probe-A", W1)["avg_temp"], 2) == 17
    assert round(window("probe-A", W2)["avg_temp"], 2) == 27


def test_stale_version_never_overwrites_newer():
    service.ingest_batch([
        {"device_id": "d", "reading_id": "x", "version": 2,
         "measured_at": "2024-01-01T10:00:00Z", "temperature": 20},
    ])
    result = service.ingest_batch([
        {"device_id": "d", "reading_id": "x", "version": 1,
         "measured_at": "2024-01-01T10:00:00Z", "temperature": 5},
    ])
    assert result["counts"]["stale"] == 1
    assert window("d", W1)["avg_temp"] == 20
    history = service.get_reading_history("d", "x")
    assert history["current"]["version"] == 2
    assert {v["version"] for v in history["versions"]} == {1, 2}


def test_conflict_keeps_received_version_and_processes_rest():
    service.ingest_batch([
        {"device_id": "d", "reading_id": "x", "version": 1,
         "measured_at": "2024-01-01T10:00:00Z", "temperature": 20},
    ])
    result = service.ingest_batch([
        # Same version, different temperature -> conflict, rejected.
        {"device_id": "d", "reading_id": "x", "version": 1,
         "measured_at": "2024-01-01T10:00:00Z", "temperature": 99},
        # Independent record in the same batch -> still processed.
        {"device_id": "d", "reading_id": "y", "version": 1,
         "measured_at": "2024-01-01T10:01:00Z", "temperature": 30},
    ])
    assert result["counts"]["conflict"] == 1
    assert result["counts"]["new"] == 1
    assert result["conflicts"][0]["reading_id"] == "x"
    assert result["conflicts"][0]["detail"]["existing"]["temperature"] == 20
    assert result["conflicts"][0]["detail"]["incoming"]["temperature"] == 99
    # Original version retained; the conflicting payload was not stored.
    history = service.get_reading_history("d", "x")
    assert len(history["versions"]) == 1
    assert window("d", W1)["count"] == 2


def test_invalid_record_does_not_stop_batch():
    result = service.ingest_batch([
        {"device_id": "d", "reading_id": "bad", "version": 0,
         "measured_at": "2024-01-01T10:00:00Z", "temperature": 1},
        {"device_id": "d", "reading_id": "ok", "version": 1,
         "measured_at": "2024-01-01T10:00:00Z", "temperature": 2},
    ])
    assert result["counts"]["invalid"] == 1
    assert result["counts"]["new"] == 1
    assert window("d", W1)["count"] == 1


def test_timezone_offsets_convert_to_utc_window():
    # 18:04 +08:00 == 10:04 UTC -> 10:00 window.
    service.ingest_batch([
        {"device_id": "d", "reading_id": "z", "version": 1,
         "measured_at": "2024-01-01T18:04:00+08:00", "temperature": 10},
    ])
    assert window("d", W1)["avg_temp"] == 10
    history = service.get_reading_history("d", "z")
    assert history["versions"][0]["measured_at_raw"] == "2024-01-01T18:04:00+08:00"
    assert history["versions"][0]["measured_at"] == "2024-01-01T10:04:00.000Z"


def test_correction_removing_last_reading_empties_window():
    service.ingest_batch([
        {"device_id": "d", "reading_id": "x", "version": 1,
         "measured_at": "2024-01-01T10:00:30Z", "temperature": 10},
    ])
    assert window("d", W1) is not None
    service.ingest_batch([
        {"device_id": "d", "reading_id": "x", "version": 2,
         "measured_at": "2024-01-01T10:05:30Z", "temperature": 11},
    ])
    assert window("d", W1) is None  # back to no data
    assert window("d", W2)["count"] == 1


def test_window_drilldown_and_version_history():
    service.ingest_batch([
        {"device_id": "d", "reading_id": "x", "version": 1,
         "measured_at": "2024-01-01T10:00:00Z", "temperature": 10},
        {"device_id": "d", "reading_id": "y", "version": 1,
         "measured_at": "2024-01-01T10:02:00Z", "temperature": 12},
    ])
    readings = service.get_window_readings("d", W1)
    assert {r["reading_id"] for r in readings} == {"x", "y"}
    service.ingest_batch([
        {"device_id": "d", "reading_id": "x", "version": 2,
         "measured_at": "2024-01-01T10:00:00Z", "temperature": 14},
    ])
    history = service.get_reading_history("d", "x")
    assert history["current"]["version"] == 2
    assert history["current"]["temperature"] == 14
    versions = history["versions"]
    assert versions[0]["is_current"] == 1
    assert versions[1]["is_current"] == 0
    assert versions[1]["classification"] == "new"


def test_recompute_rebuilds_from_raw_versions_and_reports_changes():
    service.ingest_batch([
        {"device_id": "d", "reading_id": "x", "version": 1,
         "measured_at": "2024-01-01T10:00:00Z", "temperature": 10},
        {"device_id": "d", "reading_id": "y", "version": 1,
         "measured_at": "2024-01-01T10:01:00Z", "temperature": 20},
    ])
    # Tamper with the stored aggregate to prove recomputation rebuilds it.
    from app.db import get_conn
    conn = get_conn()
    conn.execute(
        "UPDATE windows SET avg_temp=999, min_temp=0, max_temp=0, count=9, sum_temp=0 "
        "WHERE device_id='d' AND window_start=?",
        (W1,),
    )
    conn.commit()
    conn.close()

    job = service.recompute_device_range(
        "d",
        service.parse_instant("2024-01-01T10:00:00Z"),
        service.parse_instant("2024-01-01T10:10:00Z"),
    )
    assert job["covered_windows"] == [W1, W2]
    # W1 changed; W2 is empty before and after -> no stored row, no change.
    assert len(job["changes"]) == 1
    types = {c["window_start"]: c["change_type"] for c in job["changes"]}
    assert types[W1] == "updated"
    restored = window("d", W1)
    assert restored["count"] == 2 and restored["avg_temp"] == 15
    # An empty window has no stored row (the page renders it as no data).
    assert window("d", W2) is None

    # A second identical run changes nothing.
    job2 = service.recompute_device_range(
        "d",
        service.parse_instant("2024-01-01T10:00:00Z"),
        service.parse_instant("2024-01-01T10:05:00Z"),
    )
    assert job2["changes"] == []
    assert job2["covered_windows"] == [W1]


def test_recompute_does_not_touch_out_of_range_windows_or_other_devices():
    service.ingest_batch([
        {"device_id": "d", "reading_id": "x", "version": 1,
         "measured_at": "2024-01-01T10:00:00Z", "temperature": 10},
        {"device_id": "d", "reading_id": "y", "version": 1,
         "measured_at": "2024-01-01T10:10:00Z", "temperature": 40},
        {"device_id": "other", "reading_id": "z", "version": 1,
         "measured_at": "2024-01-01T10:00:00Z", "temperature": 5},
    ])
    service.recompute_device_range(
        "d",
        service.parse_instant("2024-01-01T10:00:00Z"),
        service.parse_instant("2024-01-01T10:05:00Z"),
    )
    assert window("d", "2024-01-01T10:10:00.000Z")["avg_temp"] == 40
    assert window("other", W1)["avg_temp"] == 5


def test_concurrent_batches_same_reading_counted_once():
    errors = []

    def send(temp):
        try:
            service.ingest_batch([
                {"device_id": "d", "reading_id": "x", "version": 1,
                 "measured_at": "2024-01-01T10:00:00Z", "temperature": temp},
            ])
        except Exception as exc:  # pragma: no cover - failure path
            errors.append(exc)

    t1 = threading.Thread(target=send, args=(10,))
    t2 = threading.Thread(target=send, args=(10,))  # identical -> duplicate
    t1.start(); t2.start(); t1.join(); t2.join()
    assert not errors
    assert window("d", W1)["count"] == 1
    assert window("d", W1)["avg_temp"] == 10
    batches = service.list_batches()
    total = sum(b["counts"].get("new", 0) for b in batches)
    assert total == 1


def test_batch_arriving_during_recompute_is_included_afterwards():
    service.ingest_batch([
        {"device_id": "d", "reading_id": "x", "version": 1,
         "measured_at": "2024-01-01T10:00:00Z", "temperature": 10},
    ])
    started = threading.Event()
    proceed = threading.Event()

    def hook(device_id, job_id):
        started.set()
        proceed.wait(timeout=5)

    service.recompute_sync_hook = hook

    def late_batch():
        started.wait(timeout=5)
        service.ingest_batch([
            {"device_id": "d", "reading_id": "y", "version": 1,
             "measured_at": "2024-01-01T10:01:00Z", "temperature": 20},
        ])
        proceed.set()

    t = threading.Thread(target=late_batch)
    t.start()
    job = service.recompute_device_range(
        "d",
        service.parse_instant("2024-01-01T10:00:00Z"),
        service.parse_instant("2024-01-01T10:05:00Z"),
    )
    t.join()
    service.recompute_sync_hook = None

    # The queued batch was applied after the job; final window contains both.
    w = window("d", W1)
    assert w["count"] == 2 and w["avg_temp"] == 15
    # The job report only saw what existed while it ran.
    assert job["changes"] == []
