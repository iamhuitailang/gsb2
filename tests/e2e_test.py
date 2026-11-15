"""端到端验证：在隔离的临时目录和端口上拉起全部服务并验证所有需求。

覆盖：
1. 预设额度周期样例：甲馆第 1 页后 429、等 5 秒；乙馆在这 5 秒内拉完
2. 最终甲馆 3 条、乙馆 2 条；再跑一遍数量不变（幂等）
3. 关服务再启动，未拉完的日期继续；从头重拉某页不重复写入
4. 手动重跑和计划任务碰到同场馆同日期合用一次采集
5. 按来源查看真实请求时间、响应码和各页写入结果
"""
import http.client
import json
import os
import signal
import socket as socket_mod
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATE = "2026-11-15"

PASS, FAIL = 0, 0
PROCS = []
TMP_LOG = None


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✅ {name}")
    else:
        FAIL += 1
        print(f"  ❌ {name}  {detail}")


def request(method, url, body=None, timeout=10, retries=3):
    data = json.dumps(body).encode() if body is not None else None
    last_err = None
    for attempt in range(retries):
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode())
        except (urllib.error.URLError, http.client.HTTPException,
                ConnectionError, OSError) as e:
            last_err = e
            time.sleep(0.3)
    raise last_err


def wait_health(port, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
                if r.status == 200:
                    return True
        except OSError:
            time.sleep(0.2)
    return False


def spawn(env, *args, cwd, log_path=None):
    out = open(log_path, "w") if log_path else subprocess.PIPE
    p = subprocess.Popen(
        [sys.executable, "-u", *args],
        cwd=str(cwd), env={**os.environ, **env},
        stdout=out, stderr=subprocess.STDOUT, text=True,
    )
    p._gsb2_log = out
    PROCS.append(p)
    return p


def port_free(port):
    with socket_mod.socket(socket_mod.AF_INET, socket_mod.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def stop_proc(p, timeout=5):
    if p.poll() is not None:
        return
    p.send_signal(signal.SIGINT)
    try:
        p.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        p.kill()


def wait_job(collector_port, venue_id, status="done", timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            _, st = request("GET", f"http://127.0.0.1:{collector_port}/api/state")
        except Exception as e:
            # 抓取现场：进程是否还活着、端口是否在监听、服务端异常栈
            alive = {p.pid: p.poll() for p in PROCS}
            listening = port_free(collector_port) is False
            print(f"   [debug] state 请求失败 {e!r}; 子进程存活={alive}; 端口监听={listening}")
            if not listening:
                print("--- 采集后台日志 ---\n", Path(TMP_LOG).read_text()
                      if Path(TMP_LOG).exists() else "(无日志文件)")
            time.sleep(0.5)
            continue
        for j in st["jobs"]:
            if j["venue_id"] == venue_id and j["date"] == DATE:
                if j["status"] == status:
                    return j
                if status == "done" and j["status"] == "failed":
                    return j
        time.sleep(0.3)
    return None


def main():
    tmp = Path(tempfile.mkdtemp(prefix="gsb2_e2e_"))
    ports = {"A": 19101, "B": 19102, "C": 19200}
    busy = [p for p in ports.values() if not port_free(p)]
    if busy:
        print(f"端口被占用，先清理残留进程: {busy}")
        return 2
    env = {
        "DATA_HOME": str(tmp),
        "SOURCE_A_PORT": str(ports["A"]),
        "SOURCE_B_PORT": str(ports["B"]),
        "COLLECTOR_PORT": str(ports["C"]),
        "PYTHONPATH": str(ROOT / "app"),
    }
    collector = ports["C"]
    global TMP_LOG
    TMP_LOG = tmp / "c.log"
    base = f"http://127.0.0.1:{collector}"

    print(f"临时目录: {tmp}")
    print("启动两个模拟来源和采集后台…")
    pa = spawn(env, "app/mock_server.py", "source-a", cwd=ROOT, log_path=tmp / "a.log")
    pb = spawn(env, "app/mock_server.py", "source-b", cwd=ROOT, log_path=tmp / "b.log")
    pc = spawn(env, "app/server.py", cwd=ROOT, log_path=tmp / "c.log")
    for p, port in ((pa, ports["A"]), (pb, ports["B"]), (pc, collector)):
        if not wait_health(port):
            print(f"服务启动失败 (port {port}, pid {p.pid}):")
            print(Path(p._gsb2_log.name).read_text() if p._gsb2_log else "")
            return 1

    print("\n== 1. 启动预设额度周期并同时下发两个场馆的采集 ==")
    request("POST", f"http://127.0.0.1:{ports['A']}/admin/start-cycle")
    request("POST", f"http://127.0.0.1:{ports['B']}/admin/start-cycle")
    t0 = time.time()
    request("POST", f"{base}/api/jobs", {"venue_id": "venue-a", "date": DATE, "trigger": "manual"})
    request("POST", f"{base}/api/jobs", {"venue_id": "venue-b", "date": DATE, "trigger": "manual"})

    # 等 3 秒：甲馆应只完成第 1 页（额度 1，第 2 次请求被 429 挂起）；乙馆应已全部完成
    time.sleep(3)
    _, st = request("GET", f"{base}/api/state")
    ja = next(j for j in st["jobs"] if j["venue_id"] == "venue-a")
    jb = next(j for j in st["jobs"] if j["venue_id"] == "venue-b")
    check("甲馆 3 秒后仍在采集（第 1 页完成、等额度拉第 2 页）",
          ja["status"] == "running" and ja["done_pages"] == 1, str(ja))
    # 乙馆 2 条记录、每页 2 条 => 1 页拉完；关键是它在甲馆等额度的窗口内已经完成
    check("乙馆在甲馆暂停的 5 秒内拉完全部页面",
          jb["status"] == "done" and jb["done_pages"] == jb["total_pages"], str(jb))

    _, logs_a = request("GET", f"{base}/api/logs?source_id=source-a")
    has_429 = any(l["status_code"] == 429 and l["outcome"] == "rate_limited" for l in logs_a["logs"])
    check("甲馆日志里出现真实的 429 限流记录（带等待秒数）",
          has_429 and any(l["retry_after"] == 5 for l in logs_a["logs"] if l["status_code"] == 429))

    # 甲馆等满 5 秒后应自动完成
    ja = wait_job(collector, "venue-a")
    check("甲馆等额度恢复后自动完成全部 2 页", ja and ja["status"] == "done" and ja["done_pages"] == 2, str(ja))

    print("\n== 2. 最终数量：甲馆 3 条、乙馆 2 条 ==")
    _, st = request("GET", f"{base}/api/state")
    counts = {j["venue_id"]: j["reservation_count"] for j in st["jobs"]}
    check("甲馆 3 条预约", counts.get("venue-a") == 3, str(counts))
    check("乙馆 2 条预约", counts.get("venue-b") == 2, str(counts))

    print("\n== 3. 再跑一遍：重新启动额度周期并重跑，数量保持不变 ==")
    request("POST", f"http://127.0.0.1:{ports['A']}/admin/start-cycle")
    request("POST", f"http://127.0.0.1:{ports['B']}/admin/start-cycle")
    request("POST", f"{base}/api/jobs", {"venue_id": "venue-a", "date": DATE, "trigger": "manual"})
    request("POST", f"{base}/api/jobs", {"venue_id": "venue-b", "date": DATE, "trigger": "manual"})
    wait_job(collector, "venue-a", timeout=30)
    wait_job(collector, "venue-b", timeout=30)
    _, st = request("GET", f"{base}/api/state")
    counts2 = {j["venue_id"]: j["reservation_count"] for j in st["jobs"]}
    check("重跑后甲馆仍为 3 条（不重复写入）", counts2.get("venue-a") == 3, str(counts2))
    check("重跑后乙馆仍为 2 条（不重复写入）", counts2.get("venue-b") == 2, str(counts2))
    _, logs_b = request("GET", f"{base}/api/logs?source_id=source-b")
    zero_writes = [l for l in logs_b["logs"] if l["outcome"] == "success" and l["rows_written"] == 0]
    check("日志能看到重拉页 rows_written=0（各页写入结果可查）", len(zero_writes) > 0)
    # 日志字段完整性：真实请求时间、响应时间、响应码
    ok_log = next(l for l in logs_b["logs"] if l["outcome"] == "success")
    check("每条成功日志带真实请求/响应时间和响应码 200",
          ok_log["request_at"] and ok_log["response_at"] and ok_log["status_code"] == 200)

    print("\n== 4. 同场馆同日期：手动与计划任务合用一次采集 ==")
    code, r1 = request("POST", f"{base}/api/jobs",
                    {"venue_id": "venue-b", "date": DATE, "trigger": "manual"})
    check("重复下发同场馆同日期不会新建任务（merged=true）", r1.get("merged") is True, str(r1))
    sid = request("POST", f"{base}/api/schedules",
               {"venue_id": "venue-b", "date": DATE, "interval_seconds": 2})[1]["schedule_id"]
    time.sleep(3)  # 等计划任务到期触发
    _, st = request("GET", f"{base}/api/state")
    b_jobs = [j for j in st["jobs"] if j["venue_id"] == "venue-b" and j["date"] == DATE]
    check("计划任务触发后仍只有一条采集任务", len(b_jobs) == 1, str(len(b_jobs)))
    check("任务 triggers 同时记录 manual 和 scheduled",
          set(b_jobs[0]["triggers"].split(",")) == {"manual", "scheduled"}, b_jobs[0]["triggers"])

    print("\n== 5. 重启采集后台：未拉完的日期继续，进度不丢 ==")
    # 新一轮额度：甲馆只够拉第 1 页
    request("POST", f"http://127.0.0.1:{ports['A']}/admin/start-cycle")
    request("POST", f"{base}/api/jobs/rerun", {"job_id": ja["id"]})
    time.sleep(3)
    _, st = request("GET", f"{base}/api/state")
    ja2 = next(j for j in st["jobs"] if j["venue_id"] == "venue-a")
    check("重启前甲馆只完成第 1 页", ja2["done_pages"] == 1 and ja2["status"] == "running", str(ja2))

    stop_proc(pc)
    PROCS.remove(pc)
    print("  采集后台已关闭，3 秒后重新启动…")
    time.sleep(3)
    pc = spawn(env, "app/server.py", cwd=ROOT)
    PROCS.append(pc)
    wait_health(collector)
    ja3 = wait_job(collector, "venue-a", timeout=20)
    check("重启后未拉完的日期自动续跑完成", ja3 and ja3["status"] == "done" and ja3["done_pages"] == 2, str(ja3))
    check("重启续跑后甲馆仍为 3 条（无重复）", ja3 and ja3["reservation_count"] == 3, str(ja3))

    print("\n== 6. 按来源筛选请求日志 ==")
    _, la = request("GET", f"{base}/api/logs?source_id=source-a")
    _, lb = request("GET", f"{base}/api/logs?source_id=source-b")
    check("source-a 日志只含甲馆请求", all(l["source_id"] == "source-a" for l in la["logs"]))
    check("source-b 日志只含乙馆请求", all(l["source_id"] == "source-b" for l in lb["logs"]))
    check("两个来源都有成功和限流/成功的完整记录",
          any(l["outcome"] == "success" for l in la["logs"])
          and any(l["outcome"] == "rate_limited" for l in la["logs"])
          and any(l["outcome"] == "success" for l in lb["logs"]))

    print(f"\n结果：{PASS} 通过 / {FAIL} 失败")
    return 1 if FAIL else 0


if __name__ == "__main__":
    code = 1
    try:
        code = main()
    except Exception:
        import traceback
        traceback.print_exc()
    finally:
        for p in list(PROCS):
            stop_proc(p)
    sys.exit(code)
