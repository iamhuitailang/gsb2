"""包裹入库规则工作台（本地 Flask 应用）。

功能：
- 规则版本管理：草稿保存即产生新版本号；审批发布后生效；可回滚到历史版本
- 批次入库：创建批次时绑定当前生效规则版本，已开始的批次不受后续发布影响
- 预跑：选一个已完成批次，用生效规则与草稿各跑一遍，只保存对比报告，不改正式结果
- 批次详情：原始行、校验结果、所用规则版本可追溯
"""
import csv
import io
import json
import os

from flask import Flask, abort, g, redirect, render_template, request, url_for

import db as dbmod
from rules import CHANGE_TYPE_LABELS, DEFAULT_CONFIG, compare_results, validate_row

DATABASE = os.environ.get("WORKBENCH_DB", os.path.join(os.path.dirname(__file__), "workbench.db"))

app = Flask(__name__)
app.config["DATABASE"] = DATABASE


def get_db():
    if "db" not in g:
        g.db = dbmod.connect(app.config["DATABASE"])
    return g.db


@app.teardown_appcontext
def close_db(exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


@app.template_filter("jsonloads")
def jsonloads_filter(s):
    return json.loads(s) if s else []


@app.context_processor
def inject_labels():
    return {"change_labels": CHANGE_TYPE_LABELS}


# ---------------- 规则版本 ----------------

@app.route("/")
def index():
    conn = get_db()
    published = dbmod.get_published(conn)
    drafts = conn.execute(
        "SELECT * FROM rule_versions WHERE status = 'draft' ORDER BY version_no DESC"
    ).fetchall()
    batches = conn.execute(
        "SELECT b.*, rv.version_no FROM batches b"
        " JOIN rule_versions rv ON rv.id = b.rule_version_id"
        " ORDER BY b.id DESC"
    ).fetchall()
    reports = conn.execute(
        "SELECT r.*, b.name AS batch_name, dv.version_no AS draft_no, bv.version_no AS base_no"
        " FROM dryrun_reports r"
        " JOIN batches b ON b.id = r.batch_id"
        " JOIN rule_versions dv ON dv.id = r.draft_version_id"
        " JOIN rule_versions bv ON bv.id = r.base_version_id"
        " ORDER BY r.id DESC"
    ).fetchall()
    return render_template("index.html", published=published, drafts=drafts,
                           batches=batches, reports=reports)


@app.route("/rules")
def rule_list():
    conn = get_db()
    versions = conn.execute("SELECT * FROM rule_versions ORDER BY version_no DESC").fetchall()
    events = conn.execute(
        "SELECT e.*, rv.version_no FROM publish_events e"
        " JOIN rule_versions rv ON rv.id = e.version_id ORDER BY e.id DESC"
    ).fetchall()
    return render_template("rules.html", versions=versions, events=events)


def _config_from_form(form):
    try:
        wmin = float(form.get("weight_min", "0"))
        wmax = float(form.get("weight_max", "0"))
    except ValueError:
        abort(400, "重量区间必须是数字")
    if wmin > wmax:
        abort(400, "重量下限不能大于上限")
    service_types = [s.strip() for s in form.get("service_types", "").split(",") if s.strip()]
    if not service_types:
        abort(400, "服务类型允许值不能为空")
    return {
        "weight": {"min": wmin, "max": wmax},
        "service_types": service_types,
        "cold_chain_requires_temp_zone": form.get("cold_chain_requires_temp_zone") == "on",
    }


@app.route("/rules/new")
def rule_new():
    conn = get_db()
    base = None
    from_id = request.args.get("from", type=int)
    if from_id:
        base = conn.execute("SELECT * FROM rule_versions WHERE id = ?", (from_id,)).fetchone()
    if base is None:
        base = dbmod.get_published(conn)
    config = json.loads(base["config_json"]) if base else DEFAULT_CONFIG
    return render_template("rule_edit.html", config=config, base=base)


@app.route("/rules", methods=["POST"])
def rule_create():
    conn = get_db()
    config = _config_from_form(request.form)
    note = request.form.get("note", "").strip()
    vid = dbmod.create_version(conn, json.dumps(config, ensure_ascii=False), note)
    conn.commit()
    return redirect(url_for("rule_detail", vid=vid))


@app.route("/rules/<int:vid>")
def rule_detail(vid):
    conn = get_db()
    version = conn.execute("SELECT * FROM rule_versions WHERE id = ?", (vid,)).fetchone()
    if not version:
        abort(404)
    used_by = conn.execute(
        "SELECT id, name, status, created_at FROM batches WHERE rule_version_id = ? ORDER BY id DESC",
        (vid,),
    ).fetchall()
    config = json.loads(version["config_json"])
    return render_template("rule_detail.html", v=version, config=config, used_by=used_by)


@app.route("/rules/<int:vid>/publish", methods=["POST"])
def rule_publish(vid):
    conn = get_db()
    version = conn.execute("SELECT * FROM rule_versions WHERE id = ?", (vid,)).fetchone()
    if not version:
        abort(404)
    if version["status"] == "published":
        abort(400, "该版本已生效")
    operator = request.form.get("operator", "").strip()
    action = "rollback" if version["status"] == "archived" else "publish"
    dbmod.publish_version(conn, vid, operator=operator, action=action)
    conn.commit()
    return redirect(url_for("rule_detail", vid=vid))


# ---------------- 批次 ----------------

def parse_rows(csv_text):
    """解析 CSV：包裹号,重量kg,服务类型,是否冷链,温区"""
    rows = []
    reader = csv.reader(io.StringIO(csv_text.strip()))
    for i, cols in enumerate(reader, start=1):
        cols = [c.strip() for c in cols]
        if not any(cols):
            continue
        if i == 1 and cols[0] in ("包裹号", "parcel_no"):
            continue  # 表头
        cols += [""] * (5 - len(cols))
        parcel_no, weight_s, service_type, cold_s, temp_zone = cols[:5]
        try:
            weight = float(weight_s)
        except ValueError:
            weight = None
        rows.append({
            "raw_line": ",".join(cols[:5]),
            "parcel_no": parcel_no,
            "weight": weight,
            "service_type": service_type,
            "is_cold_chain": cold_s in ("是", "Y", "y", "true", "1"),
            "temp_zone": temp_zone,
        })
    return rows


@app.route("/batches/new")
def batch_new():
    return render_template("batch_new.html", published=dbmod.get_published(get_db()))


@app.route("/batches", methods=["POST"])
def batch_create():
    conn = get_db()
    published = dbmod.get_published(conn)
    if not published:
        abort(400, "当前没有生效的规则版本，无法创建批次")
    name = request.form.get("name", "").strip()
    if not name:
        abort(400, "批次名称不能为空")
    rows = parse_rows(request.form.get("csv_text", ""))
    if not rows:
        abort(400, "批次数据为空")

    config = json.loads(published["config_json"])
    # 批次启动即绑定当前生效版本，之后规则变更不影响本批次
    cur = conn.execute(
        "INSERT INTO batches (name, status, rule_version_id, created_at) VALUES (?,?,?,?)",
        (name, "completed", published["id"], dbmod.now()),
    )
    batch_id = cur.lastrowid
    pass_count = 0
    for i, row in enumerate(rows, start=1):
        cur = conn.execute(
            "INSERT INTO batch_rows (batch_id, row_no, raw_line, parcel_no, weight,"
            " service_type, is_cold_chain, temp_zone) VALUES (?,?,?,?,?,?,?,?)",
            (batch_id, i, row["raw_line"], row["parcel_no"], row["weight"],
             row["service_type"], int(row["is_cold_chain"]), row["temp_zone"]),
        )
        outcome, reasons = validate_row(config, row)
        conn.execute(
            "INSERT INTO validation_results (batch_row_id, rule_version_id, outcome, reasons_json)"
            " VALUES (?,?,?,?)",
            (cur.lastrowid, published["id"], outcome, json.dumps(reasons, ensure_ascii=False)),
        )
        if outcome == "pass":
            pass_count += 1
    conn.execute(
        "UPDATE batches SET total_rows = ?, pass_count = ?, reject_count = ? WHERE id = ?",
        (len(rows), pass_count, len(rows) - pass_count, batch_id),
    )
    conn.commit()
    return redirect(url_for("batch_detail", bid=batch_id))


@app.route("/batches/<int:bid>")
def batch_detail(bid):
    conn = get_db()
    batch = conn.execute("SELECT * FROM batches WHERE id = ?", (bid,)).fetchone()
    if not batch:
        abort(404)
    version = conn.execute("SELECT * FROM rule_versions WHERE id = ?",
                           (batch["rule_version_id"],)).fetchone()
    rows = conn.execute(
        "SELECT br.*, vr.outcome, vr.reasons_json FROM batch_rows br"
        " LEFT JOIN validation_results vr ON vr.batch_row_id = br.id"
        " AND vr.rule_version_id = ?"
        " WHERE br.batch_id = ? ORDER BY br.row_no",
        (batch["rule_version_id"], bid),
    ).fetchall()
    return render_template("batch_detail.html", batch=batch, version=version,
                           config=json.loads(version["config_json"]), rows=rows)


# ---------------- 预跑 ----------------

@app.route("/dryrun/new")
def dryrun_new():
    conn = get_db()
    batches = conn.execute(
        "SELECT * FROM batches WHERE status = 'completed' ORDER BY id DESC").fetchall()
    drafts = conn.execute(
        "SELECT * FROM rule_versions WHERE status = 'draft' ORDER BY version_no DESC").fetchall()
    return render_template("dryrun_new.html", batches=batches, drafts=drafts,
                           published=dbmod.get_published(conn))


@app.route("/dryrun", methods=["POST"])
def dryrun_create():
    conn = get_db()
    batch_id = request.form.get("batch_id", type=int)
    draft_id = request.form.get("draft_id", type=int)
    batch = conn.execute("SELECT * FROM batches WHERE id = ?", (batch_id,)).fetchone()
    draft = conn.execute("SELECT * FROM rule_versions WHERE id = ?", (draft_id,)).fetchone()
    if not batch or not draft:
        abort(404)
    base = conn.execute("SELECT * FROM rule_versions WHERE id = ?",
                        (batch["rule_version_id"],)).fetchone()
    base_config = json.loads(base["config_json"])
    draft_config = json.loads(draft["config_json"])

    rows = conn.execute("SELECT * FROM batch_rows WHERE batch_id = ? ORDER BY row_no",
                        (batch_id,)).fetchall()
    counts = {"pass_to_reject": 0, "reject_to_pass": 0, "reason_changed": 0, "unchanged": 0}
    compared = []
    for r in rows:
        record = {"weight": r["weight"], "service_type": r["service_type"],
                  "is_cold_chain": bool(r["is_cold_chain"]), "temp_zone": r["temp_zone"]}
        base_outcome, base_reasons = validate_row(base_config, record)
        draft_outcome, draft_reasons = validate_row(draft_config, record)
        change = compare_results(base_outcome, base_reasons, draft_outcome, draft_reasons)
        counts[change] += 1
        compared.append((r["id"], change, base_outcome, base_reasons,
                         draft_outcome, draft_reasons))

    # 预跑只保存报告，不回写正式校验结果
    cur = conn.execute(
        "INSERT INTO dryrun_reports (batch_id, base_version_id, draft_version_id,"
        " pass_to_reject, reject_to_pass, reason_changed, unchanged, created_at)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (batch_id, base["id"], draft_id, counts["pass_to_reject"], counts["reject_to_pass"],
         counts["reason_changed"], counts["unchanged"], dbmod.now()),
    )
    report_id = cur.lastrowid
    for row_id, change, bo, br, do, dr in compared:
        conn.execute(
            "INSERT INTO dryrun_report_rows (report_id, batch_row_id, change_type,"
            " base_outcome, base_reasons_json, draft_outcome, draft_reasons_json)"
            " VALUES (?,?,?,?,?,?,?)",
            (report_id, row_id, change, bo, json.dumps(br, ensure_ascii=False),
             do, json.dumps(dr, ensure_ascii=False)),
        )
    conn.commit()
    return redirect(url_for("dryrun_detail", rid=report_id))


@app.route("/dryrun/<int:rid>")
def dryrun_detail(rid):
    conn = get_db()
    report = conn.execute("SELECT * FROM dryrun_reports WHERE id = ?", (rid,)).fetchone()
    if not report:
        abort(404)
    batch = conn.execute("SELECT * FROM batches WHERE id = ?", (report["batch_id"],)).fetchone()
    base_v = conn.execute("SELECT * FROM rule_versions WHERE id = ?",
                          (report["base_version_id"],)).fetchone()
    draft_v = conn.execute("SELECT * FROM rule_versions WHERE id = ?",
                           (report["draft_version_id"],)).fetchone()
    show = request.args.get("show", "changed")
    query = (
        "SELECT rr.*, br.row_no, br.raw_line, br.parcel_no FROM dryrun_report_rows rr"
        " JOIN batch_rows br ON br.id = rr.batch_row_id WHERE rr.report_id = ?"
    )
    if show != "all":
        query += " AND rr.change_type != 'unchanged'"
    rows = conn.execute(query + " ORDER BY br.row_no", (rid,)).fetchall()
    return render_template("dryrun_detail.html", report=report, batch=batch,
                           base_v=base_v, draft_v=draft_v, rows=rows, show=show)


# ---------------- 演示数据 ----------------

@app.route("/seed", methods=["POST"])
def seed():
    from seed import load_demo_data
    conn = get_db()
    load_demo_data(conn)
    conn.commit()
    return redirect(url_for("index"))


if __name__ == "__main__":
    dbmod.init_db(app.config["DATABASE"])
    app.run(debug=True, port=5001)
