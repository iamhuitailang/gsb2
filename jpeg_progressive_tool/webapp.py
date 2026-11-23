"""Flask web UI for the progressive JPEG inspection tool.

Run:  python -m jpeg_progressive_tool.webapp [--port 5000]
Then open http://127.0.0.1:5000/
"""

from __future__ import annotations

import io
import json
import os
import uuid

from flask import Flask, jsonify, request, send_file, abort

from . import analyzer, compare, exporter, parser, samples

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
RUN_DIR = os.path.join(BASE_DIR, "run")
SAMPLES_DIR = os.path.join(RUN_DIR, "samples")
UPLOADS_DIR = os.path.join(RUN_DIR, "uploads")
EXPORTS_DIR = os.path.join(RUN_DIR, "exports")

app = Flask(__name__)
_FILES = {}  # file_id -> {"path": ..., "name": ...}


def _ensure_dirs():
    for d in (SAMPLES_DIR, UPLOADS_DIR, EXPORTS_DIR):
        os.makedirs(d, exist_ok=True)


def _register(path, name):
    fid = uuid.uuid4().hex[:12]
    _FILES[fid] = {"path": path, "name": name}
    return fid


def _read(fid):
    info = _FILES.get(fid)
    if not info:
        abort(404, "unknown file id")
    with open(info["path"], "rb") as f:
        return f.read(), info["name"]


def _structure_payload(data, name, fid):
    st = parser.parse(data)
    d = st.to_dict()
    d["file_id"] = fid
    d["name"] = name
    d["kind"] = ("progressive" if st.progressive
                 else "baseline" if st.sof_marker >= 0 else "unknown")
    d["scan_boundaries"] = parser.scan_boundary_offsets(st)
    return d


@app.get("/")
def index():
    return PAGE


@app.get("/api/samples")
def api_samples():
    _ensure_dirs()
    if not os.path.exists(os.path.join(SAMPLES_DIR, "samples.json")):
        samples.generate(SAMPLES_DIR)
    with open(os.path.join(SAMPLES_DIR, "samples.json"),
              encoding="utf-8") as f:
        return jsonify(json.load(f))


@app.post("/api/regen_samples")
def api_regen():
    _ensure_dirs()
    return jsonify(samples.generate(SAMPLES_DIR))


@app.post("/api/load")
def api_load():
    _ensure_dirs()
    if "file" in request.files:
        up = request.files["file"]
        name = up.filename or "upload.jpg"
        path = os.path.join(UPLOADS_DIR, uuid.uuid4().hex[:8] + "_" + name)
        up.save(path)
    else:
        name = request.form.get("sample") or request.args.get("sample")
        path = os.path.join(SAMPLES_DIR, os.path.basename(name or ""))
        if not os.path.isfile(path):
            abort(404, "sample not found")
        name = os.path.basename(path)
    fid = _register(path, name)
    with open(path, "rb") as f:
        data = f.read()
    return jsonify(_structure_payload(data, name, fid))


@app.get("/api/file/<fid>/structure")
def api_structure(fid):
    data, name = _read(fid)
    return jsonify(_structure_payload(data, name, fid))


@app.get("/api/file/<fid>/stages")
def api_stages(fid):
    data, _ = _read(fid)
    results = analyzer.probe_scan_boundaries(data)
    return jsonify([r.to_dict() for r in results])


@app.get("/api/file/<fid>/probe")
def api_probe(fid):
    data, _ = _read(fid)
    offset = int(request.args.get("offset", len(data)))
    return jsonify(analyzer.probe(data, offset).to_dict())


@app.get("/api/file/<fid>/preview.png")
def api_preview(fid):
    data, _ = _read(fid)
    offset = int(request.args.get("offset", len(data)))
    res = analyzer.probe(data, offset)
    if res.image is None:
        abort(422, res.error or "not decodable at this offset")
    buf = io.BytesIO()
    res.image.save(buf, "PNG")
    buf.seek(0)
    return send_file(buf, mimetype="image/png")


@app.get("/api/file/<fid>/compare")
def api_compare(fid):
    data, _ = _read(fid)
    offset = int(request.args.get("offset", len(data)))
    threshold = int(request.args.get("threshold", 8))
    crop = None
    if all(k in request.args for k in ("x0", "y0", "x1", "y1")):
        crop = tuple(int(request.args[k]) for k in ("x0", "y0", "x1", "y1"))
    early = analyzer.probe(data, offset).image
    full = analyzer.probe(data, len(data)).image
    res = compare.compare(early, full, crop=crop, threshold=threshold)
    return jsonify(res.to_dict())


@app.post("/api/file/<fid>/export")
def api_export(fid):
    data, name = _read(fid)
    outdir = os.path.join(EXPORTS_DIR, fid)
    manifest = exporter.export(data, outdir, source_name=name)
    return jsonify({"outdir": outdir,
                    "stages": manifest["stages"],
                    "scan_count": manifest["scan_count"]})


PAGE = """<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>渐进 JPEG 检查工具</title>
<style>
 body{font-family:system-ui,sans-serif;margin:20px;background:#f6f7f9;color:#222}
 h1{font-size:20px} h2{font-size:16px;margin:18px 0 6px}
 section{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin-bottom:14px}
 table{border-collapse:collapse;font-size:12px;width:100%}
 td,th{border:1px solid #ddd;padding:3px 7px;text-align:left}
 th{background:#eef}
 button,select,input{font-size:13px;margin:2px}
 img{max-width:420px;border:1px solid #aaa;background:#fff}
 .ok{color:#087d2f}.partial{color:#b26a00}.bad{color:#b00020}
 .mono{font-family:ui-monospace,monospace;font-size:12px}
 .row{display:flex;gap:18px;flex-wrap:wrap}
 .col{min-width:300px}
 #grid td{width:34px;height:22px;text-align:center;font-size:10px}
</style>
</head>
<body>
<h1>渐进 JPEG 检查工具</h1>

<section>
 <h2>1. 选择文件</h2>
 <select id="sampleSel"></select>
 <button onclick="loadSample()">分析样例</button>
 <button onclick="regen()">重新生成样例</button>
 　或上传: <input type="file" id="up" accept=".jpg,.jpeg">
 <button onclick="upload()">分析上传文件</button>
 <span id="fileInfo" class="mono"></span>
</section>

<section>
 <h2>2. 结构 / 扫描段</h2>
 <div id="summary"></div>
 <div class="row"><div class="col" style="flex:1">
 <table id="segTable"></table></div></div>
</section>

<section>
 <h2>3. 按扫描段预览</h2>
 <div id="stages"></div>
</section>

<section>
 <h2>4. 任意位置截断</h2>
 <input type="range" id="cut" style="width:420px" min="0" max="100" value="100">
 <span id="cutInfo" class="mono"></span><br>
 <button onclick="snapBoundary(-1)">←上一段边界</button>
 <button onclick="snapBoundary(1)">下一段边界→</button>
 <button onclick="midScanCut()">截在当前段中间</button>
 <div class="row" style="margin-top:8px">
  <div class="col"><div>截断预览</div><img id="cutImg"><div id="cutState"></div></div>
  <div class="col"><div>完整图</div><img id="fullImg"></div>
 </div>
</section>

<section>
 <h2>5. 与完整图对比（同一裁区）</h2>
 裁区 x0 <input id="x0" size="4"> y0 <input id="y0" size="4">
 x1 <input id="x1" size="4"> y1 <input id="y1" size="4">
 阈值 <input id="th" size="3" value="8">
 <button onclick="doCompare()">对比当前截断点</button>
 <div id="cmpOut" class="mono"></div>
 <table id="grid"></table>
</section>

<section>
 <h2>6. 导出</h2>
 <button onclick="doExport()">导出扫描清单 + 各阶段 PNG</button>
 <div id="expOut" class="mono"></div>
</section>

<script>
let fid=null, struct=null, stages=[], boundaries=[];

async function j(u, opt){ const r=await fetch(u,opt);
  if(!r.ok){ throw new Error(await r.text()); } return r.json(); }

async function refreshSamples(){
  const s = await j('/api/samples');
  const sel = document.getElementById('sampleSel'); sel.innerHTML='';
  Object.keys(s.files).forEach(n=>{ const o=document.createElement('option');
    o.value=n; o.textContent=n; sel.appendChild(o); });
}
async function regen(){ await j('/api/regen_samples',{method:'POST'});
  refreshSamples(); }
async function loadSample(){
  const n=document.getElementById('sampleSel').value;
  const fd=new FormData(); fd.append('sample',n);
  await load('/api/load',{method:'POST',body:fd});
}
async function upload(){
  const f=document.getElementById('up').files[0]; if(!f) return alert('先选文件');
  const fd=new FormData(); fd.append('file',f);
  await load('/api/load',{method:'POST',body:fd});
}
async function load(url,opt){
  struct = await j(url,opt); fid=struct.file_id;
  boundaries = struct.scan_boundaries;
  document.getElementById('fileInfo').textContent =
    `${struct.name}  ${struct.size}B  ${struct.kind}  ${struct.width}x${struct.height}  扫描数=${struct.scan_count}`;
  document.getElementById('summary').innerHTML =
    `<b>${struct.kind==='progressive'?'渐进式':'普通(基线)'} JPEG</b>，
     尺寸 ${struct.width}×${struct.height}，共 ${struct.scan_count} 个扫描段`;
  let rows='<tr><th>#</th><th>标记</th><th>起始</th><th>结束</th><th>长度</th><th>备注</th></tr>';
  struct.segments.forEach(s=>{
    let note='';
    if(s.marker===0xDA) note=`扫描 ${s.scan_index}：熵数据 [${s.entropy_start}, ${s.entropy_end})`
      + (s.scan_complete?'':' （不完整）');
    rows+=`<tr><td>${s.index}</td><td>${s.name}</td><td>${s.offset}</td>
      <td>${s.end}</td><td>${s.length}</td><td>${note}</td></tr>`;});
  document.getElementById('segTable').innerHTML=rows;
  stages = await j(`/api/file/${fid}/stages`);
  let h='';
  stages.forEach((st,i)=>{
    h+=`<button onclick="gotoOffset(${st.offset})">段末 ${st.offset}B
      (${(st.coverage*100).toFixed(1)}%) ${st.state_label}</button> `;
  });
  document.getElementById('stages').innerHTML=h;
  const sl=document.getElementById('cut');
  sl.max=struct.size; sl.value=struct.size;
  document.getElementById('fullImg').src=`/api/file/${fid}/preview.png?offset=${struct.size}`;
  document.getElementById('x1').value=struct.width;
  document.getElementById('y1').value=struct.height;
  document.getElementById('x0').value=0; document.getElementById('y0').value=0;
  sl.oninput=()=>gotoOffset(+sl.value);
  gotoOffset(struct.size);
}
function gotoOffset(off){
  const sl=document.getElementById('cut'); sl.value=off;
  document.getElementById('cutInfo').textContent=`截断于 ${off} 字节`;
  probe(off);
}
async function probe(off){
  const p = await j(`/api/file/${fid}/probe?offset=${off}`);
  const el=document.getElementById('cutState');
  const cls = p.state==='ok'?'ok':(p.state==='partial'?'partial':'bad');
  el.innerHTML=`<span class="${cls}">${p.state_label}</span>
    覆盖 ${(p.coverage*100).toFixed(1)}%，已含完整扫描段 [${p.scan_indices}]`
    + (p.mid_scan?'，截在某段中间':'') + (p.error?`<br>解码提示：${p.error}`:'');
  const img=document.getElementById('cutImg');
  img.src=`/api/file/${fid}/preview.png?offset=${off}&t=${Date.now()}`;
  img.onerror=()=>{ img.removeAttribute('src'); };
}
function snapBoundary(dir){
  const cur=+document.getElementById('cut').value;
  const sorted=[...boundaries, struct.size].sort((a,b)=>a-b);
  let t = dir>0 ? sorted.find(b=>b>cur) : [...sorted].reverse().find(b=>b<cur);
  if(t===undefined) t = dir>0 ? struct.size : sorted[0];
  gotoOffset(t);
}
function midScanCut(){
  const cur=+document.getElementById('cut').value;
  const scans=struct.segments.filter(s=>s.marker===0xDA);
  const s=scans.find(s=>s.entropy_end>cur) || scans[scans.length-1];
  if(s) gotoOffset(Math.floor((s.entropy_start+s.entropy_end)/2));
}
async function doCompare(){
  const off=+document.getElementById('cut').value;
  const p=new URLSearchParams({offset:off,threshold:document.getElementById('th').value,
    x0:x0v(),y0:y0v(),x1:x1v(),y1:y1v()});
  const c=await j(`/api/file/${fid}/compare?`+p);
  const out=document.getElementById('cmpOut');
  if(!c.comparable){ out.textContent='不可比：'+c.reason;
    document.getElementById('grid').innerHTML=''; return; }
  out.textContent=`裁区 [${c.crop}]  平均差 ${c.mean_abs_diff}  最大差 ${c.max_abs_diff}  `
    +`超阈值像素占比 ${(c.changed_fraction*100).toFixed(1)}%  `
    +(c.last_changed_region.length?`最晚仍明显变化区域 [${c.last_changed_region}]`:'已无超阈值区域');
  let g='<tr>'+c.block_mean_diff[0].map((_,i)=>`<th>${i}</th>`).join('')+'</tr>';
  c.block_mean_diff.forEach(row=>{ g+='<tr>'+row.map(v=>{
    const hot=Math.min(255,Math.round(v*4));
    return `<td style="background:rgb(${hot},${255-hot},120)">${v.toFixed(0)}</td>`;}).join('')+'</tr>';});
  document.getElementById('grid').innerHTML=g;
}
const x0v=()=>+document.getElementById('x0').value, y0v=()=>+document.getElementById('y0').value,
      x1v=()=>+document.getElementById('x1').value, y1v=()=>+document.getElementById('y1').value;
async function doExport(){
  const r=await j(`/api/file/${fid}/export`,{method:'POST'});
  document.getElementById('expOut').textContent =
    `已导出到 ${r.outdir}（manifest.json + ${r.stages.filter(s=>s.png).length} 张 PNG）`;
}
refreshSamples();
</script>
</body></html>
"""


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5000)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    _ensure_dirs()
    if not os.path.exists(os.path.join(SAMPLES_DIR, "samples.json")):
        samples.generate(SAMPLES_DIR)
    app.run(host=args.host, port=args.port, debug=False)


if __name__ == "__main__":
    main()
