#!/usr/bin/env python3
"""配送日报任务编排（本地版）。

三步流水线：
  1. prepare_orders  整理订单底表：读取当日订单文件，剔除已取消订单
  2. compute_rate    计算完成率：读取底表 + 当日全部签收文件（主文件 + 补充文件）
  3. export_report   导出日报：每次导出生成一个新版本（v1、v2……），历史版本保留

完成率口径：
  分母 = 当日订单底表中有效订单数（剔除已取消订单）
  分子 = 其中签收状态为“已签收”的订单数（按订单号去重）

运行：python3 app.py [端口]   然后浏览器打开 http://127.0.0.1:8000
"""

import csv
import io
import json
import re
import sys
import threading
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, quote

BASE_DIR = Path(__file__).resolve().parent
ORDERS_DIR = BASE_DIR / "data" / "orders"
SIGNS_DIR = BASE_DIR / "data" / "signs"
WORK_DIR = BASE_DIR / "work"          # 中间产物：底表、完成率
REPORTS_DIR = BASE_DIR / "reports"    # 日报版本
STATE_DIR = BASE_DIR / "state"        # 执行记录
RUNS_FILE = STATE_DIR / "runs.json"
INDEX_HTML = BASE_DIR / "static" / "index.html"

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

STEP_NAMES = {
    "prepare_orders": "整理订单底表",
    "compute_rate": "计算完成率",
    "export_report": "导出日报",
}
MODE_LABELS = {
    "full_day": "完整流程（单日）",
    "full_range": "完整流程（范围补跑）",
    "rerun": "从计算完成率重跑（单日）",
}

CALIBER = ('分母=当日订单底表中有效订单数(剔除已取消); '
           '分子=其中签收状态为"已签收"的订单数(按订单号去重)')

STATE_LOCK = threading.Lock()
RUNS = []            # 全部执行记录（新→旧）
BUSY_DATES = set()   # 正在运行的日期（写入同一份日报的任务互斥）


# ---------------------------------------------------------------- 状态持久化

def load_state():
    if RUNS_FILE.exists():
        RUNS.extend(json.loads(RUNS_FILE.read_text(encoding="utf-8")))
        for run in RUNS:  # 上次进程退出时仍在跑的任务标记为已中断
            if run["status"] == "running":
                run["status"] = "interrupted"
                run["finished_at"] = run["finished_at"] or now_iso()


def save_state():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = RUNS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(RUNS, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(RUNS_FILE)


def now_iso():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def update_run(run, **fields):
    with STATE_LOCK:
        run.update(fields)
        save_state()


def append_step(run, date, step, records, detail):
    with STATE_LOCK:
        run["steps"].append({
            "date": date,
            "step": step,
            "name": STEP_NAMES[step],
            "records": records,
            "detail": detail,
            "finished_at": now_iso(),
        })
        save_state()


# ---------------------------------------------------------------- 流水线步骤

def orders_file(d):
    return ORDERS_DIR / f"orders_{d}.csv"


def sign_files(d):
    """当日签收输入：主文件在前，补充文件按文件名排序在后。"""
    main = SIGNS_DIR / f"signs_{d}.csv"
    supplements = sorted(SIGNS_DIR.glob(f"signs_{d}_supplement_*.csv"))
    return ([main] if main.exists() else []) + supplements


def base_file(d):
    return WORK_DIR / "base" / f"{d}.csv"


def rates_file(d):
    return WORK_DIR / "rates" / f"{d}.csv"


def read_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def step_prepare_orders(run, d):
    src = orders_file(d)
    if not src.exists():
        raise RuntimeError(f"{d} 缺少订单文件 {src.relative_to(BASE_DIR)}")
    rows = read_csv(src)
    valid = [r for r in rows if r["status"].strip() != "已取消"]
    out = base_file(d)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["order_id", "station", "recipient", "address"])
        for r in valid:
            w.writerow([r["order_id"], r["station"], r["recipient"], r["address"]])
    run["inputs"].setdefault(d, {})["orders"] = str(src.relative_to(BASE_DIR))
    detail = f"读取订单 {len(rows)} 条，剔除已取消 {len(rows) - len(valid)} 条，写入底表 {len(valid)} 条"
    append_step(run, d, "prepare_orders", len(valid), detail)


def step_compute_rate(run, d):
    base = base_file(d)
    if not base.exists():
        raise RuntimeError(f"{d} 还没有订单底表，请先执行完整流程（整理订单底表）")
    orders = read_csv(base)
    # 重跑场景下底表来自步骤①的历史产物，也要记录本次用的是哪份输入
    run["inputs"].setdefault(d, {}).setdefault(
        "orders", str(base.relative_to(BASE_DIR)))
    files = sign_files(d)
    if not files:
        raise RuntimeError(f"{d} 缺少签收记录文件 {SIGNS_DIR.relative_to(BASE_DIR)}/signs_{d}.csv")

    signed = set()          # 已签收订单号（去重）
    sign_rows = 0
    for path in files:
        for r in read_csv(path):
            sign_rows += 1
            if r["sign_status"].strip() == "已签收":
                signed.add(r["order_id"].strip())

    per_station = {}
    for r in orders:
        st = per_station.setdefault(r["station"], {"total": 0, "signed": 0})
        st["total"] += 1
        if r["order_id"] in signed:
            st["signed"] += 1

    out = rates_file(d)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["station", "total", "signed", "rate"])
        for st in sorted(per_station):
            v = per_station[st]
            w.writerow([st, v["total"], v["signed"], f"{v['signed'] / v['total']:.4f}"])

    run["inputs"].setdefault(d, {})["signs"] = [str(p.relative_to(BASE_DIR)) for p in files]
    matched = sum(1 for r in orders if r["order_id"] in signed)
    detail = (f"签收记录 {sign_rows} 条（{len(files)} 个文件），"
              f"去重后匹配到底表订单 {matched} 条")
    append_step(run, d, "compute_rate", sign_rows, detail)


def step_export_report(run, d):
    rates = rates_file(d)
    if not rates.exists():
        raise RuntimeError(f"{d} 还没有完成率结果，请先执行计算完成率")
    rows = read_csv(rates)

    date_dir = REPORTS_DIR / d
    date_dir.mkdir(parents=True, exist_ok=True)
    version = 1
    for p in date_dir.glob("v*"):
        if p.name[1:].isdigit():
            version = max(version, int(p.name[1:]) + 1)
    out_dir = date_dir / f"v{version}"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"日报_{d}_v{version}.csv"

    inputs = run["inputs"].get(d, {})
    total_n = sum(int(r["total"]) for r in rows)
    signed_n = sum(int(r["signed"]) for r in rows)
    with open(out, "w", newline="", encoding="utf-8-sig") as f:
        f.write(f"# 配送日报 {d}（版本 v{version}）\n")
        f.write(f"# 生成时间: {now_iso()}  执行ID: {run['id']}\n")
        f.write(f"# 口径: {CALIBER}\n")
        f.write(f"# 输入: 订单底表={inputs.get('orders', '-')}; "
                f"签收文件={'; '.join(inputs.get('signs', [])) or '-'}\n")
        w = csv.writer(f)
        w.writerow(["日期", "站点", "应配送订单数(分母)", "已签收订单数(分子)", "完成率"])
        for r in rows:
            w.writerow([d, r["station"], r["total"], r["signed"],
                        f"{float(r['rate']) * 100:.1f}%"])
        w.writerow([d, "总计", total_n, signed_n,
                    f"{(signed_n / total_n * 100) if total_n else 0:.1f}%"])

    run["outputs"][d] = version
    append_step(run, d, "export_report", len(rows) + 1,
                f"写入站点行 {len(rows)} 行 + 总计 1 行，"
                f"输出 {out.relative_to(BASE_DIR)}")


# ---------------------------------------------------------------- 任务执行

def execute_run(run):
    steps = (["prepare_orders", "compute_rate", "export_report"]
             if run["mode"] in ("full_day", "full_range")
             else ["compute_rate", "export_report"])
    try:
        for d in run["dates"]:
            for step in steps:
                update_run(run, current_step=f"{d} · {STEP_NAMES[step]}")
                {"prepare_orders": step_prepare_orders,
                 "compute_rate": step_compute_rate,
                 "export_report": step_export_report}[step](run, d)
        update_run(run, status="success", current_step=None, finished_at=now_iso())
    except Exception as e:  # noqa: BLE001 —— 失败原因要展示在执行记录里
        update_run(run, status="failed", error=str(e),
                   current_step=None, finished_at=now_iso())
    finally:
        with STATE_LOCK:
            BUSY_DATES.difference_update(run["dates"])
            save_state()


def start_run(mode, dates):
    with STATE_LOCK:
        conflict = sorted(BUSY_DATES.intersection(dates))
        if conflict:
            return None, f"日期 {', '.join(conflict)} 已有任务在运行，为避免写入同一份日报，本次未启动"
        run = {
            "id": uuid.uuid4().hex[:8],
            "mode": mode,
            "mode_label": MODE_LABELS[mode],
            "dates": dates,
            "status": "running",
            "current_step": None,
            "started_at": now_iso(),
            "finished_at": None,
            "steps": [],
            "inputs": {},
            "outputs": {},
            "error": None,
        }
        RUNS.insert(0, run)
        BUSY_DATES.update(dates)
        save_state()
    threading.Thread(target=execute_run, args=(run,), daemon=True).start()
    return run, None


def list_reports():
    reports = {}
    if REPORTS_DIR.exists():
        for date_dir in sorted(REPORTS_DIR.iterdir(), reverse=True):
            if not date_dir.is_dir():
                continue
            versions = sorted(
                (int(p.name[1:]) for p in date_dir.glob("v*") if p.name[1:].isdigit()),
                reverse=True)
            if versions:
                reports[date_dir.name] = versions
    return reports


def available_dates():
    return sorted(p.name[len("orders_"):-len(".csv")]
                  for p in ORDERS_DIR.glob("orders_*.csv"))


# ---------------------------------------------------------------- HTTP 服务

class Handler(BaseHTTPRequestHandler):
    server_version = "DeliveryDailyReport/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (now_iso(), fmt % args))

    def _send(self, code, body, content_type="application/json; charset=utf-8",
              extra_headers=None):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False))

    def do_GET(self):
        url = urlparse(self.path)
        qs = parse_qs(url.query)
        if url.path == "/":
            self._send(200, INDEX_HTML.read_bytes(), "text/html; charset=utf-8")
        elif url.path == "/api/overview":
            with STATE_LOCK:
                runs = json.loads(json.dumps(RUNS))
            self._json({"runs": runs,
                        "reports": list_reports(),
                        "available_dates": available_dates(),
                        "caliber": CALIBER})
        elif url.path == "/api/report":
            self._serve_report(qs)
        else:
            self._json({"error": "not found"}, 404)

    def _serve_report(self, qs):
        d = qs.get("date", [""])[0]
        version = qs.get("version", [""])[0]
        if not DATE_RE.match(d) or not version.isdigit():
            return self._json({"error": "参数错误"}, 400)
        path = REPORTS_DIR / d / f"v{version}" / f"日报_{d}_v{version}.csv"
        if not path.exists():
            return self._json({"error": "日报不存在"}, 404)
        headers = {}
        if qs.get("download"):
            filename = quote(path.name)
            headers["Content-Disposition"] = (
                f"attachment; filename*=UTF-8''{filename}")
        self._send(200, path.read_bytes(),
                   "text/csv; charset=utf-8", headers)

    def do_POST(self):
        if urlparse(self.path).path != "/api/run":
            return self._json({"error": "not found"}, 404)
        try:
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        except Exception:
            return self._json({"error": "请求体不是合法 JSON"}, 400)

        mode = body.get("mode")
        if mode not in MODE_LABELS:
            return self._json({"error": "未知执行方式"}, 400)

        if mode == "full_range":
            start, end = body.get("start", ""), body.get("end", "")
            if not (DATE_RE.match(start) and DATE_RE.match(end)) or start > end:
                return self._json({"error": "日期范围不合法"}, 400)
            from datetime import date as date_cls, timedelta
            a = date_cls.fromisoformat(start)
            b = date_cls.fromisoformat(end)
            if (b - a).days > 62:
                return self._json({"error": "范围补跑一次最多 62 天"}, 400)
            dates = [(a + timedelta(days=i)).isoformat()
                     for i in range((b - a).days + 1)]
        else:
            d = body.get("date", "")
            if not DATE_RE.match(d):
                return self._json({"error": "日期不合法"}, 400)
            dates = [d]

        if mode in ("full_day", "full_range"):
            missing = [d for d in dates if not orders_file(d).exists()]
            if missing:
                return self._json(
                    {"error": f"以下日期缺少订单文件: {', '.join(missing)}"}, 400)
        if mode == "rerun" and not base_file(dates[0]).exists():
            return self._json(
                {"error": f"{dates[0]} 还没有订单底表，请先执行完整流程"}, 400)

        run, err = start_run(mode, dates)
        if err:
            return self._json({"error": err}, 409)
        self._json({"run": run}, 201)


def main():
    load_state()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"配送日报任务编排已启动: http://127.0.0.1:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
