"""HTTP 层：任务列表/详情、逐页推进、下载、运单维护页面。"""

import html
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import db
import service


def esc(s):
    return html.escape(str(s), quote=True)


def page(title, body):
    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>{esc(title)}</title>
<style>
body {{ font-family: -apple-system, "PingFang SC", sans-serif; margin: 2em auto;
       max-width: 960px; padding: 0 1em; color: #222; }}
table {{ border-collapse: collapse; margin: 1em 0; }}
th, td {{ border: 1px solid #ccc; padding: 4px 12px; text-align: left; }}
th {{ background: #f4f4f4; }}
nav a {{ margin-right: 1em; }}
.badge {{ padding: 1px 8px; border-radius: 4px; background: #eee; }}
.done {{ background: #d4edda; }}
form.inline {{ display: inline; }}
button {{ cursor: pointer; }}
</style></head><body>
<nav><a href="/">导出任务</a><a href="/maintenance">运单维护</a></nav>
<h1>{esc(title)}</h1>
{body}
</body></html>"""


def render_task_list(conn):
    rows = service.list_tasks(conn)
    trs = "".join(
        f"<tr><td><a href='/tasks/{t['id']}'>#{t['id']}</a></td>"
        f"<td>{esc(t['date_from'])} ~ {esc(t['date_to'])}</td>"
        f"<td>v{t['data_version']}</td>"
        f"<td><span class='badge {'done' if t['status']=='DONE' else ''}'>"
        f"{esc(t['status'])}</span></td>"
        f"<td>{len(service.done_pages(conn, t['id']))}/{t['total_pages']}</td>"
        f"<td>{t['total_rows']}</td><td>{t['total_pieces']}</td></tr>"
        for t in rows
    )
    return page("导出任务", f"""
<h2>新建导出</h2>
<form method="post" action="/tasks">
  发货日期从 <input name="date_from" type="date" required>
  到 <input name="date_to" type="date" required>
  <button type="submit">开始导出</button>
</form>
<h2>任务列表</h2>
<table><tr><th>任务</th><th>范围</th><th>数据版本</th><th>状态</th>
<th>页进度</th><th>总行数</th><th>总件数</th></tr>{trs}</table>
""")


def render_task_detail(conn, task_id):
    task = service.get_task(conn, task_id)
    if task is None:
        return None
    pages = service.done_pages(conn, task_id)
    rows = service.preview_rows(conn, task)
    stats = service.zone_stats(conn, task)
    files = {f["filename"]: f for f in service.task_files(conn, task_id)}
    done = task["status"] == "DONE"

    preview = "".join(
        f"<tr><td>{(i // task['page_size']) + 1}</td><td>{esc(r['waybill_no'])}</td>"
        f"<td>{esc(r['zone'])}</td><td>{r['pieces']}</td>"
        f"<td>{esc(r['ship_date'])}</td></tr>"
        for i, r in enumerate(rows)
    )
    file_rows = ""
    for zone, s in sorted(stats.items()):
        name = f"{zone}.csv"
        link = (f"<a href='/tasks/{task_id}/files/{name}'>{esc(name)}</a>"
                if done and name in files else esc(name))
        file_rows += (f"<tr><td>{link}</td><td>{s['rows']}</td>"
                      f"<td>{s['pieces']}</td></tr>")
    file_rows += (f"<tr><td>{esc(service.MANIFEST_NAME)}</td>"
                  f"<td>{len(stats)}</td><td>{task['total_pieces']}</td></tr>")

    zip_link = ""
    zip_name = f"export_{task_id}_v{task['data_version']}.zip"
    if done and zip_name in files:
        zip_link = (f"<p><a href='/tasks/{task_id}/files/{zip_name}'>"
                    f"下载 ZIP（{esc(zip_name)}）</a></p>")

    actions = ""
    if not done:
        actions = f"""
<form class="inline" method="post" action="/tasks/{task_id}/step">
  <button type="submit">生成下一页</button></form>
<form class="inline" method="post" action="/tasks/{task_id}/run">
  <button type="submit">继续生成剩余全部</button></form>"""

    return page(f"导出任务 #{task_id}", f"""
<p>范围：{esc(task['date_from'])} ~ {esc(task['date_to'])}
数据版本：<b>v{task['data_version']}</b>
状态：<span class="badge {'done' if done else ''}">{esc(task['status'])}</span>
页进度：{len(pages)}/{task['total_pages']}
总件数：<b>{task['total_pieces']}</b></p>
{actions}
{zip_link}
<h2>清单文件（每库区一份）</h2>
<table><tr><th>文件名</th><th>行数</th><th>总件数</th></tr>{file_rows}</table>
<h2>明细预览（数据版本 v{task['data_version']}）</h2>
<table><tr><th>页</th><th>运单号</th><th>库区</th><th>件数</th><th>发货日期</th>
</tr>{preview}</table>
""")


def render_maintenance(conn):
    rows = db.current_waybills(conn)
    trs = "".join(
        f"<tr><td>{esc(r['waybill_no'])}</td><td>{esc(r['zone'])}</td>"
        f"<td><form class='inline' method='post' action='/maintenance/update'>"
        f"<input type='hidden' name='id' value='{r['id']}'>"
        f"<input name='pieces' type='number' min='1' value='{r['pieces']}' "
        f"style='width:5em'> <button type='submit'>保存</button></form></td>"
        f"<td>{esc(r['ship_date'])}</td>"
        f"<td><form class='inline' method='post' action='/maintenance/cancel'>"
        f"<input type='hidden' name='id' value='{r['id']}'>"
        f"<button type='submit'>撤销</button></form></td></tr>"
        for r in rows
    )
    return page("运单维护", f"""
<p>当前数据版本：<b>v{db.current_version(conn)}</b>
（新增 / 改件数 / 撤销都会推进版本，仅影响之后新建的导出任务）</p>
<h2>新增运单</h2>
<form method="post" action="/maintenance/add">
  运单号 <input name="waybill_no" required>
  库区 <input name="zone" required>
  件数 <input name="pieces" type="number" min="1" required>
  发货日期 <input name="ship_date" type="date" required>
  <button type="submit">新增</button>
</form>
<h2>当前运单</h2>
<table><tr><th>运单号</th><th>库区</th><th>件数</th><th>发货日期</th><th></th>
</tr>{trs}</table>
""")


class Handler(BaseHTTPRequestHandler):
    db_path = "export.db"
    workdir = "exports"

    def _conn(self):
        return db.connect(self.db_path)

    def _send_html(self, body, status=200):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _redirect(self, location):
        self.send_response(303)
        self.send_header("Location", location)
        self.end_headers()

    def _form(self):
        length = int(self.headers.get("Content-Length", 0))
        return {k: v[0] for k, v in
                parse_qs(self.rfile.read(length).decode("utf-8")).items()}

    def do_GET(self):
        path = urlparse(self.path).path
        conn = self._conn()
        try:
            if path == "/":
                self._send_html(render_task_list(conn))
            elif m := re.fullmatch(r"/tasks/(\d+)", path):
                body = render_task_detail(conn, int(m.group(1)))
                self._send_html(body) if body else self._send_html(
                    page("404", "<p>任务不存在</p>"), 404)
            elif m := re.fullmatch(r"/tasks/(\d+)/files/(.+)", path):
                self._download(conn, int(m.group(1)), m.group(2))
            elif path == "/maintenance":
                self._send_html(render_maintenance(conn))
            else:
                self._send_html(page("404", "<p>页面不存在</p>"), 404)
        finally:
            conn.close()

    def do_POST(self):
        path = urlparse(self.path).path
        form = self._form()
        conn = self._conn()
        try:
            if path == "/tasks":
                task_id = service.create_task(
                    conn, form["date_from"], form["date_to"])
                self._redirect(f"/tasks/{task_id}")
            elif m := re.fullmatch(r"/tasks/(\d+)/step", path):
                service.generate_next_page(conn, int(m.group(1)), self.workdir)
                self._redirect(f"/tasks/{m.group(1)}")
            elif m := re.fullmatch(r"/tasks/(\d+)/run", path):
                service.run_remaining(conn, int(m.group(1)), self.workdir)
                self._redirect(f"/tasks/{m.group(1)}")
            elif path == "/maintenance/add":
                db.add_waybill(conn, form["waybill_no"], form["zone"],
                               int(form["pieces"]), form["ship_date"])
                self._redirect("/maintenance")
            elif path == "/maintenance/update":
                db.update_pieces(conn, int(form["id"]), int(form["pieces"]))
                self._redirect("/maintenance")
            elif path == "/maintenance/cancel":
                db.cancel_waybill(conn, int(form["id"]))
                self._redirect("/maintenance")
            else:
                self._send_html(page("404", "<p>页面不存在</p>"), 404)
        finally:
            conn.close()

    def _download(self, conn, task_id, filename):
        row = conn.execute(
            "SELECT path FROM export_files WHERE task_id = ? AND filename = ?",
            (task_id, filename),
        ).fetchone()
        if row is None:
            self._send_html(page("404", "<p>文件不存在或任务尚未完成</p>"), 404)
            return
        with open(row["path"], "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition",
                         f"attachment; filename*=UTF-8''{filename}")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        pass


def serve(db_path, workdir, port):
    Handler.db_path = db_path
    Handler.workdir = workdir
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"导出服务已启动: http://127.0.0.1:{port}")
    server.serve_forever()
