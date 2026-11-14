"""领取应用：发起浏览器自动化领取、查看运行过程、按门店查看入库文件。"""
import shutil

from flask import (
    Blueprint, abort, jsonify, redirect, render_template, request,
    send_file, url_for,
)

from . import config, db
from .harvest import start_harvest

bp = Blueprint("inbox", __name__)


@bp.get("/")
def index():
    month = request.args.get("month", "").strip()
    store = request.args.get("store", "").strip()

    conn = db.get_conn()
    try:
        months = db.distinct_months(conn)
        stores = db.distinct_stores(conn)
        rows = db.list_inbox(conn, month, store)
        runs = db.list_runs(conn)
    finally:
        conn.close()
    return render_template(
        "inbox/index.html",
        rows=rows, months=months, stores=stores,
        sel_month=month, sel_store=store, runs=runs,
    )


@bp.post("/harvest/start")
def harvest_start():
    month = request.form.get("month", "").strip()
    store = request.form.get("store", "").strip()
    run_id = start_harvest(month, store)
    return redirect(url_for("inbox.run_detail", run_id=run_id))


@bp.get("/harvest/runs/<int:run_id>")
def run_detail(run_id: int):
    conn = db.get_conn()
    try:
        run = db.get_run(conn, run_id)
        if run is None:
            abort(404)
        events = db.list_events(conn, run_id)
    finally:
        conn.close()
    return render_template("inbox/run.html", run=run, events=events)


@bp.get("/harvest/runs/<int:run_id>/events")
def run_events(run_id: int):
    """供页面轮询：返回最新事件与任务状态，任务结束后页面停止刷新。"""
    conn = db.get_conn()
    try:
        run = db.get_run(conn, run_id)
        if run is None:
            abort(404)
        events = db.list_events(conn, run_id)
    finally:
        conn.close()
    return jsonify({
        "status": run["status"],
        "stats": run["stats"],
        "finished": run["status"] in ("done", "failed"),
        "events": [dict(e) for e in events],
    })


@bp.get("/inbox/<int:inbox_id>")
def inbox_detail(inbox_id: int):
    conn = db.get_conn()
    try:
        row = db.get_inbox(conn, inbox_id)
    finally:
        conn.close()
    if row is None:
        abort(404)
    return render_template("inbox/detail.html", row=row)


def _stored_file(stored_path: str):
    target = (config.BASE_DIR / stored_path).resolve()
    if config.INBOX_DIR.resolve() not in target.parents or not target.is_file():
        abort(404)
    return target


@bp.get("/inbox/<int:inbox_id>/view")
def inbox_view(inbox_id: int):
    """浏览器内预览真正下载并归档的 PDF 文件。"""
    conn = db.get_conn()
    try:
        row = db.get_inbox(conn, inbox_id)
    finally:
        conn.close()
    if row is None:
        abort(404)
    target = _stored_file(row["stored_path"])
    return send_file(target, mimetype="application/pdf")  # 内联展示


@bp.get("/inbox/<int:inbox_id>/download")
def inbox_download(inbox_id: int):
    """下载已入库文件，文件名带门店/月份/编号/版本以区分同名附件。"""
    conn = db.get_conn()
    try:
        row = db.get_inbox(conn, inbox_id)
    finally:
        conn.close()
    if row is None:
        abort(404)
    target = _stored_file(row["stored_path"])
    download_name = (
        f"{row['store_name']}_{row['month']}_{row['doc_no']}_{row['version']}.pdf"
    )
    return send_file(target, as_attachment=True, download_name=download_name)


@bp.post("/admin/reset")
def admin_reset():
    """清空入库记录与领取日志（资料站原始数据不动），方便重复演示。"""
    conn = db.get_conn()
    try:
        conn.execute("DELETE FROM harvest_events")
        conn.execute("DELETE FROM harvest_runs")
        conn.execute("DELETE FROM inbox")
        conn.commit()
    finally:
        conn.close()
    if config.INBOX_DIR.exists():
        shutil.rmtree(config.INBOX_DIR)
    return redirect(url_for("inbox.index"))
