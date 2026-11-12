"""FastAPI 入口：规则管理、运行控制、结果查询、差异对比、导出。"""
import csv
import difflib
import io
import json
import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

from . import crawler, db

app = FastAPI(title="网页采集与变更追踪")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup():
    db.init_db()


def rows(sql, params=()):
    return [dict(r) for r in db.query(sql, params)]


# ---------- 规则 ----------

class RuleIn(BaseModel):
    name: str
    start_url: str
    max_pages: int = 100
    delay_ms: int = 500
    retry_times: int = 2
    same_domain: bool = True
    include_pattern: str = ""
    exclude_pattern: str = ""


@app.get("/api/rules")
def list_rules():
    return rows("SELECT * FROM rules ORDER BY id")


@app.post("/api/rules")
def create_rule(rule: RuleIn):
    now = time.time()
    rid = db.execute(
        """INSERT INTO rules (name, start_url, max_pages, delay_ms, retry_times,
                              same_domain, include_pattern, exclude_pattern,
                              created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (rule.name, rule.start_url, rule.max_pages, rule.delay_ms, rule.retry_times,
         int(rule.same_domain), rule.include_pattern, rule.exclude_pattern, now, now),
    )
    return {"id": rid}


@app.put("/api/rules/{rule_id}")
def update_rule(rule_id: int, rule: RuleIn):
    db.execute(
        """UPDATE rules SET name=?, start_url=?, max_pages=?, delay_ms=?, retry_times=?,
                            same_domain=?, include_pattern=?, exclude_pattern=?, updated_at=?
           WHERE id=?""",
        (rule.name, rule.start_url, rule.max_pages, rule.delay_ms, rule.retry_times,
         int(rule.same_domain), rule.include_pattern, rule.exclude_pattern,
         time.time(), rule_id),
    )
    return {"ok": True}


# ---------- 运行 ----------

@app.post("/api/rules/{rule_id}/runs")
def start_run(rule_id: int):
    run_id = crawler.start_run(rule_id)
    if run_id is None:
        raise HTTPException(404, "规则不存在")
    return {"run_id": run_id}


@app.get("/api/runs")
def list_runs():
    return rows(
        """SELECT r.*, ru.name AS rule_name, ru.start_url
           FROM runs r JOIN rules ru ON ru.id = r.rule_id
           ORDER BY r.id DESC"""
    )


@app.get("/api/runs/{run_id}")
def get_run(run_id: int):
    r = db.query_one(
        """SELECT r.*, ru.name AS rule_name, ru.start_url
           FROM runs r JOIN rules ru ON ru.id = r.rule_id WHERE r.id=?""",
        (run_id,),
    )
    if r is None:
        raise HTTPException(404, "运行不存在")
    return dict(r)


@app.get("/api/runs/{run_id}/pages")
def run_pages(run_id: int):
    return rows(
        """SELECT url, title, updated_text, status, content_hash, fetched_at
           FROM page_history WHERE run_id=? ORDER BY id""",
        (run_id,),
    )


# ---------- 当前页面 ----------

@app.get("/api/pages")
def list_pages():
    return rows("SELECT * FROM pages ORDER BY url")


# ---------- 差异对比 ----------

@app.get("/api/diff")
def diff_runs(run_a: int, run_b: int):
    """两次运行之间页面级别的差异概览。"""
    def snapshot(run_id):
        return {
            r["url"]: dict(r)
            for r in db.query(
                "SELECT url, title, content_hash, status FROM page_history WHERE run_id=?",
                (run_id,),
            )
        }

    a, b = snapshot(run_a), snapshot(run_b)
    result = []
    for url in sorted(set(a) | set(b)):
        pa, pb = a.get(url), b.get(url)
        if pa is None:
            change = "appeared"      # B 中新增
        elif pb is None:
            change = "disappeared"   # B 中消失
        elif pb["status"] == "removed":
            change = "disappeared"
        elif pa["status"] == "removed":
            change = "appeared"
        elif pa["content_hash"] != pb["content_hash"]:
            change = "modified"
        else:
            change = "same"
        result.append({
            "url": url,
            "change": change,
            "title": (pb or pa)["title"],
            "status_a": pa["status"] if pa else None,
            "status_b": pb["status"] if pb else None,
        })
    return result


@app.get("/api/diff/page")
def diff_page(run_a: int, run_b: int, url: str):
    """单个页面在两次运行间的正文 unified diff。"""
    def get(run_id):
        r = db.query_one(
            "SELECT title, content, updated_text, status FROM page_history "
            "WHERE run_id=? AND url=?", (run_id, url))
        return dict(r) if r else None

    a, b = get(run_a), get(run_b)
    diff_text = ""
    if a and b:
        diff_text = "\n".join(difflib.unified_diff(
            a["content"].splitlines(), b["content"].splitlines(),
            fromfile=f"run#{run_a}", tofile=f"run#{run_b}", lineterm="",
        ))
    return {"url": url, "a": a, "b": b, "diff": diff_text}


# ---------- 导出 ----------

@app.get("/api/export/current")
def export_current(format: str = "json"):
    data = rows(
        """SELECT url, title, updated_text, status, content_hash,
                  first_seen_run, last_seen_run, last_fetch_at
           FROM pages WHERE status != 'removed' ORDER BY url"""
    )
    if format == "csv":
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=list(data[0].keys()) if data else
                                ["url", "title", "updated_text", "status"])
        writer.writeheader()
        writer.writerows(data)
        return Response(
            buf.getvalue(), media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=pages.csv"},
        )
    return Response(
        json.dumps(data, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": "attachment; filename=pages.json"},
    )
