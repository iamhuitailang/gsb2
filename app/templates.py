"""服务端 HTML 渲染（字符串模板，统一做 HTML 转义）。"""

from __future__ import annotations

import html
from urllib.parse import urlencode

from . import service


def esc(value) -> str:
    return html.escape("" if value is None else str(value), quote=True)


def _page(title: str, body: str, user_row=None) -> bytes:
    user_html = ""
    if user_row is not None:
        user_html = (
            f'<span class="user">当前登录：{esc(user_row["display_name"])}'
            f"（{esc(user_row['username'])}）</span>"
            '<form method="post" action="/logout" class="inline">'
            '<button type="submit" class="btn btn-ghost">退出登录</button></form>'
        )
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<style>
  :root {{ --line:#d8dde6; --bg:#f5f7fa; --primary:#2563eb; --danger:#dc2626; --ok:#15803d; }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         background:var(--bg); color:#1f2937; }}
  header {{ background:#fff; border-bottom:1px solid var(--line); padding:12px 24px;
            display:flex; align-items:center; gap:16px; }}
  header h1 {{ font-size:18px; margin:0; flex:1; }}
  main {{ max-width:960px; margin:24px auto; padding:0 16px; }}
  .card {{ background:#fff; border:1px solid var(--line); border-radius:10px;
           padding:20px; margin-bottom:20px; }}
  h2 {{ font-size:16px; margin:0 0 12px; }}
  table {{ width:100%; border-collapse:collapse; }}
  th, td {{ text-align:left; padding:10px 8px; border-bottom:1px solid var(--line);
            font-size:14px; vertical-align:middle; }}
  th {{ color:#6b7280; font-weight:600; }}
  .tag {{ display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; }}
  .tag-admin {{ background:#dbeafe; color:#1d4ed8; }}
  .tag-member {{ background:#e5e7eb; color:#374151; }}
  .tag-off {{ background:#fee2e2; color:#b91c1c; }}
  .tag-on {{ background:#dcfce7; color:#166534; }}
  .btn {{ display:inline-block; border:1px solid var(--line); background:#fff;
          border-radius:8px; padding:6px 12px; font-size:13px; cursor:pointer;
          text-decoration:none; color:#1f2937; }}
  .btn:hover {{ border-color:var(--primary); color:var(--primary); }}
  .btn-primary {{ background:var(--primary); border-color:var(--primary); color:#fff; }}
  .btn-danger {{ border-color:#fecaca; color:var(--danger); }}
  .btn-danger:hover {{ background:var(--danger); border-color:var(--danger); color:#fff; }}
  .btn-ghost {{ border-color:transparent; color:#6b7280; }}
  form.inline {{ display:inline; }}
  .flash {{ border-radius:8px; padding:12px 16px; margin-bottom:16px; font-size:14px; }}
  .flash-ok {{ background:#dcfce7; color:var(--ok); border:1px solid #86efac; }}
  .flash-err {{ background:#fef2f2; color:var(--danger); border:1px solid #fecaca; }}
  .muted {{ color:#6b7280; font-size:13px; }}
  label {{ display:block; font-size:13px; margin:10px 0 4px; color:#374151; }}
  input[type=text], input[type=password] {{ width:100%; padding:9px 10px;
          border:1px solid var(--line); border-radius:8px; font-size:14px; }}
  .org-item {{ display:flex; justify-content:space-between; align-items:center;
          padding:12px 0; border-bottom:1px solid var(--line); }}
  .org-item:last-child {{ border-bottom:none; }}
  code {{ background:#f3f4f6; padding:1px 6px; border-radius:4px; }}
  .audit-detail {{ color:#4b5563; }}
</style>
</head>
<body>
<header><h1>内部工具 · 机构成员管理</h1>{user_html}</header>
<main>{body}</main>
</body>
</html>""".encode("utf-8")


def _flash(flash_type: str | None, message: str | None) -> str:
    if not message:
        return ""
    cls = "flash-ok" if flash_type == "ok" else "flash-err"
    prefix = "操作成功：" if flash_type == "ok" else "无法继续："
    return f'<div class="flash {cls}"><strong>{prefix}</strong>{esc(message)}</div>'


def login_page(flash_type: str | None = None, message: str | None = None) -> bytes:
    body = f"""
    <div class="card" style="max-width:420px;margin:40px auto;">
      <h2>登录</h2>
      {_flash(flash_type, message)}
      <form method="post" action="/login">
        <label>用户名</label>
        <input type="text" name="username" required autofocus>
        <label>密码</label>
        <input type="password" name="password" required>
        <p><button type="submit" class="btn btn-primary" style="margin-top:14px;">登录</button></p>
      </form>
      <p class="muted">演示账号（密码均为 <code>pass1234</code>）：
        甲方机构管理员 <code>jia</code>（甲）、<code>yi</code>（乙），
        普通成员 <code>bing</code>（丙）；乙方机构 <code>ding</code>（丁）、<code>wu</code>（戊）。</p>
    </div>"""
    return _page("登录", body)


def home_page(conn, user_row, flash_type=None, message=None) -> bytes:
    orgs = service.list_user_orgs(conn, user_row["id"])
    items = []
    for org in orgs:
        state = (
            '<span class="tag tag-on">启用</span>' if org["is_active"]
            else '<span class="tag tag-off">已停用</span>'
        )
        role = (
            '<span class="tag tag-admin">管理员</span>' if org["role"] == "admin"
            else '<span class="tag tag-member">普通成员</span>'
        )
        items.append(f"""
        <div class="org-item">
          <div><strong>{esc(org['name'])}</strong>
            <span style="margin-left:8px;">{role}</span>
            <span style="margin-left:6px;">{state}</span></div>
          <a class="btn btn-primary" href="/orgs/{org['id']}">进入机构</a>
        </div>""")
    body = f"""
    {_flash(flash_type, message)}
    <div class="card">
      <h2>我的机构</h2>
      {''.join(items) or '<p class="muted">你目前不属于任何机构。</p>'}
    </div>"""
    return _page("我的机构", body, user_row)


def _post_action(org_id: int, path: str, label: str, btn_class: str = "",
                 confirm: str | None = None, extra: str = "") -> str:
    attr = f' onsubmit="return confirm(\'{esc(confirm)}\');"' if confirm else ""
    return (
        f'<form method="post" action="/orgs/{org_id}/{path}" class="inline"{attr}>'
        f'{extra}<button type="submit" class="btn {btn_class}">{esc(label)}</button></form>'
    )


def org_page(conn, org_row, user_row, viewer_membership, flash_type=None,
             message=None) -> bytes:
    org_id = org_row["id"]
    members = service.list_members(conn, org_id)
    admin_count = service.count_active_admins(conn, org_id)
    is_admin = viewer_membership["role"] == "admin" and viewer_membership["is_active"]

    rows = []
    for m in members:
        role_tag = (
            '<span class="tag tag-admin">管理员</span>' if m["role"] == "admin"
            else '<span class="tag tag-member">普通成员</span>'
        )
        state_tag = (
            '<span class="tag tag-on">启用</span>' if m["is_active"]
            else '<span class="tag tag-off">已停用</span>'
        )
        actions = []
        if is_admin:
            if m["role"] == "admin":
                actions.append(_post_action(
                    org_id, f"members/{m['user_id']}/demote", "降为普通成员"))
            else:
                actions.append(_post_action(
                    org_id, f"members/{m['user_id']}/promote", "升为管理员"))
            if m["is_active"]:
                actions.append(_post_action(
                    org_id, f"members/{m['user_id']}/disable", "停用",
                    btn_class="btn-danger",
                    confirm=f"确定停用 {m['display_name']} 的账号吗？"))
            else:
                actions.append(_post_action(
                    org_id, f"members/{m['user_id']}/activate", "重新启用"))
            if m["user_id"] != user_row["id"]:
                actions.append(_post_action(
                    org_id, f"members/{m['user_id']}/remove", "移出机构",
                    btn_class="btn-danger",
                    confirm=f"确定将 {m['display_name']} 移出机构吗？"))
        if m["user_id"] == user_row["id"]:
            actions.append(_post_action(
                org_id, "leave", "退出机构", btn_class="btn-danger",
                confirm="确定退出该机构吗？"))
        rows.append(
            f"<tr><td>{esc(m['display_name'])}<div class='muted'>{esc(m['username'])}</div></td>"
            f"<td>{role_tag}</td><td>{state_tag}</td>"
            f"<td>{''.join(actions) or '<span class=\"muted\">—</span>'}</td></tr>"
        )

    notice = (
        f'<p class="muted">当前有效管理员 <strong>{admin_count}</strong> 名'
        "（停用账号不计入）。降级、停用、移除或退出后若机构将没有有效管理员，"
        "操作会被拒绝。</p>"
    )
    body = f"""
    {_flash(flash_type, message)}
    <div class="card">
      <h2>{esc(org_row['name'])} · 成员管理</h2>
      {notice}
      <table>
        <thead><tr><th>成员</th><th>角色</th><th>账号状态</th><th>操作</th></tr></thead>
        <tbody>{''.join(rows)}</tbody>
      </table>
      {'' if is_admin else '<p class="muted">你不是该机构的有效管理员，仅可查看。</p>'}
      <p style="margin-top:14px;"><a class="btn" href="/">返回我的机构</a>
         <a class="btn" href="/orgs/{org_id}/audit">查看操作记录</a></p>
    </div>"""
    return _page(org_row["name"], body, user_row)


def audit_page(conn, org_row, user_row) -> bytes:
    logs = service.list_audit_logs(conn, org_row["id"])
    rows = []
    for log in logs:
        result = (
            '<span class="tag tag-on">成功</span>' if log["result"] == "success"
            else '<span class="tag tag-off">已拦截</span>'
        )
        actor = log["actor_name"] or "—"
        target = log["target_name"] or "—"
        rows.append(
            f"<tr><td>{esc(log['created_at'])}</td>"
            f"<td>{esc(actor)}</td><td>{esc(_action_label(log['action']))}</td>"
            f"<td>{esc(target)}</td><td>{result}</td>"
            f"<td class='audit-detail'>{esc(log['detail'])}</td></tr>"
        )
    body = f"""
    <div class="card">
      <h2>{esc(org_row['name'])} · 操作记录（成员实际变化与拦截原因）</h2>
      <table>
        <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th>
        <th>结果</th><th>详情</th></tr></thead>
        <tbody>{''.join(rows) or '<tr><td colspan="6" class="muted">暂无记录</td></tr>'}</tbody>
      </table>
      <p style="margin-top:14px;"><a class="btn" href="/orgs/{org_row['id']}">返回成员管理</a></p>
    </div>"""
    return _page("操作记录", body, user_row)


def _action_label(action: str) -> str:
    return {
        "login": "登录",
        "leave": "退出机构",
        "promote": "升为管理员",
        "demote": "降为普通成员",
        "disable": "停用账号",
        "activate": "重新启用",
        "remove": "移出机构",
    }.get(action, action)


def redirect(path: str, flash_type: str | None = None,
             message: str | None = None) -> tuple[str, bytes]:
    if flash_type and message:
        qs = urlencode({"flash": flash_type, "msg": message})
        sep = "&" if "?" in path else "?"
        path = f"{path}{sep}{qs}"
    return path, b""
