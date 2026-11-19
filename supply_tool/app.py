# -*- coding: utf-8 -*-
"""本地 Flask 校对界面。"""
import csv
import hashlib
import io
import os
import shutil
from datetime import datetime

import pymupdf
from flask import (Flask, abort, redirect, render_template, request,
                   send_file, url_for)

from . import parser
from .samples import ensure_samples
from .store import Store

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.join(HERE, "..")
DATA_DIR = os.path.join(BASE, "data")
FILES_DIR = os.path.join(DATA_DIR, "files")
ZOOM = 1.5

app = Flask(__name__, template_folder=os.path.join(HERE, "templates"))
store = Store(os.path.join(DATA_DIR, "store.json"))


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _effective_rows(parse, edits):
    """解析结果叠加用户修改。"""
    rows = []
    for r in parse["rows"]:
        row = dict(r)
        e = edits.get(row["key"])
        if e:
            for k, v in e.items():
                row[k] = v
            row["edited"] = True
        rows.append(row)
    return rows


def _doc_view(h, doc):
    parse = doc["parse"]
    rows = _effective_rows(parse, doc.get("edits", {}))
    ok, total, problems = parser.verify(rows, parse["printed_total"])
    snap = doc.get("snapshot")
    modified_after_confirm = bool(snap) and _snapshot_rows(snap) != _plain_rows(rows)
    return {
        "hash": h, "doc": doc, "parse": parse, "rows": rows,
        "total_ok": ok, "sum_total": total, "problems": problems,
        "flag_labels": parser.FLAG_LABELS,
        "uncertain": [r for r in rows if set(r["flags"]) & {"name_split", "incomplete", "conflict"}],
        "modified_after_confirm": modified_after_confirm,
    }


def _plain_rows(rows):
    return [[r.get("no", ""), r.get("name", ""), r.get("qty", ""),
             r.get("price", ""), r.get("amount", "")] for r in rows]


def _snapshot_rows(snap):
    return [[r.get("no", ""), r.get("name", ""), r.get("qty", ""),
             r.get("price", ""), r.get("amount", "")] for r in snap["rows"]]


def _ingest(path, filename):
    """解析(或重复解析)一份 PDF, 保留已有校对记录, 返回文档 hash。"""
    h = _sha256(path)
    os.makedirs(FILES_DIR, exist_ok=True)
    dst = os.path.join(FILES_DIR, h + ".pdf")
    if not os.path.exists(dst):
        shutil.copyfile(path, dst)
    parse = parser.parse_document(dst)
    doc = store.get(h)
    if doc is None:
        doc = {"filename": filename, "first_seen": _now(), "status": "parsed",
               "edits": {}, "snapshot": None}
    doc["parse"] = parse
    doc["last_parsed"] = _now()
    store.put(h, doc)
    return h


@app.route("/")
def index():
    docs = []
    for h, d in sorted(store.all().items(),
                       key=lambda kv: kv[1].get("last_parsed", ""), reverse=True):
        rows = _effective_rows(d["parse"], d.get("edits", {}))
        ok, total, _ = parser.verify(rows, d["parse"]["printed_total"])
        docs.append({"hash": h, "doc": d, "total_ok": ok, "sum_total": total})
    return render_template("index.html", docs=docs)


@app.route("/parse", methods=["POST"])
def parse():
    sample = request.form.get("sample")
    if sample:
        p1, p2 = ensure_samples()
        path = p1 if sample == "1" else p2
        h = _ingest(path, os.path.basename(path))
        return redirect(url_for("doc_page", h=h))
    f = request.files.get("file")
    if not f or not f.filename:
        return redirect(url_for("index"))
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = os.path.join(DATA_DIR, "upload.tmp")
    f.save(tmp)
    try:
        h = _ingest(tmp, f.filename)
    except parser.ParseError as e:
        os.remove(tmp)
        return str(e), 400
    os.remove(tmp)
    return redirect(url_for("doc_page", h=h))


@app.route("/doc/<h>")
def doc_page(h):
    doc = store.get(h)
    if not doc:
        abort(404)
    view = _doc_view(h, doc)
    # 每页的原文位置框
    pages = []
    for n in range(1, view["parse"]["page_count"] + 1):
        w, hh = view["parse"]["page_sizes"][n - 1]
        pages.append({"n": n, "w": w * ZOOM, "h": hh * ZOOM, "boxes": []})
    for r in view["rows"]:
        cls = "flag" if set(r["flags"]) & {"name_split", "incomplete", "conflict"} else "ok"
        for seg in r["segments"]:
            x0, y0, x1, y1 = seg["bbox"]
            pages[seg["page"] - 1]["boxes"].append({
                "left": x0 * ZOOM, "top": y0 * ZOOM,
                "width": (x1 - x0) * ZOOM, "height": (y1 - y0) * ZOOM,
                "cls": cls, "key": r["key"], "title": seg["text"],
            })
    for seg in view["parse"]["orphans"]:
        x0, y0, x1, y1 = seg["bbox"]
        pages[seg["page"] - 1]["boxes"].append({
            "left": x0 * ZOOM, "top": y0 * ZOOM,
            "width": (x1 - x0) * ZOOM, "height": (y1 - y0) * ZOOM,
            "cls": "orphan", "key": "", "title": seg["text"],
        })
    return render_template("doc.html", pages=pages, zoom=ZOOM, **view)


@app.route("/doc/<h>/page/<int:n>.png")
def page_png(h, n):
    doc = store.get(h)
    if not doc:
        abort(404)
    pdf = pymupdf.open(os.path.join(FILES_DIR, h + ".pdf"))
    try:
        pix = pdf[n - 1].get_pixmap(matrix=pymupdf.Matrix(ZOOM, ZOOM))
        return send_file(io.BytesIO(pix.tobytes("png")), mimetype="image/png")
    finally:
        pdf.close()


@app.route("/doc/<h>/edits", methods=["POST"])
def save_edits(h):
    doc = store.get(h)
    if not doc:
        abort(404)
    edits = {}
    for r in doc["parse"]["rows"]:
        key = r["key"]
        e = {}
        for k in ("name", "qty", "price", "amount"):
            v = request.form.get("%s__%s" % (k, key), "").strip()
            if v != r.get(k, ""):
                e[k] = v
        if e:
            edits[key] = e
    doc["edits"] = edits
    if doc["status"] != "confirmed":
        doc["status"] = "reviewing"
    store.put(h, doc)
    return redirect(url_for("doc_page", h=h))


@app.route("/doc/<h>/reparse", methods=["POST"])
def reparse(h):
    doc = store.get(h)
    if not doc:
        abort(404)
    doc["parse"] = parser.parse_document(os.path.join(FILES_DIR, h + ".pdf"))
    doc["last_parsed"] = _now()
    store.put(h, doc)
    return redirect(url_for("doc_page", h=h))


@app.route("/doc/<h>/confirm", methods=["POST"])
def confirm(h):
    doc = store.get(h)
    if not doc:
        abort(404)
    view = _doc_view(h, doc)
    if not view["total_ok"]:
        return "合计未核对相符, 不能入库。请先校对明细。", 400
    doc["snapshot"] = {
        "confirmed_at": _now(),
        "filename": doc["filename"],
        "order_no": view["parse"]["order_no"],
        "printed_total": view["parse"]["printed_total"],
        "sum_total": view["sum_total"],
        "rows": [{k: r.get(k, "") for k in
                  ("no", "name", "qty", "price", "amount", "pages", "flags")}
                 for r in view["rows"]],
    }
    doc["status"] = "confirmed"
    store.put(h, doc)
    return redirect(url_for("doc_page", h=h))


@app.route("/doc/<h>/export.csv")
def export_csv(h):
    doc = store.get(h)
    if not doc:
        abort(404)
    view = _doc_view(h, doc)
    snap = doc.get("snapshot")
    rows = snap["rows"] if snap else view["rows"]
    order_no = snap["order_no"] if snap else view["parse"]["order_no"]
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["单号", "行号", "品名", "数量", "单价", "金额(元)", "页码", "校对状态"])
    for r in rows:
        pages = ",".join(str(p) for p in r.get("pages", []))
        status = "已入库" if snap else ("已修改" if r.get("edited") else "提取")
        w.writerow([order_no, r.get("no", ""), r.get("name", ""), r.get("qty", ""),
                    r.get("price", ""), r.get("amount", ""), pages, status])
    if snap:
        w.writerow([order_no, "", "合计", "", "", snap["sum_total"], "", "已入库"])
    out = io.BytesIO(buf.getvalue().encode("utf-8-sig"))
    name = "supply_%s.csv" % (order_no or h[:8])
    return send_file(out, mimetype="text/csv", as_attachment=True, download_name=name)


def main():
    os.makedirs(FILES_DIR, exist_ok=True)
    ensure_samples()
    app.run(host="127.0.0.1", port=8765, debug=False)
