"""Export a project as a self-contained browsable HTML catalogue.

The exported folder is static: open ``index.html`` from disk — no server, no
network, no upload.  Each card links back to the source video with a
``file://`` URI plus ``#t=<seconds>`` so the system player jumps to the exact
in-point, and shows the original absolute path and timecode for manual
seeking.

Thumbnails are copied next to the HTML, so the catalogue remains viewable
after the app's cache is cleared.  ``shots.csv`` and ``manifest.json`` repeat
the source path and in/out points for spreadsheets and other tools, and the
HTML embeds the full boundary evidence table.
"""

from __future__ import annotations

import csv
import html
import io
import json
import shutil
import time
from pathlib import Path
from urllib.parse import quote

from . import thumbnails
from .detect import shot_duration
from .store import StoreError, exports_dir
from .timecode import format_duration, format_tc_frames, ms_to_timecode

DECISION_LABELS = {
    "kept": "保留",
    "short-kept": "保留短镜头",
    "merged": "已合并",
    "candidate": "候选",
}


def file_uri(path: str, at_ms: int = 0) -> str:
    resolved = Path(path).expanduser().resolve()
    uri = "file://" + quote(str(resolved))
    if at_ms > 0:
        uri += f"#t={at_ms / 1000.0:.3f}"
    return uri


def build_manifest(project: dict, thumb_times: dict[str, int] | None = None) -> dict:
    info = project["media"]["info"]
    fps = float(info.get("fps") or 30)
    thumb_times = thumb_times or {}
    shots = []
    for index, shot in enumerate(project.get("shots") or []):
        start = int(shot["start_ms"])
        end = int(shot["end_ms"])
        sample_ms = thumb_times.get(shot["id"])
        shots.append(
            {
                "index": index,
                "number": index + 1,
                "id": shot["id"],
                "start_ms": start,
                "end_ms": end,
                "duration_ms": shot_duration(shot),
                "start_tc": ms_to_timecode(start),
                "end_tc": ms_to_timecode(end),
                "start_frame": format_tc_frames(start, fps),
                "end_frame": format_tc_frames(end, fps),
                "start_seconds": round(start / 1000.0, 3),
                "end_seconds": round(end / 1000.0, 3),
                "tags": list(shot.get("tags") or []),
                "note": shot.get("note") or "",
                "manual": bool(shot.get("created_manual") or shot.get("manual_start") or shot.get("manual_end")),
                "source": project["media"]["path"],
                "source_name": project["media"]["name"],
                "play_link": file_uri(project["media"]["path"], start),
                "thumb_sample_ms": sample_ms,
                "thumb_sample_tc": ms_to_timecode(sample_ms) if sample_ms is not None else None,
            }
        )

    detection = project.get("detection") or {}
    return {
        "tool": "Shot Shelf",
        "exported_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "project": {
            "id": project.get("id"),
            "name": project.get("name"),
            "created_at": project.get("created_at"),
            "updated_at": project.get("updated_at"),
        },
        "source": {
            "path": project["media"]["path"],
            "name": project["media"]["name"],
            "duration_ms": info.get("duration_ms"),
            "fps": fps,
            "width": info.get("width"),
            "height": info.get("height"),
            "codec": info.get("codec"),
        },
        "detection": {
            "settings": detection.get("settings") or project.get("settings"),
            "summary": detection.get("summary") or {},
            "boundaries": [
                {
                    "at_ms": boundary.get("at_ms"),
                    "at_tc": ms_to_timecode(int(boundary.get("at_ms") or 0)),
                    "score": boundary.get("score"),
                    "kind": boundary.get("kind"),
                    "decision": boundary.get("decision"),
                    "decision_label": DECISION_LABELS.get(str(boundary.get("decision")), boundary.get("decision")),
                    "reason": boundary.get("reason"),
                    "source": boundary.get("source"),
                    "luma_delta": boundary.get("luma_delta"),
                    "sat_delta": boundary.get("sat_delta"),
                    "width_ms": boundary.get("width_ms"),
                }
                for boundary in detection.get("boundaries") or []
            ],
        },
        "shots": shots,
    }


def _csv_text(manifest: dict) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "序号",
            "片段ID",
            "开始时间码",
            "结束时间码",
            "开始(秒)",
            "结束(秒)",
            "时长(秒)",
            "开始帧",
            "结束帧",
            "缩略图采样时间码",
            "标签",
            "备注",
            "源视频",
            "源视频绝对路径",
            "跳转链接",
            "是否人工修正",
        ]
    )
    for shot in manifest["shots"]:
        writer.writerow(
            [
                shot["number"],
                shot["id"],
                shot["start_tc"],
                shot["end_tc"],
                f"{shot['start_ms'] / 1000:.3f}",
                f"{shot['end_ms'] / 1000:.3f}",
                f"{shot['duration_ms'] / 1000:.3f}",
                shot["start_frame"],
                shot["end_frame"],
                shot["thumb_sample_tc"] or "",
                " ".join(shot["tags"]),
                shot["note"].replace("\n", " "),
                shot["source_name"],
                shot["source"],
                shot["play_link"],
                "是" if shot["manual"] else "",
            ]
        )
    return buffer.getvalue()


_HTML_TEMPLATE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__ · 镜头目录</title>
<style>
:root { color-scheme: dark; --bg:#101217; --panel:#181b22; --line:#2a2f3a; --text:#e8eaf0; --muted:#98a1b0; --accent:#7cc4ff; --warn:#ffd479; --good:#8ee6a8; --bad:#ff9c8a; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; }
header { padding:30px 34px 20px; border-bottom:1px solid var(--line); }
h1 { margin:0 0 8px; font-size:23px; font-weight:650; letter-spacing:.2px; }
.sub { color:var(--muted); font-size:13px; }
.meta { display:flex; flex-wrap:wrap; gap:9px 24px; margin-top:14px; color:var(--muted); font-size:12.5px; }
.meta b { color:var(--text); font-weight:600; }
.toolbar { position:sticky; top:0; z-index:5; display:flex; flex-wrap:wrap; gap:10px; align-items:center; padding:14px 34px; background:rgba(16,18,23,.95); backdrop-filter:blur(10px); border-bottom:1px solid var(--line); }
.toolbar input[type=search], .toolbar select { background:var(--panel); border:1px solid var(--line); color:var(--text); border-radius:8px; padding:7px 10px; font-size:13px; outline:none; }
.toolbar input[type=search]:focus, .toolbar select:focus { border-color:var(--accent); }
.toolbar input[type=search] { min-width:230px; }
.toolbar .count { margin-left:auto; color:var(--muted); font-size:12.5px; }
.tagbar { display:flex; flex-wrap:wrap; gap:6px; padding:14px 34px 0; }
.tag { border:1px solid var(--line); background:var(--panel); color:var(--muted); border-radius:999px; padding:3px 11px; font-size:12px; cursor:pointer; user-select:none; transition:border-color .12s, color .12s; }
.tag:hover { color:var(--text); }
.tag[aria-pressed=true] { border-color:var(--accent); color:var(--accent); background:rgba(124,196,255,.1); }
main { padding:20px 34px 70px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(268px,1fr)); gap:16px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:12px; overflow:hidden; display:flex; flex-direction:column; transition:border-color .12s, transform .12s; }
.card:hover { border-color:#3d4657; }
.card .thumb { aspect-ratio:16/9; background:#0a0c10; position:relative; overflow:hidden; }
.card .thumb img { width:100%; height:100%; object-fit:cover; display:block; }
.card .badge { position:absolute; left:8px; bottom:8px; background:rgba(0,0,0,.75); border-radius:6px; padding:2px 7px; font-size:11.5px; font-variant-numeric:tabular-nums; }
.card .badge.r { left:auto; right:8px; }
.card .badge.sample { left:8px; top:8px; bottom:auto; background:rgba(0,0,0,.6); color:var(--muted); font-size:10.5px; }
.card .body { padding:11px 13px 13px; display:flex; flex-direction:column; gap:7px; flex:1; }
.card h2 { margin:0; font-size:13.5px; font-weight:600; display:flex; justify-content:space-between; gap:8px; font-variant-numeric:tabular-nums; }
.card h2 span.t { color:var(--muted); font-weight:400; font-size:11.5px; }
.card .note { color:var(--muted); font-size:12.5px; white-space:pre-wrap; overflow:hidden; display:-webkit-box; -webkit-line-clamp:4; -webkit-box-orient:vertical; }
.tags { display:flex; flex-wrap:wrap; gap:4px; }
.tags i { font-style:normal; background:rgba(124,196,255,.12); color:var(--accent); border-radius:5px; padding:1px 7px; font-size:11.5px; }
.card .links { display:flex; gap:14px; font-size:12px; margin-top:auto; padding-top:6px; }
.card a { color:var(--accent); text-decoration:none; }
.card a:hover { text-decoration:underline; }
.card .path { color:var(--muted); font-size:10.5px; word-break:break-all; opacity:.8; }
.evidence { padding:0 34px 40px; }
.evidence details { border:1px solid var(--line); border-radius:10px; background:var(--panel); padding:13px 17px; }
.evidence summary { cursor:pointer; color:var(--muted); font-size:13px; }
.evidence table { width:100%; border-collapse:collapse; margin-top:12px; font-size:12px; }
.evidence th, .evidence td { text-align:left; padding:6px 9px; border-bottom:1px solid var(--line); vertical-align:top; }
.evidence th { color:var(--muted); font-weight:500; }
.evidence td.num { font-variant-numeric:tabular-nums; white-space:nowrap; }
.pill { border-radius:5px; padding:1px 7px; font-size:11px; border:1px solid var(--line); white-space:nowrap; }
.pill.kept { color:var(--good); border-color:rgba(142,230,168,.4); }
.pill.merged { color:var(--bad); border-color:rgba(255,156,138,.4); }
.pill.short-kept { color:var(--warn); border-color:rgba(255,212,121,.45); }
.empty { color:var(--muted); padding:44px 0; text-align:center; }
footer { padding:16px 34px 44px; color:var(--muted); font-size:11.5px; border-top:1px solid var(--line); }
footer .path { word-break:break-all; }
</style>
</head>
<body>
<header>
  <h1>__TITLE__</h1>
  <div class="sub">镜头缩略图目录 · 由本地工具 Shot Shelf 导出 · 全部数据保存在本机</div>
  <div class="meta">__META__</div>
</header>
<div class="toolbar">
  <input type="search" id="q" placeholder="搜索标签 / 备注 / 时间码 / 序号">
  <select id="dur">
    <option value="all">全部时长</option>
    <option value="0-2000">短于 2 秒</option>
    <option value="2000-5000">2–5 秒</option>
    <option value="5000-15000">5–15 秒</option>
    <option value="15000-999999999">15 秒以上</option>
  </select>
  <select id="tags-mode">
    <option value="any">匹配任一标签</option>
    <option value="all">匹配全部标签</option>
  </select>
  <select id="sort">
    <option value="time">按时间排序</option>
    <option value="dur">按时长排序</option>
    <option value="tag">按标签排序</option>
  </select>
  <span class="count" id="count"></span>
</div>
<div class="tagbar" id="tagbar"></div>
<main><div class="grid" id="grid"></div><div class="empty" id="empty" hidden>没有符合条件的片段。</div></main>
<section class="evidence">
  <details>
    <summary>自动切点判断依据 · 共 __BOUNDARY_COUNT__ 个候选，最终 __SHOT_COUNT__ 个片段</summary>
    <table>
      <thead><tr><th>时间码</th><th>强度</th><th>类型</th><th>过渡</th><th>亮度变化</th><th>饱和度变化</th><th>判断</th><th>依据</th></tr></thead>
      <tbody>__BOUNDARY_ROWS__</tbody>
    </table>
  </details>
</section>
<footer>源视频：<span class="path">__SOURCE_PATH__</span><br>导出时间 __EXPORTED_AT__ · 缩略图取样位置见卡片左上角 · 点击卡片缩略图可看原图。</footer>
<script>
const SHOTS = __SHOTS_JSON__;
const state = { q: "", dur: "all", tagMode: "any", sort: "time", tags: new Set() };
const grid = document.getElementById("grid");
const empty = document.getElementById("empty");
const count = document.getElementById("count");
const tagbar = document.getElementById("tagbar");

function fmtDur(ms) {
  if (ms < 10000) return (ms / 1000).toFixed(2) + "s";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
  return m + "m " + String(s).padStart(2, "0") + "s";
}
function esc(text) {
  return String(text == null ? "" : text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function buildTags() {
  const counts = new Map();
  for (const shot of SHOTS) for (const tag of shot.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
  const items = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [tag, n] of items) {
    const button = document.createElement("button");
    button.className = "tag";
    button.type = "button";
    button.setAttribute("aria-pressed", "false");
    button.textContent = tag + " · " + n;
    button.onclick = () => {
      if (state.tags.has(tag)) state.tags.delete(tag); else state.tags.add(tag);
      button.setAttribute("aria-pressed", String(state.tags.has(tag)));
      render();
    };
    tagbar.appendChild(button);
  }
}
function match(shot) {
  if (state.tags.size) {
    const selected = [...state.tags];
    const ok = state.tagMode === "all"
      ? selected.every((t) => shot.tags.includes(t))
      : selected.some((t) => shot.tags.includes(t));
    if (!ok) return false;
  }
  if (state.dur !== "all") {
    const parts = state.dur.split("-").map(Number);
    if (shot.duration_ms < parts[0] || shot.duration_ms >= parts[1]) return false;
  }
  if (state.q) {
    const needle = state.q.toLowerCase();
    const hay = [shot.tags.join(" "), shot.note, shot.start_tc, shot.end_tc, shot.thumb_sample_tc || "", String(shot.number)].join(" ").toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}
function render() {
  const list = SHOTS.filter(match);
  if (state.sort === "dur") list.sort((a, b) => b.duration_ms - a.duration_ms || a.index - b.index);
  else if (state.sort === "tag") list.sort((a, b) => (a.tags.join() || "~").localeCompare(b.tags.join() || "~") || a.index - b.index);
  else list.sort((a, b) => a.index - b.index);
  count.textContent = "显示 " + list.length + " / " + SHOTS.length + " 个片段";
  empty.hidden = list.length > 0;
  grid.innerHTML = list.map((shot) => {
    const thumb = shot.thumb
      ? `<img loading="lazy" src="${encodeURI(shot.thumb)}" alt="片段 ${shot.number}">`
      : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#667">无缩略图</div>`;
    const sample = shot.thumb_sample_tc ? `<span class="badge sample">采样 ${esc(shot.thumb_sample_tc)}</span>` : "";
    return `
    <article class="card">
      <div class="thumb">
        ${thumb}
        <span class="badge">#${String(shot.number).padStart(3, "0")}</span>
        <span class="badge r">${fmtDur(shot.duration_ms)}</span>
        ${sample}
      </div>
      <div class="body">
        <h2>${esc(shot.start_tc)} → ${esc(shot.end_tc)}<span class="t">${esc(shot.start_frame)}</span></h2>
        ${shot.tags.length ? `<div class="tags">${shot.tags.map((t) => `<i>${esc(t)}</i>`).join("")}</div>` : ""}
        ${shot.note ? `<div class="note">${esc(shot.note)}</div>` : ""}
        <div class="links">
          <a href="${esc(shot.play_link)}" title="用系统播放器打开并跳到开始时间">在播放器中打开</a>
          ${shot.thumb ? `<a href="${encodeURI(shot.thumb)}" target="_blank" rel="noreferrer">原图</a>` : ""}
          <a href="${esc(shot.source_link)}" title="源视频文件位置">源文件</a>
        </div>
        <div class="path">${esc(shot.source)}</div>
      </div>
    </article>`;
  }).join("");
}
document.getElementById("q").addEventListener("input", (event) => { state.q = event.target.value.trim(); render(); });
document.getElementById("dur").addEventListener("change", (event) => { state.dur = event.target.value; render(); });
document.getElementById("tags-mode").addEventListener("change", (event) => { state.tagMode = event.target.value; render(); });
document.getElementById("sort").addEventListener("change", (event) => { state.sort = event.target.value; render(); });
buildTags();
render();
</script>
</body>
</html>
"""


def _boundary_rows(project: dict) -> str:
    boundaries = (project.get("detection") or {}).get("boundaries") or []
    if not boundaries:
        return '<tr><td colspan="8">没有候选切点记录。</td></tr>'
    rows = []
    for boundary in sorted(boundaries, key=lambda b: b.get("at_ms", 0)):
        at_ms = int(boundary.get("at_ms") or 0)
        decision = str(boundary.get("decision") or "candidate")
        label = DECISION_LABELS.get(decision, decision)
        rows.append(
            "<tr>"
            f'<td class="num">{ms_to_timecode(at_ms)}</td>'
            f'<td class="num">{float(boundary.get("score") or 0):.2f}</td>'
            f"<td>{html.escape(str(boundary.get('kind') or '-'))}</td>"
            f'<td class="num">{int(boundary.get("width_ms") or 0)}ms</td>'
            f'<td class="num">{float(boundary.get("luma_delta") or 0):+.1f}</td>'
            f'<td class="num">{float(boundary.get("sat_delta") or 0):+.1f}</td>'
            f'<td><span class="pill {html.escape(decision)}">{html.escape(label)}</span></td>'
            f"<td>{html.escape(str(boundary.get('reason') or ''))}</td>"
            "</tr>"
        )
    return "".join(rows)


def export_project(project: dict, *, name: str | None = None) -> dict:
    info = project["media"]["info"]
    fps = float(info.get("fps") or 30)
    slug = (name or project["name"] or "catalogue").strip()
    safe = "".join(ch if ch.isalnum() or ch in "-_." else "-" for ch in slug)[:60] or "catalogue"
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out_dir = exports_dir() / f"{safe}-{stamp}"
    out_dir.mkdir(parents=True, exist_ok=True)
    thumbs_out = out_dir / "thumbs"
    thumbs_out.mkdir(exist_ok=True)

    cards = []
    thumb_times: dict[str, int] = {}
    missing_thumbs: list[str] = []
    for shot in project.get("shots") or []:
        start = int(shot["start_ms"])
        end = int(shot["end_ms"])
        target_name = ""
        sample_ms = thumbnails.sample_time(start, end, 0.35)
        try:
            meta = thumbnails.thumb_for(
                project_id=project["id"],
                fingerprint=project["media"]["fingerprint"],
                media_path=project["media"]["path"],
                start_ms=start,
                end_ms=end,
                position=0.35,
                width=480,
            )
            sample_ms = meta.get("requested_ms", sample_ms)
            source_image = thumbnails.image_path_for(project["id"], meta["key"])
            if source_image.exists():
                safe_id = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in shot["id"])
                target_name = f"thumbs/{safe_id}-{meta['key'][:10]}.jpg"
                shutil.copyfile(source_image, out_dir / target_name)
        except (StoreError, OSError, KeyError):
            target_name = ""
        if not target_name:
            missing_thumbs.append(shot["id"])
        thumb_times[shot["id"]] = sample_ms
        cards.append(
            {
                "index": len(cards),
                "number": len(cards) + 1,
                "start_ms": start,
                "end_ms": end,
                "duration_ms": shot_duration(shot),
                "start_tc": ms_to_timecode(start),
                "end_tc": ms_to_timecode(end),
                "start_frame": format_tc_frames(start, fps),
                "end_frame": format_tc_frames(end, fps),
                "tags": list(shot.get("tags") or []),
                "note": shot.get("note") or "",
                "thumb": target_name,
                "thumb_sample_tc": ms_to_timecode(sample_ms) if sample_ms is not None else "",
                "thumb_sample_ms": sample_ms,
                "play_link": file_uri(project["media"]["path"], start),
                "source_link": file_uri(project["media"]["path"], 0),
                "source": project["media"]["path"],
            }
        )

    manifest = build_manifest(project, thumb_times)
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    (out_dir / "shots.csv").write_text(_csv_text(manifest), encoding="utf-8-sig")

    summary = (project.get("detection") or {}).get("summary") or {}
    meta_bits = [
        f"源视频 <b>{html.escape(project['media']['name'])}</b>",
        f"时长 <b>{format_duration(info.get('duration_ms') or 0)}</b>",
        f"分辨率 <b>{info.get('width')}×{info.get('height')}</b>",
        f"帧率 <b>{fps:g} fps</b>",
        f"片段 <b>{len(cards)}</b>",
    ]
    if summary:
        meta_bits.append(
            f"切点 <b>{summary.get('cuts', 0)}</b>"
            f" · 自动合并 <b>{summary.get('merged', 0)}</b>"
            f" · 保留短镜头 <b>{summary.get('kept_short', 0)}</b>"
        )
    title = html.escape(project.get("name") or "镜头目录")
    body = (
        _HTML_TEMPLATE.replace("__TITLE__", title)
        .replace("__META__", "".join(f"<span>{bit}</span>" for bit in meta_bits))
        .replace("__SOURCE_PATH__", html.escape(project["media"]["path"]))
        .replace("__EXPORTED_AT__", time.strftime("%Y-%m-%d %H:%M:%S"))
        .replace("__BOUNDARY_ROWS__", _boundary_rows(project))
        .replace("__BOUNDARY_COUNT__", str(len((project.get("detection") or {}).get("boundaries") or [])))
        .replace("__SHOT_COUNT__", str(len(cards)))
        .replace("__SHOTS_JSON__", json.dumps(cards, ensure_ascii=False).replace("</", "<\\/"))
    )
    (out_dir / "index.html").write_text(body, encoding="utf-8")
    return {
        "path": str(out_dir),
        "index": str(out_dir / "index.html"),
        "manifest": str(out_dir / "manifest.json"),
        "csv": str(out_dir / "shots.csv"),
        "shots": len(cards),
        "missing_thumbs": len(missing_thumbs),
        "bytes": sum(p.stat().st_size for p in out_dir.rglob("*") if p.is_file()),
    }


def list_exports(limit: int = 30) -> list[dict]:
    items = []
    for path in exports_dir().glob("*/index.html"):
        try:
            stat = path.stat()
        except OSError:
            continue
        items.append(
            {
                "path": str(path.parent),
                "index": str(path),
                "name": path.parent.name,
                "created_at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(stat.st_mtime)),
            }
        )
    items.sort(key=lambda item: item["created_at"], reverse=True)
    return items[:limit]
