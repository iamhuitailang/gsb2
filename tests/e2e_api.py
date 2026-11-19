"""End-to-end checks over the real HTTP API using FastAPI's TestClient.

Run: python tests/e2e_api.py
Exercises the sample files in samples/ and every drill-down endpoint.
"""
import json
import os
import tempfile

_TMP = tempfile.mkdtemp(prefix="tempservice-e2e-")
os.environ["TEMP_DB_PATH"] = os.path.join(_TMP, "e2e.db")

from fastapi.testclient import TestClient  # noqa: E402

from app.db import init_db, reset_db  # noqa: E402
from app.main import app  # noqa: E402

reset_db()
init_db()
client = TestClient(app)

SAMPLES = [
    "batch1_probe_a.json",
    "batch1_probe_b.json",
    "batch2_probe_a_backfill.json",
    "batch2_probe_b_backfill.json",
    "batch3_probe_a_correction.json",
    "batch3_probe_b_correction.json",
    "batch4_probe_a_retransmit.json",
    "batch4_probe_b_retransmit.json",
    "batch5_probe_a_conflict.json",
    "batch5_probe_b_conflict.json",
]

W1 = "2024-01-01T10:00:00.000Z"
W2 = "2024-01-01T10:05:00.000Z"
failures = []


def check(name, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name} {detail}")
    if not cond:
        failures.append(name)


def window(device, start):
    rows = client.get(f"/api/devices/{device}/windows").json()
    match = [r for r in rows if r["window_start"] == start]
    return match[0] if match else None


# ---- send every sample batch through HTTP ----
results = {}
for f in SAMPLES:
    payload = client.get(f"/api/samples/{f}").json()
    resp = client.post("/api/batches", json=payload)
    check(f"POST {f} -> 200", resp.status_code == 200, str(resp.status_code))
    results[f] = resp.json()

# ---- sample numeric assertions for probe-A ----
# (The intermediate 18.67 average after backfill is covered in the unit tests.)
w1 = window("probe-A", W1)
w2 = window("probe-A", W2)
check("A 10:00 avg == 17 after correction", round(w1["avg_temp"], 2) == 17.0,
      f"got {w1['avg_temp']}")
check("A 10:00 count == 2 (16,18)", w1["count"] == 2, str(w1["count"]))
check("A 10:00 min/max recomputed (16/18)", w1["min_temp"] == 16 and w1["max_temp"] == 18)
check("A 10:05 avg == 27 (26,28)", round(w2["avg_temp"], 2) == 27.0, f"got {w2['avg_temp']}")
check("A 10:05 count == 2", w2["count"] == 2)

# ---- probe-B independent, same shape ----
b1 = window("probe-B", W1)
b2 = window("probe-B", W2)
check("B 10:00 avg == 17", round(b1["avg_temp"], 2) == 17.0, str(b1["avg_temp"]))
check("B 10:05 avg == 27", round(b2["avg_temp"], 2) == 27.0, str(b2["avg_temp"]))

# ---- batch counters ----
c1 = results["batch1_probe_a.json"]["counts"]
check("batch1 A: 3 new", c1["new"] == 3, str(c1))
c2 = results["batch2_probe_a_backfill.json"]["counts"]
check("batch2 A: 1 new (late arrival)", c2["new"] == 1, str(c2))
c3 = results["batch3_probe_a_correction.json"]["counts"]
check("batch3 A: 1 correction", c3["correction"] == 1, str(c3))
c4 = results["batch4_probe_a_retransmit.json"]["counts"]
check("batch4 A: 2 duplicates, stats unchanged", c4["duplicate"] == 2, str(c4))
c5 = results["batch5_probe_a_conflict.json"]["counts"]
check("batch5 A: 1 conflict, nothing applied", c5["conflict"] == 1 and c5["new"] == 0,
      str(c5))
check("conflict names reading A-r2 v2",
      results["batch5_probe_a_conflict.json"]["conflicts"][0]["reading_id"] == "A-r2")

# ---- drill down: window readings ----
wr = client.get("/api/devices/probe-A/readings",
                params={"window_start": "2024-01-01T10:00:00Z"}).json()
ids = {r["reading_id"] for r in wr["readings"]}
check("10:00 window contains A-r1 and A-r4", ids == {"A-r1", "A-r4"}, str(ids))

# ---- reading history with received_at ----
hist = client.get("/api/readings/probe-A/A-r2/history").json()
check("A-r2 has 2 retained versions", len(hist["versions"]) == 2,
      str([(v["version"], v["classification"]) for v in hist["versions"]]))
check("A-r2 current is v2 = 28", hist["current"]["version"] == 2
      and hist["current"]["temperature"] == 28)
check("history entries carry received_at", all(v["received_at"] for v in hist["versions"]))
# conflicting v2 payload was never stored
check("conflicting 99.9 payload not stored",
      all(v["temperature"] != 99.9 for v in hist["versions"]))

# ---- batch detail endpoint ----
bd = client.get(f"/api/batches/{results['batch5_probe_a_conflict.json']['batch_id']}").json()
check("batch detail lists conflict with detail",
      any(i["classification"] == "conflict" and isinstance(i["detail"], dict)
          for i in bd["items"]))

# ---- recompute via HTTP: tamper then rebuild ----
from app.db import get_conn
conn = get_conn()
conn.execute("UPDATE windows SET avg_temp=999 WHERE device_id='probe-A' AND window_start=?", (W1,))
conn.commit()
conn.close()

rc = client.post("/api/recompute", json={
    "device_id": "probe-A",
    "start": "2024-01-01T10:00:00Z",
    "end": "2024-01-01T10:10:00Z",
}).json()
check("recompute reports 1 change", len(rc["changes"]) == 1,
      json.dumps(rc["changes"], ensure_ascii=False))
fixed = window("probe-A", W1)
check("recompute restores A 10:00 avg to 17", round(fixed["avg_temp"], 2) == 17.0,
      str(fixed["avg_temp"]))
check("recompute restored min/max 16/18",
      fixed["min_temp"] == 16 and fixed["max_temp"] == 18)
check("recompute covered both windows", rc["covered_windows"] == [W1, W2])

# range boundary: recompute only W1 must not touch W2 or probe-B
before_b2 = window("probe-B", W2)
client.post("/api/recompute", json={
    "device_id": "probe-A",
    "start": "2024-01-01T10:00:00Z",
    "end": "2024-01-01T10:05:00Z",
})
after_b2 = window("probe-B", W2)
check("recompute does not touch other devices", before_b2 == after_b2)
check("half-open end excludes 10:05 window",
      client.post("/api/recompute", json={
          "device_id": "probe-A",
          "start": "2024-01-01T10:00:00Z",
          "end": "2024-01-01T10:05:00Z"}).json()["covered_windows"] == [W1])

# recompute job listing / detail
jobs = client.get("/api/recompute").json()
check("recompute jobs listed", len(jobs) >= 2)
detail = client.get(f"/api/recompute/{rc['job_id']}").json()
check("recompute detail has changes", len(detail["changes"]) == 1)

# ---- timezone handling via HTTP ----
client.post("/api/batches", json={"records": [
    {"device_id": "probe-C", "reading_id": "C1", "version": 1,
     "measured_at": "2024-01-01T18:02:00+08:00", "temperature": 11}
]})
cw = window("probe-C", W1)
check("offset time converts to UTC window", cw is not None and cw["avg_temp"] == 11,
      str(cw))

# ---- empty device / 404 behavior ----
check("unknown reading history -> empty versions",
      client.get("/api/readings/nope/x/history").json()["versions"] == [])
check("unknown batch -> 404", client.get("/api/batches/9999").status_code == 404)

print()
if failures:
    print(f"{len(failures)} FAILURE(S): {failures}")
    raise SystemExit(1)
print("ALL E2E CHECKS PASSED")
