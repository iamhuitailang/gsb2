"""本地工单系统：主管批量关闭工单。

- 主管只能关闭本组且状态为 open 的工单；组外工单与已归档工单不可动。
- 预览接口逐条校验选中编号，只回可关闭数量。
- 执行接口在提交时重新查询每张工单的所属组与状态（不信任预览时的快照）。
- 批次结果中，组外条目只显示"无权处理"，不携带组外工单的标题与状态。
- 批次号幂等：同一批次重复提交不会重复写关闭记录。
"""

import json
import sqlite3
import uuid
from datetime import datetime, timezone

from flask import Flask, g, jsonify, render_template, request, session

PAGE_SIZE = 5
STATUS_OPEN = "open"
STATUS_ARCHIVED = "archived"

SCHEMA = """
CREATE TABLE IF NOT EXISTS groups (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
    id       INTEGER PRIMARY KEY,
    title    TEXT NOT NULL,
    group_id INTEGER NOT NULL REFERENCES groups(id),
    status   TEXT NOT NULL CHECK (status IN ('open', 'archived'))
);
CREATE TABLE IF NOT EXISTS batches (
    id         TEXT PRIMARY KEY,
    group_id   INTEGER NOT NULL,
    result     TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS close_records (
    id         INTEGER PRIMARY KEY,
    batch_id   TEXT NOT NULL REFERENCES batches(id),
    ticket_id  INTEGER NOT NULL,
    closed_at  TEXT NOT NULL,
    UNIQUE (batch_id, ticket_id),
    UNIQUE (ticket_id)          -- 一张工单最多被关闭一次
);
"""

SEED_GROUPS = [(1, "甲组"), (2, "乙组")]
SEED_TICKETS = [
    # id, title, group_id, status
    (1, "网络故障报修", 1, "open"),
    (2, "网络故障报修", 1, "open"),
    (3, "网络故障报修", 2, "open"),   # 乙组同名工单
    (4, "电脑无法开机", 1, "open"),
    (5, "打印机卡纸", 1, "archived"),
    (6, "投影仪无信号", 2, "open"),
    (7, "门禁卡失效", 1, "open"),
    (8, "会议室灯不亮", 2, "open"),
]


def create_app(db_path="tickets.db"):
    app = Flask(__name__)
    app.secret_key = "local-demo-secret"
    app.config["DB_PATH"] = db_path

    def get_db():
        if "db" not in g:
            conn = sqlite3.connect(app.config["DB_PATH"])
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            g.db = conn
        return g.db

    @app.teardown_appcontext
    def close_db(_exc):
        conn = g.pop("db", None)
        if conn is not None:
            conn.close()

    def init_db():
        conn = sqlite3.connect(app.config["DB_PATH"])
        conn.executescript(SCHEMA)
        if conn.execute("SELECT COUNT(*) FROM groups").fetchone()[0] == 0:
            conn.executemany("INSERT INTO groups VALUES (?, ?)", SEED_GROUPS)
            conn.executemany("INSERT INTO tickets VALUES (?, ?, ?, ?)", SEED_TICKETS)
        conn.commit()
        conn.close()

    init_db()

    def supervisor_group_id():
        # 简化登录：当前主管所属组存于 session，默认甲组主管
        return session.get("group_id", 1)

    # ---------- 页面 ----------

    @app.route("/")
    def index():
        db = get_db()
        groups = db.execute("SELECT * FROM groups").fetchall()
        return render_template(
            "index.html",
            groups=groups,
            current_group_id=supervisor_group_id(),
        )

    @app.post("/api/login")
    def login():
        group_id = request.json.get("group_id")
        db = get_db()
        if db.execute("SELECT 1 FROM groups WHERE id = ?", (group_id,)).fetchone():
            session["group_id"] = group_id
            return jsonify({"ok": True, "group_id": group_id})
        return jsonify({"ok": False, "error": "组不存在"}), 404

    @app.get("/api/tickets")
    def list_tickets():
        page = max(1, int(request.args.get("page", 1)))
        db = get_db()
        total = db.execute("SELECT COUNT(*) c FROM tickets").fetchone()["c"]
        pages = max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE)
        page = min(page, pages)
        rows = db.execute(
            """
            SELECT t.id, t.title, t.status, g.name AS group_name
            FROM tickets t JOIN groups g ON g.id = t.group_id
            ORDER BY t.id LIMIT ? OFFSET ?
            """,
            (PAGE_SIZE, (page - 1) * PAGE_SIZE),
        ).fetchall()
        return jsonify(
            {
                "items": [dict(r) for r in rows],
                "page": page,
                "pages": pages,
                "total": total,
            }
        )

    # ---------- 批量关闭 ----------

    def parse_ids():
        ids = request.json.get("ids") or []
        # 去重并保持顺序，过滤非法值
        seen, out = set(), []
        for x in ids:
            if isinstance(x, int) and x not in seen:
                seen.add(x)
                out.append(x)
        return out

    @app.post("/api/preview")
    def preview():
        """提交前预览：逐条校验编号，只返回可关闭数量。"""
        ids = parse_ids()
        gid = supervisor_group_id()
        db = get_db()
        closable = 0
        for tid in ids:
            row = db.execute(
                "SELECT 1 FROM tickets WHERE id = ? AND group_id = ? AND status = ?",
                (tid, gid, STATUS_OPEN),
            ).fetchone()
            if row:
                closable += 1
        return jsonify({"total": len(ids), "closable": closable})

    @app.post("/api/batch-close")
    def batch_close():
        """执行批量关闭。提交时重新查询每张工单的所属组与状态。"""
        ids = parse_ids()
        batch_id = request.json.get("batch_id") or uuid.uuid4().hex
        gid = supervisor_group_id()
        db = get_db()

        # 幂等：同批次号直接返回已存结果，不再写任何记录
        row = db.execute("SELECT result FROM batches WHERE id = ?", (batch_id,)).fetchone()
        if row:
            result = json.loads(row["result"])
            result["replayed"] = True
            return jsonify(result)

        now = datetime.now(timezone.utc).isoformat()
        result = {"batch_id": batch_id, "closed": [], "not_processed": []}
        try:
            with db:  # 事务：整批要么全部落库，要么整体回滚
                # 先登记批次（close_records 外键依赖），最后再回填结果
                db.execute(
                    "INSERT INTO batches (id, group_id, result, created_at) VALUES (?, ?, '', ?)",
                    (batch_id, gid, now),
                )
                for tid in ids:
                    # 执行时实时查询当前所属组与状态
                    t = db.execute("SELECT * FROM tickets WHERE id = ?", (tid,)).fetchone()
                    if t is None:
                        result["not_processed"].append({"id": tid, "reason": "工单不存在"})
                    elif t["group_id"] != gid:
                        # 组外条目：只报无权处理，不带标题与状态
                        result["not_processed"].append({"id": tid, "reason": "无权处理"})
                    elif t["status"] != STATUS_OPEN:
                        result["not_processed"].append(
                            {"id": tid, "title": t["title"], "reason": "已归档，无需处理"}
                        )
                    else:
                        db.execute(
                            "UPDATE tickets SET status = ? WHERE id = ? AND status = ?",
                            (STATUS_ARCHIVED, tid, STATUS_OPEN),
                        )
                        db.execute(
                            "INSERT INTO close_records (batch_id, ticket_id, closed_at) VALUES (?, ?, ?)",
                            (batch_id, tid, now),
                        )
                        result["closed"].append({"id": tid, "title": t["title"]})
                db.execute(
                    "UPDATE batches SET result = ? WHERE id = ?",
                    (json.dumps(result, ensure_ascii=False), batch_id),
                )
        except sqlite3.IntegrityError:
            # 并发下同批次号或同工单已被处理：返回已存结果
            row = db.execute("SELECT result FROM batches WHERE id = ?", (batch_id,)).fetchone()
            if row:
                result = json.loads(row["result"])
                result["replayed"] = True
                return jsonify(result)
            raise
        return jsonify(result)

    # ---------- 演示/管理工具 ----------

    @app.post("/api/transfer")
    def transfer():
        """工单转组（演示用管理动作）。"""
        tid = request.json.get("ticket_id")
        to_group = request.json.get("to_group_id")
        db = get_db()
        with db:
            cur = db.execute(
                "UPDATE tickets SET group_id = ? WHERE id = ?", (to_group, tid)
            )
        if cur.rowcount == 0:
            return jsonify({"ok": False, "error": "工单不存在"}), 404
        return jsonify({"ok": True})

    @app.get("/api/close-records")
    def close_records():
        db = get_db()
        rows = db.execute(
            "SELECT batch_id, ticket_id, closed_at FROM close_records ORDER BY id"
        ).fetchall()
        return jsonify([dict(r) for r in rows])

    return app


app = create_app()

if __name__ == "__main__":
    app.run(debug=True, port=5000)
