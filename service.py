"""导出任务逻辑：按页生成明细分片，全部完成后汇总为各库区 csv + 统计 + zip。

一致性保证：
- 任务创建时锁定 data_version 和范围，之后所有读取都走同一快照；
- 每页产物是一个分片文件（先写临时文件再原子重命名），页记录入库；
  服务中断后重新生成时，已入库的页直接跳过，同一份清单不会写两次明细；
- 预览、统计、zip 全部来自同一快照版本的数据。
"""

import csv
import os
import zipfile
from datetime import datetime, timezone

import db

PAGE_SIZE = 1  # 每页明细条数：一份清单可分多页生成

CSV_HEADER = ["运单号", "库区", "件数", "发货日期"]
MANIFEST_NAME = "manifest.csv"


def create_task(conn, date_from, date_to):
    """开始一次导出：从这一刻起固定范围和数据版本。"""
    version = db.current_version(conn)
    rows = db.snapshot_rows(conn, version, date_from, date_to)
    total_rows = len(rows)
    total_pieces = sum(r["pieces"] for r in rows)
    total_pages = (total_rows + PAGE_SIZE - 1) // PAGE_SIZE
    with conn:
        cur = conn.execute(
            """
            INSERT INTO export_tasks(date_from, date_to, data_version, status,
                                     page_size, total_rows, total_pieces,
                                     total_pages, created_at)
            VALUES (?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?)
            """,
            (date_from, date_to, version, PAGE_SIZE, total_rows, total_pieces,
             total_pages, datetime.now(timezone.utc).isoformat(timespec="seconds")),
        )
    return cur.lastrowid


def get_task(conn, task_id):
    return conn.execute(
        "SELECT * FROM export_tasks WHERE id = ?", (task_id,)
    ).fetchone()


def list_tasks(conn):
    return conn.execute(
        "SELECT * FROM export_tasks ORDER BY id DESC"
    ).fetchall()


def done_pages(conn, task_id):
    return conn.execute(
        "SELECT * FROM export_pages WHERE task_id = ? ORDER BY page_no",
        (task_id,),
    ).fetchall()


def task_files(conn, task_id):
    return conn.execute(
        "SELECT * FROM export_files WHERE task_id = ? ORDER BY filename",
        (task_id,),
    ).fetchall()


def preview_rows(conn, task):
    """页面预览：与生成、统计使用同一数据版本。"""
    return db.snapshot_rows(
        conn, task["data_version"], task["date_from"], task["date_to"]
    )


def zone_stats(conn, task):
    """按库区汇总行数/件数（同一快照），供页面展示。"""
    stats = {}
    for r in preview_rows(conn, task):
        s = stats.setdefault(r["zone"], {"rows": 0, "pieces": 0})
        s["rows"] += 1
        s["pieces"] += r["pieces"]
    return stats


def _fragment_path(workdir, task_id, page_no):
    return os.path.join(
        workdir, "fragments", f"task{task_id}", f"page_{page_no:04d}.csv"
    )


def generate_next_page(conn, task_id, workdir):
    """生成下一页。已完成全部页时返回 None。

    页分片先写临时文件再原子重命名，随后页记录入库；
    中断后重跑时已入库的页被跳过，分片文件按同名覆盖，不会重复明细。
    """
    task = get_task(conn, task_id)
    if task is None:
        raise ValueError(f"任务不存在: {task_id}")
    if task["status"] == "DONE":
        return None

    finished = {p["page_no"] for p in done_pages(conn, task_id)}
    next_page = next(
        (p for p in range(1, task["total_pages"] + 1) if p not in finished), None
    )
    if next_page is None:
        _assemble(conn, task, workdir)
        return None

    rows = db.snapshot_rows(
        conn, task["data_version"], task["date_from"], task["date_to"]
    )
    start = (next_page - 1) * task["page_size"]
    page_rows = rows[start : start + task["page_size"]]

    fragment = _fragment_path(workdir, task_id, next_page)
    os.makedirs(os.path.dirname(fragment), exist_ok=True)
    tmp = fragment + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        for r in page_rows:
            w.writerow([r["zone"], r["waybill_no"], r["pieces"], r["ship_date"]])
    os.replace(tmp, fragment)

    with conn:
        conn.execute(
            "INSERT INTO export_pages(task_id, page_no, row_count, total_pieces,"
            " fragment_path) VALUES (?, ?, ?, ?, ?)",
            (task_id, next_page, len(page_rows),
             sum(r["pieces"] for r in page_rows), fragment),
        )

    if len(finished) + 1 == task["total_pages"]:
        _assemble(conn, get_task(conn, task_id), workdir)
    return next_page


def run_remaining(conn, task_id, workdir):
    """继续生成剩余所有页（断点续传入口）。"""
    while generate_next_page(conn, task_id, workdir) is not None:
        pass


def _read_fragment(path):
    with open(path, newline="", encoding="utf-8") as f:
        yield from csv.reader(f)


def _assemble(conn, task, workdir):
    """全部页完成后：按库区合并分片，写各库区 csv、统计 manifest 和 zip。"""
    task_id = task["id"]
    outdir = os.path.join(workdir, "tasks", str(task_id))
    os.makedirs(outdir, exist_ok=True)

    zones = {}  # 保持出现顺序
    for p in done_pages(conn, task_id):
        for zone, no, pieces, ship_date in _read_fragment(p["fragment_path"]):
            zones.setdefault(zone, []).append((no, zone, int(pieces), ship_date))

    files = []  # (filename, row_count, total_pieces, path)
    for zone, rows in zones.items():
        name = f"{zone}.csv"
        path = os.path.join(outdir, name)
        with open(path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(CSV_HEADER)
            w.writerows(rows)
        files.append((name, len(rows), sum(r[2] for r in rows), path))

    manifest_path = os.path.join(outdir, MANIFEST_NAME)
    with open(manifest_path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["文件名", "行数", "总件数"])
        for name, row_count, total_pieces, _ in files:
            w.writerow([name, row_count, total_pieces])
        w.writerow(["合计", sum(f[1] for f in files), sum(f[2] for f in files)])
    files.append((MANIFEST_NAME, len(files), sum(f[2] for f in files),
                  manifest_path))

    zip_name = f"export_{task_id}_v{task['data_version']}.zip"
    zip_path = os.path.join(outdir, zip_name)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, _, _, path in files:
            z.write(path, arcname=name)

    with conn:
        for name, row_count, total_pieces, path in files:
            conn.execute(
                "INSERT OR REPLACE INTO export_files(task_id, filename, row_count,"
                " total_pieces, path) VALUES (?, ?, ?, ?, ?)",
                (task_id, name, row_count, total_pieces, path),
            )
        conn.execute(
            "INSERT OR REPLACE INTO export_files(task_id, filename, row_count,"
            " total_pieces, path) VALUES (?, ?, ?, ?, ?)",
            (task_id, zip_name, task["total_rows"], task["total_pieces"], zip_path),
        )
        conn.execute(
            "UPDATE export_tasks SET status = 'DONE' WHERE id = ?", (task_id,)
        )
