"""本地 Web 界面。

单页应用：左侧素材库与挂接信息，右侧双画面播放器，切换原片/代理时
按标定换算保持同一画面，越界明确停止；剪辑点、重挂接、导出均可在
页面操作。仅监听 127.0.0.1，不对外暴露。
"""

import json
import mimetypes
import os
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .errors import SignatureMismatchError
from .project import Project


def _json_bytes(obj, status=200):
    return status, "application/json; charset=utf-8", json.dumps(obj, ensure_ascii=False).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    project = None  # run_server 时注入

    def log_message(self, fmt, *args):  # 安静一点
        pass

    # ---- 基础工具 ---------------------------------------------------

    def _send(self, status, content_type, body, extra_headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_json(self, obj, status=200):
        self._send(*_json_bytes(obj, status))

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def _handle_api(self, method, path, query, body):
        p = self.project
        # 素材
        if method == "GET" and path == "/api/media":
            return _json_bytes([p.media_detail(m.id) for m in p.list_media()])
        if method == "POST" and path == "/api/media/register":
            media = p.register(body["path"])
            return _json_bytes(p.media_detail(media.id))
        if method == "GET" and path.startswith("/api/media/"):
            return _json_bytes(p.media_detail(urllib.parse.unquote(path.split("/")[-1])))

        # 挂接
        if method == "POST" and path == "/api/links":
            link = p.create_link(body["original_id"], body["proxy_id"],
                                 label=body.get("label", ""))
            return _json_bytes(p.link_status(link.id))
        if method == "GET" and path.startswith("/api/links/"):
            link_id = path.split("/")[-1]
            return _json_bytes(p.link_status(link_id))
        if method == "POST" and path.endswith("/calibrate"):
            link_id = path.split("/")[-2]
            pairs = [(a["original"], a["proxy"]) for a in body["anchors"]]
            p.calibrate(link_id, pairs)
            return _json_bytes(p.link_status(link_id))
        if method == "POST" and path.endswith("/locate"):
            link_id = path.split("/")[-2]
            return _json_bytes(p.locate(link_id, body["side"], body["time"]))

        # 剪辑点
        if method == "GET" and path == "/api/cutpoints":
            link_id = query.get("link_id", [None])[0]
            return _json_bytes([
                p._export_entry(c) for c in p.list_cut_points(link_id)  # noqa: SLF001
            ])
        if method == "POST" and path == "/api/cutpoints":
            cp = p.add_cut_point(body["link_id"], body["time"],
                                 side=body.get("side", "original"),
                                 label=body.get("label", ""))
            return _json_bytes(p._export_entry(cp))  # noqa: SLF001
        if method == "DELETE" and path.startswith("/api/cutpoints/"):
            cut_id = path.split("/")[-1]
            p.remove_cut_point(cut_id)
            return _json_bytes({"ok": True})
        if method == "GET" and path == "/api/export":
            fmt = query.get("format", ["json"])[0]
            link_id = query.get("link_id", [None])[0]
            ctype = {"json": "application/json; charset=utf-8",
                     "csv": "text/csv; charset=utf-8",
                     "md": "text/markdown; charset=utf-8"}[fmt]
            return 200, ctype, p.export_cut_points(fmt, link_id).encode("utf-8")

        # 播放头
        if method == "GET" and path == "/api/session":
            view = p.session_view()
            return _json_bytes(view or {})
        if method == "POST" and path == "/api/session/seek":
            return _json_bytes(p.seek(body["link_id"], body["time"],
                                      side=body.get("side", "original")))
        if method == "POST" and path == "/api/session/switch":
            return _json_bytes(p.switch_side(clamp=bool(body.get("clamp", False))))
        if method == "POST" and path == "/api/session/tick":
            return _json_bytes(p.tick(float(body["seconds"])))

        # 文件健康与重挂接
        if method == "GET" and path == "/api/files/check":
            return _json_bytes(p.check_files())
        if method == "POST" and path == "/api/relink/find":
            return _json_bytes(p.find_relink_candidates(body["ref"], body["dir"]))
        if method == "POST" and path == "/api/relink/do":
            try:
                result = p.relink(body["ref"], body["new_path"],
                                  force=bool(body.get("force", False)))
                return _json_bytes({"ok": True,
                                    "report": result["report"],
                                    "forced": result["forced"]})
            except SignatureMismatchError as exc:
                return _json_bytes({"ok": False, "error": str(exc),
                                    "checks": exc.details}, status=409)

        return _json_bytes({"error": f"未知接口: {method} {path}"}, status=404)

    # ---- HTTP 方法 --------------------------------------------------

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path, query = parsed.path, urllib.parse.parse_qs(parsed.query)
        if path.startswith("/api/"):
            try:
                status, ctype, body = self._handle_api("GET", path, query, {})
                self._send(status, ctype, body)
            except Exception as exc:  # 业务错误统一成 JSON
                self._send_json({"error": str(exc)}, status=400)
            return
        if path.startswith("/media/"):
            self._serve_media_file(urllib.parse.unquote(path[len("/media/"):]))
            return
        if path in ("/", "/index.html"):
            self._send(200, "text/html; charset=utf-8", INDEX_HTML.encode("utf-8"))
            return
        self._send(404, "text/plain; charset=utf-8", "not found".encode())

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        try:
            status, ctype, body = self._handle_api(
                "POST", parsed.path, urllib.parse.parse_qs(parsed.query), self._read_json())
            self._send(status, ctype, body)
        except SignatureMismatchError as exc:
            self._send_json({"error": str(exc), "checks": exc.details}, status=409)
        except Exception as exc:
            self._send_json({"error": str(exc)}, status=400)

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        try:
            status, ctype, body = self._handle_api(
                "DELETE", parsed.path, urllib.parse.parse_qs(parsed.query), {})
            self._send(status, ctype, body)
        except SignatureMismatchError as exc:
            self._send_json({"error": str(exc), "checks": exc.details}, status=409)
        except Exception as exc:
            self._send_json({"error": str(exc)}, status=400)

    # ---- 媒体文件（Range 支持，供 <video> seek） --------------------

    def _serve_media_file(self, media_id):
        try:
            media = self.project.state.get_media(media_id)
        except Exception:
            self._send(404, "text/plain; charset=utf-8", "media not found".encode())
            return
        fpath = media.path
        if not os.path.isfile(fpath):
            self._send(410, "text/plain; charset=utf-8", "源文件已丢失".encode("utf-8"))
            return
        ctype = mimetypes.guess_type(fpath)[0] or "video/mp4"
        size = os.path.getsize(fpath)
        range_header = self.headers.get("Range")
        if not range_header:
            self._send(200, ctype, b"", {"Accept-Ranges": "bytes",
                                         "Content-Length": str(size)})
            if self.command == "GET":
                with open(fpath, "rb") as fh:
                    while True:
                        block = fh.read(1024 * 1024)
                        if not block:
                            break
                        self.wfile.write(block)
            return
        try:
            unit, rng = range_header.split("=")
            assert unit.strip() == "bytes"
            start_s, end_s = rng.split("-")
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
        except (ValueError, AssertionError):
            self._send(416, "text/plain", b"invalid range")
            return
        end = min(end, size - 1)
        length = end - start + 1
        self.send_response(206)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(length))
        self.end_headers()
        if self.command == "GET":
            with open(fpath, "rb") as fh:
                fh.seek(start)
                remaining = length
                while remaining > 0:
                    block = fh.read(min(1024 * 1024, remaining))
                    if not block:
                        break
                    self.wfile.write(block)
                    remaining -= len(block)


def run_server(base_dir=".", host="127.0.0.1", port=8321):
    project = Project(base_dir)
    Handler.project = project
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"proxylink Web UI: http://{host}:{port}/  （Ctrl+C 退出）")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出")
    finally:
        httpd.server_close()


INDEX_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>proxylink 代理素材挂接</title>
<style>
  :root { --bg:#1e1f24; --panel:#27292f; --line:#3a3d45; --fg:#e6e7ea;
          --muted:#9aa0aa; --accent:#5b9dff; --warn:#ffb454; --err:#ff6b6b; --ok:#5fd08a; }
  * { box-sizing: border-box; }
  body { margin:0; font:13px/1.5 -apple-system,"PingFang SC",sans-serif;
         background:var(--bg); color:var(--fg); }
  header { padding:10px 16px; background:var(--panel); border-bottom:1px solid var(--line);
           display:flex; gap:12px; align-items:center; }
  header h1 { font-size:15px; margin:0; }
  .wrap { display:grid; grid-template-columns:340px 1fr; gap:12px; padding:12px; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px; }
  .panel h2 { font-size:13px; margin:0 0 8px; color:var(--muted); text-transform:uppercase; }
  button { background:var(--accent); color:#fff; border:0; border-radius:5px;
           padding:5px 12px; cursor:pointer; font-size:12px; }
  button.ghost { background:transparent; border:1px solid var(--line); color:var(--fg); }
  button.danger { background:var(--err); }
  input, select { background:#1b1c20; border:1px solid var(--line); color:var(--fg);
                  border-radius:5px; padding:5px 8px; font-size:12px; width:100%; }
  .row { display:flex; gap:6px; margin-bottom:6px; }
  .row > * { flex:1; }
  .item { border:1px solid var(--line); border-radius:6px; padding:8px; margin-bottom:6px;
          cursor:pointer; }
  .item.active { border-color:var(--accent); }
  .item .name { font-weight:600; word-break:break-all; }
  .item .meta { color:var(--muted); font-size:11px; }
  .tag { display:inline-block; padding:0 6px; border-radius:4px; font-size:11px; }
  .tag.ok { background:rgba(95,208,138,.15); color:var(--ok); }
  .tag.err { background:rgba(255,107,107,.15); color:var(--err); }
  .tag.warn { background:rgba(255,180,84,.15); color:var(--warn); }
  video { width:100%; background:black; border-radius:6px; }
  .players { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .tc { font-family:ui-monospace,monospace; font-size:15px; }
  .stopped { color:var(--err); font-weight:600; }
  .muted { color:var(--muted); }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th,td { border-bottom:1px solid var(--line); padding:5px 6px; text-align:left; }
  .kv { display:grid; grid-template-columns:90px 1fr; gap:2px 8px; font-size:12px; }
  .kv .k { color:var(--muted); }
  pre { white-space:pre-wrap; word-break:break-all; font-size:11px;
        background:#1b1c20; border-radius:6px; padding:8px; max-height:260px; overflow:auto; }
  .flash { position:fixed; right:16px; bottom:16px; max-width:380px; }
  .flash div { background:var(--err); color:#fff; padding:8px 12px; border-radius:6px;
               margin-top:6px; }
</style>
</head>
<body>
<header>
  <h1>proxylink · 本地代理素材挂接</h1>
  <span class="muted" id="hint"></span>
  <span style="flex:1"></span>
  <button class="ghost" onclick="loadAll()">刷新</button>
</header>

<div class="wrap">
  <div>
    <div class="panel">
      <h2>素材库</h2>
      <div class="row">
        <input id="regPath" placeholder="登记素材的绝对路径">
        <button onclick="registerMedia()">登记</button>
      </div>
      <div id="mediaList"></div>
    </div>

    <div class="panel" style="margin-top:12px">
      <h2>挂接与标定</h2>
      <div class="row">
        <select id="selOriginal"></select>
        <select id="selProxy"></select>
      </div>
      <div class="row"><button onclick="createLink()">建立挂接</button></div>
      <div id="linkList"></div>
      <div class="row" style="margin-top:8px">
        <input id="anchorO" placeholder="原片时间，如 2.0 或 00:00:02:00">
        <input id="anchorP" placeholder="代理时间，如 0.0">
      </div>
      <div class="row">
        <button onclick="addAnchor(true)">单点标定</button>
        <button class="ghost" onclick="addAnchor(false)">追加第二点</button>
      </div>
      <div id="coverage"></div>
    </div>

    <div class="panel" style="margin-top:12px">
      <h2>文件移动 / 重挂接</h2>
      <div class="row"><input id="relinkDir" placeholder="新目录，递归查找同名文件"></div>
      <div class="row"><button class="ghost" onclick="findRelink()">查找候选并比对特征</button></div>
      <div id="relinkResult"></div>
    </div>
  </div>

  <div>
    <div class="panel">
      <h2>双画面核对（切换后应显示同一 ORIG 帧号）</h2>
      <div class="players">
        <div>
          <div class="muted">原片 <span id="oName"></span></div>
          <video id="vOriginal" controls preload="metadata"></video>
          <div class="tc" id="oTc">--:--:--:--</div>
        </div>
        <div>
          <div class="muted">代理 <span id="pName"></span></div>
          <video id="vProxy" controls preload="metadata"></video>
          <div class="tc" id="pTc">--:--:--:--</div>
        </div>
      </div>
      <div class="row" style="margin-top:8px">
        <input id="seekTime" placeholder="定位时间（当前侧）">
        <button onclick="doSeek()">定位</button>
        <button class="ghost" onclick="switchSide()">切换原片/代理</button>
        <button class="ghost" onclick="tick(-1)">后退1s</button>
        <button class="ghost" onclick="tick(1)">前进1s</button>
      </div>
      <div id="stopBar" class="stopped" style="display:none"></div>
      <div class="muted" id="rangeInfo"></div>
    </div>

    <div class="panel" style="margin-top:12px">
      <h2>剪辑点（原片时间位置 + 换算溯源）</h2>
      <div class="row">
        <input id="cutTime" placeholder="剪辑时间（当前侧）">
        <select id="cutSide"><option value="original">按原片时间</option>
          <option value="proxy">按代理时间</option></select>
        <input id="cutLabel" placeholder="标注（可选）">
        <button onclick="addCut()">添加</button>
      </div>
      <table>
        <thead><tr><th>原片时间码</th><th>来源代理时间码</th><th>标注</th><th>可靠</th><th></th></tr></thead>
        <tbody id="cutBody"></tbody>
      </table>
      <div class="row" style="margin-top:8px">
        <a href="/api/export?format=json" target="_blank"><button class="ghost">导出 JSON</button></a>
        <a href="/api/export?format=csv" target="_blank"><button class="ghost">导出 CSV</button></a>
        <a href="/api/export?format=md" target="_blank"><button class="ghost">导出 Markdown</button></a>
      </div>
      <details><summary class="muted">溯源详情</summary><pre id="cutJson"></pre></details>
    </div>

    <div class="panel" style="margin-top:12px">
      <h2>素材详情</h2>
      <div id="mediaDetail" class="kv muted">点击左侧素材查看分辨率、时长与视频流信息</div>
    </div>
  </div>
</div>
<div class="flash" id="flash"></div>

<script>
let media = [], links = [], currentLinkId = null, pendingAnchors = [];
const $ = id => document.getElementById(id);
async function api(path, opts={}) {
  const res = await fetch(path, {headers:{"Content-Type":"application/json"}, ...opts});
  const data = await res.json().catch(()=>({}));
  if (!res.ok) { flash(data.error || "请求失败"); if (data.checks) console.warn(data.checks); throw data; }
  return data;
}
function flash(msg) {
  const d = document.createElement("div"); d.textContent = msg;
  $("flash").appendChild(d); setTimeout(()=>d.remove(), 5000);
}
function tc(sec, fps) {
  if (!fps) return sec.toFixed(3)+"s";
  const f = Math.round(sec*fps), pf = Math.round(fps);
  const ff=f%pf, ss=Math.floor(f/pf)%60, mm=Math.floor(f/pf/60)%60, hh=Math.floor(f/pf/3600);
  return [hh,mm,ss].map(x=>String(x).padStart(2,"0")).join(":")+":"+String(ff).padStart(2,"0");
}

async function loadAll() {
  media = await api("/api/media");
  links = await Promise.all(media.flatMap(m=>m.links.map(l=>l.link_id))
    .filter((v,i,a)=>a.indexOf(v)===i).map(id=>api("/api/links/"+id).catch(()=>null)));
  links = links.filter(Boolean);
  renderMedia(); renderSelects(); renderLinks(); renderCuts();
  if (currentLinkId && links.some(l=>l.link_id===currentLinkId)) renderCoverage();
}
function renderMedia() {
  $("mediaList").innerHTML = media.map(m=>`
    <div class="item" onclick="showDetail('${m.id}')">
      <div class="name">${m.filename}
        <span class="tag ${m.exists?'ok':'err'}">${m.exists?'在位':'丢失'}</span></div>
      <div class="meta">${m.width}x${m.height} · ${m.duration.toFixed(2)}s · ${m.fps}fps · ${m.codec}</div>
      <div class="meta">${m.path}</div>
      ${m.same_filename_others.length?`<div class="tag warn">同名不同目录 ${m.same_filename_others.length} 条</div>`:""}
    </div>`).join("");
}
function renderSelects() {
  const opts = media.map(m=>`<option value="${m.id}">${m.filename} (${m.path})</option>`).join("");
  $("selOriginal").innerHTML = opts; $("selProxy").innerHTML = opts;
}
function renderLinks() {
  $("linkList").innerHTML = links.map(l=>`
    <div class="item ${l.link_id===currentLinkId?'active':''}" onclick="selectLink('${l.link_id}')">
      <div class="name">${l.original.filename} ↔ ${l.proxy.filename}
        <span class="tag ${l.calibrated?'ok':'warn'}">${l.calibrated?'已标定':'未标定'}</span></div>
      <div class="meta">${l.label||l.link_id}</div>
    </div>`).join("");
}
async function showDetail(id) {
  const d = await api("/api/media/"+encodeURIComponent(id));
  $("mediaDetail").innerHTML = Object.entries({
    路径:d.path, 容器:d.container, 分辨率:d.resolution, 时长:d.duration.toFixed(3)+"s",
    帧率:d.fps+" fps", 帧数:d.nb_frames, 编码:`${d.codec} ${d.profile||""}`,
    像素格式:d.pix_fmt, 音频:d.has_audio?d.audio_streams.map(a=>a.codec).join(","):"无",
    签名:d.partial_sha256.slice(0,24)+"…",
  }).map(([k,v])=>`<div class="k">${k}</div><div>${v}</div>`).join("")
    + d.video_streams.map(s=>`<div class="k">视频流#${s.index}</div><div>${s.codec} ${s.width}x${s.height} ${s.fps}fps frames=${s.nb_frames}</div>`).join("");
}
async function registerMedia() {
  await api("/api/media/register", {method:"POST", body:JSON.stringify({path:$("regPath").value})});
  $("regPath").value=""; loadAll();
}
async function createLink() {
  const l = await api("/api/links", {method:"POST", body:JSON.stringify({
    original_id:$("selOriginal").value, proxy_id:$("selProxy").value})});
  currentLinkId = l.link_id; pendingAnchors=[]; loadAll();
}
function selectLink(id) { currentLinkId=id; pendingAnchors=[]; renderLinks(); renderCoverage(); loadPlayers(); }
async function addAnchor(isSingle) {
  if (!currentLinkId) return flash("请先选择挂接");
  pendingAnchors.push({original:$("anchorO").value, proxy:$("anchorP").value});
  if (isSingle) pendingAnchors = pendingAnchors.slice(-1);
  if (pendingAnchors.length > 2) pendingAnchors = pendingAnchors.slice(-2);
  try {
    await api(`/api/links/${currentLinkId}/calibrate`,
      {method:"POST", body:JSON.stringify({anchors:pendingAnchors})});
    $("anchorO").value=""; $("anchorP").value="";
    await loadAll(); renderCoverage();
  } catch(e) { pendingAnchors=[]; }
}
async function renderCoverage() {
  const l = links.find(x=>x.link_id===currentLinkId);
  if (!l || !l.calibrated) { $("coverage").innerHTML='<div class="muted">标定后显示可靠区间</div>'; return; }
  const c = l.coverage, h=c.head_match, t=c.tail_match, rel=c.original.reliable_range;
  $("coverage").innerHTML = `
    <div class="kv">
      <div class="k">走时比</div><div>${c.rate.toFixed(6)}</div>
      <div class="k">首部</div><div class="${h.aligned?'':'tag warn'}">${h.aligned?'对齐':`偏移 ${h.original_missing_head_seconds.toFixed(2)}s / ${h.original_missing_head_frames}帧 不可定位`}</div>
      <div class="k">尾部</div><div class="${t.aligned?'':'tag warn'}">${t.aligned?'对齐':`缺尾 ${t.original_missing_tail_seconds.toFixed(2)}s / ${t.original_missing_tail_frames}帧 不可定位`}</div>
      <div class="k">原片可靠区间</div><div>${rel[0].toFixed(2)}s – ${rel[1].toFixed(2)}s</div>
    </div>`;
  $("rangeInfo").textContent = `原片可靠区间 ${rel[0].toFixed(2)}s–${rel[1].toFixed(2)}s，超出即停止`;
  loadPlayers(l);
}
function loadPlayers(l) {
  l = l || links.find(x=>x.link_id===currentLinkId);
  if (!l) return;
  $("vOriginal").src = "/media/"+encodeURIComponent(l.original.id);
  $("vProxy").src = "/media/"+encodeURIComponent(l.proxy.id);
  $("oName").textContent = l.original.filename;
  $("pName").textContent = l.proxy.filename;
}
async function doSeek() {
  const session = await api("/api/session");
  const side = session && session.side ? session.side : "original";
  const v = await api("/api/session/seek", {method:"POST", body:JSON.stringify({
    link_id:currentLinkId, time:$("seekTime").value, side})});
  $("seekTime").value=""; syncPlayers(v);
}
async function switchSide() {
  const v = await api("/api/session/switch", {method:"POST", body:"{}"});
  syncPlayers(v);
}
async function tick(d) {
  const v = await api("/api/session/tick", {method:"POST", body:JSON.stringify({seconds:d})});
  syncPlayers(v);
}
function syncPlayers(v) {
  if (!v || !v.link_id) return;
  const vo=$("vOriginal"), vp=$("vProxy");
  if (Math.abs(vo.currentTime - v.original.time) > 0.12) vo.currentTime = v.original.time;
  if (Math.abs(vp.currentTime - v.proxy.time) > 0.12) vp.currentTime = v.proxy.time;
  const l = links.find(x=>x.link_id===v.link_id);
  $("oTc").textContent = v.original.timecode + " 帧"+v.original.frame;
  $("pTc").textContent = v.proxy.timecode + " 帧"+v.proxy.frame;
  $("stopBar").style.display = v.stopped ? "block" : "none";
  $("stopBar").textContent = v.stopped ? "■ 已停止：" + v.stop_reason : "";
}
async function addCut() {
  await api("/api/cutpoints", {method:"POST", body:JSON.stringify({
    link_id:currentLinkId, time:$("cutTime").value,
    side:$("cutSide").value, label:$("cutLabel").value})});
  $("cutTime").value=""; $("cutLabel").value=""; renderCuts();
}
async function renderCuts() {
  const cuts = await api("/api/cutpoints");
  $("cutBody").innerHTML = cuts.map(c=>`<tr>
    <td>${c.original.timecode}</td><td>${c.derived_from.proxy_filename} ${c.derived_from.proxy_timecode}</td>
    <td>${c.label||""}</td>
    <td><span class="tag ${c.reliable?'ok':'warn'}">${c.reliable?'可靠':'需复核'}</span></td>
    <td><button class="danger" onclick="delCut('${c.cut_id}')">删</button></td></tr>`).join("");
  $("cutJson").textContent = JSON.stringify(cuts, null, 2);
}
async function delCut(id) {
  await fetch("/api/cutpoints/"+id, {method:"DELETE"}); renderCuts();
}
async function findRelink() {
  // 对所有丢失文件逐个查找
  const lost = media.filter(m=>!m.exists);
  if (!lost.length) return flash("当前没有丢失的素材");
  let html = "";
  for (const m of lost) {
    const reps = await api("/api/relink/find", {method:"POST",
      body:JSON.stringify({ref:m.id, dir:$("relinkDir").value})});
    html += `<div class="meta">${m.filename}</div>` + reps.map(r=>`
      <div class="item"><span class="tag ${r.verdict==='match'?'ok':'err'}">${r.verdict==='match'?'特征匹配':'特征不符'}</span>
        <div class="meta">${r.path} (${r.matched}/${r.total})</div>
        ${r.checks.filter(c=>!c.ok).map(c=>`<div class="tag err">${c.field}: ${c.expected} → ${c.actual}</div>`).join(" ")}
        ${r.verdict==='match'?`<button onclick="doRelink('${m.id}','${r.path}')">挂接</button>`:""}
      </div>`).join("") || '<div class="muted">无候选</div>';
  }
  $("relinkResult").innerHTML = html;
}
async function doRelink(ref, path) {
  await api("/api/relink/do", {method:"POST", body:JSON.stringify({ref, new_path:path})});
  flash("重挂接成功"); loadAll();
}
loadAll();
setInterval(async ()=>{ const v = await fetch("/api/session").then(r=>r.json());
  if (v && v.link_id) syncPlayers(v); }, 1000);
</script>
</body>
</html>"""
