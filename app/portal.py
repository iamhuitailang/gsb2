"""模拟资料站：按月份/门店查询已发布月报，分页展示，附件点击下载。"""
import math

from flask import Blueprint, abort, render_template, request, send_file

from . import config, db

bp = Blueprint("portal", __name__, url_prefix="/portal")


@bp.get("/")
def index():
    month = request.args.get("month", "").strip()
    store = request.args.get("store", "").strip()
    try:
        page = max(1, int(request.args.get("page", 1)))
    except ValueError:
        page = 1

    conn = db.get_conn()
    try:
        months = db.distinct_months(conn)
        stores = db.distinct_stores(conn)
        rows, total = db.list_reports(
            conn, month, store, config.PAGE_SIZE, (page - 1) * config.PAGE_SIZE
        )
    finally:
        conn.close()

    total_pages = max(1, math.ceil(total / config.PAGE_SIZE))
    page = min(page, total_pages)

    def q(target_page: int) -> str:
        params = []
        if month:
            params.append(f"month={month}")
        if store:
            params.append(f"store={store}")
        params.append(f"page={target_page}")
        return "/portal/?" + "&".join(params)

    return render_template(
        "portal/index.html",
        rows=rows,
        months=months,
        stores=stores,
        sel_month=month,
        sel_store=store,
        page=page,
        total=total,
        total_pages=total_pages,
        page_size=config.PAGE_SIZE,
        q=q,
    )


@bp.get("/download/<doc_no>/<version>")
def download(doc_no: str, version: str):
    """资料站附件下载：保留资料站上的原始文件名（均为 月报.pdf）。"""
    conn = db.get_conn()
    try:
        row = db.get_report(conn, doc_no, version)
    finally:
        conn.close()
    if row is None:
        abort(404)

    target = (config.SOURCE_DIR / row["source_path"]).resolve()
    if config.SOURCE_DIR.resolve() not in target.parents or not target.is_file():
        abort(404)
    return send_file(target, as_attachment=True, download_name=row["filename"])
