#!/usr/bin/env python3
"""端到端 API 检查: 需要先启动 python3 app.py --no-browser。

用法:
    python3 scripts/e2e_check.py [base_url]

会真实走一遍: 分析 -> 改参数/加区间 -> 取帧 -> 存项目 ->
导出参数 JSON -> 导出视频并校验产物。
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765"
SAMPLE = ROOT / "samples" / "sample_shake.mp4"

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"[{'PASS' if ok else 'FAIL'}] {name} {detail}")
    if not ok:
        failures.append(name)


def req(path: str, payload=None, raw: bool = False):
    url = BASE + path
    if payload is None:
        r = urllib.request.urlopen(url, timeout=30)
    else:
        data = json.dumps(payload).encode()
        r = urllib.request.urlopen(
            urllib.request.Request(url, data=data,
                                   headers={"Content-Type": "application/json"},
                                   method="POST"),
            timeout=30,
        )
    body = r.read()
    if raw:
        return r.status, body, dict(r.headers)
    return json.loads(body)


def wait_job(job_id: str, timeout: int = 240):
    t0 = time.time()
    last = {}
    while time.time() - t0 < timeout:
        last = req(f"/api/job/{job_id}")
        if last["status"] in ("done", "error", "cancelled"):
            return last
        time.sleep(0.7)
    raise TimeoutError(f"job {job_id} timeout: {last}")


def main() -> int:
    h = req("/api/health")
    check("health", h.get("ok") is True)

    if not SAMPLE.exists():
        print("示例不存在, 先生成: python3 make_samples.py")
        return 2

    j = req("/api/analyze", {"path": str(SAMPLE)})
    job = wait_job(j["job_id"])
    check("analyze job done", job["status"] == "done", str(job.get("error", "")))

    s = req("/api/session")
    check("session loaded", s.get("has_session") is True)
    check("frame_count > 100", s.get("frame_count", 0) > 100,
          f"n={s.get('frame_count')}")
    n = s["frame_count"]

    # 参数更新 + 区间
    r = req("/api/params", {
        "strength": 0.9, "smooth_sec": 0.7, "crop_mode": "auto",
        "adaptive_pan": True,
        "exclusions": [{"start": 10, "end": 24, "label": "test"}],
    })
    check("params update", r.get("ok") is True,
          f"zoom={r['params']['crop_zoom']}")
    check("exclusion merged",
          len(r["params"]["exclusions"]) == 1
          and r["params"]["exclusions"][0]["start"] == 10)

    # 取两帧(原图叠加 / 稳定), 校验 JPEG 魔数
    for kind in ("original", "stable"):
        status, body, headers = req(
            f"/api/frame?kind={kind}&i=30&w=960&pv=1", raw=True)
        check(f"frame {kind} jpeg",
              status == 200 and body[:2] == b"\xff\xd8" and len(body) > 8000,
              f"{len(body)} bytes")

    # 不处理区间内矩阵必须是单位矩阵(无校正无缩放)
    # 通过参数导出结构间接校验: 直接拉 params JSON 检查第 15 帧
    status, body, headers = req("/api/params/export", raw=True)
    check("params json download", status == 200 and body[:1] == b"{")
    pdata = json.loads(body)
    f15 = pdata["frames"][15]
    m = f15["matrix_src_to_dst"]
    # 不处理区间: 校正为 0、缩放为 1, 矩阵必须是严格单位阵
    identity = (abs(m[0][0] - 1) < 1e-6 and abs(m[1][1] - 1) < 1e-6
                and abs(m[0][1]) < 1e-6 and abs(m[1][0]) < 1e-6
                and abs(m[0][2]) < 0.01 and abs(m[1][2]) < 0.01)
    check("excluded frame matrix == centered identity", identity,
          f"tx={m[0][2]:.2f} ty={m[1][2]:.2f}")
    check("params frames length matches", len(pdata["frames"]) == n)

    # 保存项目
    pr = req("/api/projects/save", {"name": "e2e_check_project"})
    check("project save", pr.get("ok") is True, pr.get("file", ""))
    projects = req("/api/projects")
    check("project listed",
          any(p["file"] == pr["file"] for p in projects["projects"]))

    # 导出视频
    e = req("/api/export", {"name": "e2e_check_export"})
    ejob = wait_job(e["job_id"], timeout=300)
    check("export job done", ejob["status"] == "done", str(ejob.get("error", "")))
    if ejob["status"] == "done":
        out = Path(ejob["result"]["path"])
        check("export file exists", out.exists() and out.stat().st_size > 50_000,
              f"{out.name} {out.stat().st_size / 1024:.0f}KB")
        sidecar = out.with_suffix(".params.json")
        check("params sidecar exists", sidecar.exists())
        # 下载 URL 可访问
        status, body, _ = req(ejob["result"]["url"], raw=True)
        check("export url serves bytes", status == 200 and len(body) > 50_000)

    print()
    if failures:
        print(f"{len(failures)} FAILURES: {failures}")
        return 1
    print("ALL E2E CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
