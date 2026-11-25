"""本地视频防抖工具 —— Flask 服务入口。

启动:
    python3 app.py                 # 启动并自动打开浏览器
    python3 app.py --no-browser    # 只启动服务
    python3 app.py --port 9000

所有接口只监听 127.0.0.1, 不会对外网开放。
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import threading
import webbrowser
from pathlib import Path
from typing import Any

from flask import (
    Flask, Response, jsonify, render_template, request, send_from_directory,
)

from vstab.engine import Stabilizer, analyze_video, encode_jpeg
from vstab.exporter import export_video
from vstab.jobs import jobs
from vstab.samples import generate_all, generate_clip, samples_status
from vstab.storage import (
    EXPORTS_DIR, list_projects, load_project, project_path,
    save_project, unique_export_path,
)

app = Flask(__name__, template_folder="templates", static_folder="static")


# ---------------------------------------------------------------------------
# 当前会话(本地单用户, 全局只保留一个正在调整的项目)
# ---------------------------------------------------------------------------

class Session:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.stab: Stabilizer | None = None
        self.project_file: str | None = None  # 已保存项目文件名

    def require(self) -> Stabilizer:
        if self.stab is None:
            raise RuntimeError("尚未打开视频或项目")
        return self.stab


SESSION = Session()


# ---------------------------------------------------------------------------
# 页面
# ---------------------------------------------------------------------------

@app.get("/")
def index() -> str:
    return render_template("index.html")


@app.get("/api/health")
def health() -> Any:
    return jsonify({"ok": True, "app": "video-stabilizer-local"})


# ---------------------------------------------------------------------------
# 示例素材
# ---------------------------------------------------------------------------

@app.get("/api/samples")
def get_samples() -> Any:
    return jsonify({"samples": samples_status()})


@app.post("/api/samples/generate")
def post_generate_samples() -> Any:
    body = request.get_json(silent=True) or {}
    kind = body.get("kind")  # None / "all" 表示全部

    def job_fn(job) -> dict:
        if kind and kind != "all":
            path = generate_clip(kind, progress=lambda p, m: job.set_progress(p, m))
            return {"files": [str(path)]}
        paths = generate_all(progress=lambda p, m: job.set_progress(p, m))
        return {"files": [str(p) for p in paths]}

    job = jobs.start("samples", job_fn)
    return jsonify({"job_id": job.id})


# ---------------------------------------------------------------------------
# 视频分析 / 会话状态
# ---------------------------------------------------------------------------

@app.post("/api/analyze")
def post_analyze() -> Any:
    body = request.get_json(force=True) or {}
    raw_path = (body.get("path") or "").strip().strip('"')
    if not raw_path:
        return jsonify({"error": "缺少 path 参数"}), 400
    path = Path(raw_path).expanduser()
    if not path.exists():
        return jsonify({"error": f"文件不存在: {path}"}), 404

    def job_fn(job) -> dict:
        analysis = analyze_video(
            path,
            progress=lambda p, m: job.set_progress(p * 0.95, m),
            should_cancel=lambda: job.cancelled,
        )
        stab = Stabilizer(analysis)
        with SESSION.lock:
            if SESSION.stab is not None:
                try:
                    SESSION.stab.close()
                except Exception:
                    pass
            SESSION.stab = stab
            SESSION.project_file = None
        job.set_progress(1.0, "分析完成")
        return {"frame_count": stab.frame_count}

    job = jobs.start("analyze", job_fn)
    return jsonify({"job_id": job.id})


def _merge_intervals(intervals: list[list[int]]) -> list[list[int]]:
    if not intervals:
        return []
    intervals = sorted((min(a, b), max(a, b)) for a, b in intervals)
    merged = [list(intervals[0])]
    for s, e in intervals[1:]:
        if s <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return merged


def _auto_exclusions(stab: Stabilizer, mark_pan: bool, mark_cuts: bool,
                     pad: int) -> list[dict]:
    n = stab.frame_count
    raw: list[list[int]] = []

    if mark_pan and stab.pan_frames:
        # 把连续的摇摄帧归组为区间
        run = [stab.pan_frames[0], stab.pan_frames[0]]
        for f in stab.pan_frames[1:]:
            if f <= run[1] + 2:
                run[1] = f
            else:
                raw.append([run[0] - pad, run[1] + pad])
                run = [f, f]
        raw.append([run[0] - pad, run[1] + pad])

    if mark_cuts:
        for c in stab.cut_frames:
            raw.append([c - pad, c + pad])

    # 与已有区间合并
    for ex in stab.params.get("exclusions", []):
        raw.append([int(ex["start"]), int(ex["end"])])

    merged = _merge_intervals(raw)
    return [
        {"start": max(0, s), "end": min(n - 1, e), "label": "自动标记"}
        for s, e in merged
        if e >= 0 and s < n
    ]


@app.get("/api/session")
def get_session() -> Any:
    with SESSION.lock:
        stab = SESSION.stab
        if stab is None:
            return jsonify({"has_session": False, "samples": samples_status()})

        z = float(stab.params["crop_zoom"])
        return jsonify({
            "has_session": True,
            "project_file": SESSION.project_file,
            "source_path": stab.analysis["source_path"],
            "video_name": Path(stab.analysis["source_path"]).stem,
            "width": stab.width,
            "height": stab.height,
            "fps": stab.fps,
            "frame_count": stab.frame_count,
            "has_audio": bool(stab.analysis.get("has_audio")),
            "params": stab.params,
            "radius_frames": stab.radius,
            "auto_zoom": stab.auto_zoom,
            "warnings": stab.warnings,
            "effective_source": {
                "width": round(stab.width / z),
                "height": round(stab.height / z),
                "zoom": z,
            },
            "chart": {
                "trajectory": stab.analysis["trajectory"],
                "smoothed": stab.smoothed.tolist(),
                "motion": stab.analysis.get("motion", []),
                "envelope": stab.envelope.tolist(),
                "cut_frames": stab.cut_frames,
                "pan_frames": stab.pan_frames,
            },
        })


@app.post("/api/params")
def post_params() -> Any:
    body = request.get_json(force=True) or {}
    with SESSION.lock:
        stab = SESSION.require()
        allowed = {
            "strength", "smooth_sec", "crop_zoom", "crop_mode",
            "adaptive_pan", "pan_sensitivity", "show_overlay", "exclusions",
        }
        for key in allowed:
            if key in body:
                stab.params[key] = body[key]

        # 数值范围保护
        stab.params["strength"] = float(min(1.0, max(0.0, stab.params["strength"])))
        stab.params["smooth_sec"] = float(min(4.0, max(0.05, stab.params["smooth_sec"])))
        stab.params["crop_zoom"] = float(min(4.0, max(1.0, stab.params["crop_zoom"])))
        stab.params["pan_sensitivity"] = float(
            min(3.0, max(0.3, stab.params["pan_sensitivity"]))
        )
        clean_ex = []
        for ex in stab.params.get("exclusions", []):
            s = int(ex["start"])
            e = int(ex["end"])
            s, e = max(0, min(stab.frame_count - 1, min(s, e))), \
                   max(0, min(stab.frame_count - 1, max(s, e)))
            clean_ex.append({"start": s, "end": e,
                             "label": str(ex.get("label", "手动标记"))[:40]})
        # 合并重叠区间, 保持整洁
        merged = _merge_intervals([[x["start"], x["end"]] for x in clean_ex])
        labels = {(x["start"], x["end"]): x.get("label", "手动标记") for x in clean_ex}
        stab.params["exclusions"] = [
            {"start": s, "end": e, "label": labels.get((s, e), "不处理区间")}
            for s, e in merged
        ]

        stab.recompute()
        z = float(stab.params["crop_zoom"])
        return jsonify({
            "ok": True,
            "params": stab.params,
            "auto_zoom": stab.auto_zoom,
            "radius_frames": stab.radius,
            "warnings": stab.warnings,
            "effective_source": {
                "width": round(stab.width / z),
                "height": round(stab.height / z),
                "zoom": z,
            },
            "chart": {
                "smoothed": stab.smoothed.tolist(),
                "envelope": stab.envelope.tolist(),
            },
        })


@app.post("/api/exclusions/auto")
def post_auto_exclusions() -> Any:
    body = request.get_json(silent=True) or {}
    with SESSION.lock:
        stab = SESSION.require()
        pad = int(body.get("pad", 10))
        mark_pan = bool(body.get("pan", True))
        mark_cuts = bool(body.get("cuts", False))
        mode = body.get("mode", "merge")  # merge | replace
        if mode == "replace":
            stab.params["exclusions"] = []
        stab.params["exclusions"] = _auto_exclusions(stab, mark_pan, mark_cuts, pad)
        stab.recompute()
        return jsonify({"ok": True, "exclusions": stab.params["exclusions"]})


# ---------------------------------------------------------------------------
# 逐帧预览(与导出共用 Stabilizer.render_stabilized)
# ---------------------------------------------------------------------------

@app.get("/api/frame")
def get_frame() -> Response:
    kind = request.args.get("kind", "stable")
    index = int(request.args.get("i", 0))
    max_w = int(request.args.get("w", 1280))
    overlay = request.args.get("overlay", "1") not in ("0", "false", "False")

    # 只在取引用时持有会话锁; 解码 / 渲染 / 编码在锁外进行,
    # stab 内部有自己的读取锁与单帧缓存(原图与稳定图共享一次解码)。
    with SESSION.lock:
        stab = SESSION.require()
    index = max(0, min(stab.frame_count - 1, index))
    frame = stab.read_frame(index)
    if kind == "original":
        img = stab.draw_overlay(frame, index) if overlay else frame
    else:
        img = stab.render_stabilized(frame, index)
    data = encode_jpeg(img, max_width=max_w)
    return Response(data, mimetype="image/jpeg",
                    headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------------------------
# 处理参数导出(JSON)
# ---------------------------------------------------------------------------

@app.get("/api/params/export")
def export_params_file() -> Any:
    with SESSION.lock:
        stab = SESSION.require()
        payload = stab.export_params_dict()
    name = f"{Path(stab.analysis['source_path']).stem}_stabilize_params.json"
    return Response(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        mimetype="application/json",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


# ---------------------------------------------------------------------------
# 项目保存 / 载入
# ---------------------------------------------------------------------------

@app.get("/api/projects")
def get_projects() -> Any:
    return jsonify({"projects": list_projects()})


@app.post("/api/projects/save")
def post_project_save() -> Any:
    body = request.get_json(silent=True) or {}
    with SESSION.lock:
        stab = SESSION.require()
        default_name = Path(stab.analysis["source_path"]).stem
        name = (body.get("name") or default_name).strip() or default_name
        data = stab.to_project_dict(name=name)
        path = save_project(data, name)
        SESSION.project_file = path.name
    return jsonify({"ok": True, "file": path.name, "path": str(path)})


@app.post("/api/projects/load")
def post_project_load() -> Any:
    body = request.get_json(force=True) or {}
    file = body.get("file") or ""
    try:
        data = load_project(file)
    except FileNotFoundError:
        return jsonify({"error": f"项目不存在: {file}"}), 404
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"项目文件损坏: {exc}"}), 400

    def job_fn(job) -> dict:
        stab = Stabilizer.from_project_dict(data)
        # 检查原片是否还在(不在也允许载入查看参数, 但预览会报错)
        source_exists = Path(stab.analysis["source_path"]).exists()
        with SESSION.lock:
            if SESSION.stab is not None:
                try:
                    SESSION.stab.close()
                except Exception:
                    pass
            SESSION.stab = stab
            SESSION.project_file = Path(file).name
        job.set_progress(1.0, "项目已载入")
        return {"source_exists": source_exists}

    job = jobs.start("load", job_fn)
    return jsonify({"job_id": job.id})


# ---------------------------------------------------------------------------
# 视频导出
# ---------------------------------------------------------------------------

@app.post("/api/export")
def post_export() -> Any:
    body = request.get_json(silent=True) or {}
    with SESSION.lock:
        stab = SESSION.require()
        stem = (body.get("name") or Path(stab.analysis["source_path"]).stem).strip()
        out_path = unique_export_path(stem)
        # 点击导出的瞬间冻结整套逐帧矩阵与处理参数,
        # 导出过程中再调参也不会影响本次结果。
        matrices_snapshot = [m.copy() for m in stab.matrices]
        params_snapshot = stab.export_params_dict()

    sidecar = out_path.with_suffix(".params.json")

    def job_fn(job) -> dict:
        # 同步写一份处理参数 sidecar(使用冻结的快照)
        try:
            sidecar.write_text(
                json.dumps(params_snapshot, ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception:
            pass

        export_video(
            stab, out_path,
            matrices=matrices_snapshot,
            progress=lambda p, m: job.set_progress(p, m),
            should_cancel=lambda: job.cancelled,
        )
        return {
            "path": str(out_path),
            "file": out_path.name,
            "url": f"/api/exports/{out_path.name}",
            "params_sidecar": sidecar.name if sidecar.exists() else None,
        }

    job = jobs.start("export", job_fn)
    return jsonify({"job_id": job.id, "output": out_path.name})


@app.get("/api/exports/<path:filename>")
def download_export(filename: str) -> Any:
    return send_from_directory(EXPORTS_DIR, filename, as_attachment=False)


@app.get("/api/exports")
def list_exports() -> Any:
    files = []
    for p in sorted(EXPORTS_DIR.glob("*.mp4"),
                    key=lambda x: x.stat().st_mtime, reverse=True):
        files.append({
            "file": p.name,
            "size_mb": round(p.stat().st_size / 1024 / 1024, 2),
            "url": f"/api/exports/{p.name}",
        })
    return jsonify({"exports": files})


@app.post("/api/reveal")
def post_reveal() -> Any:
    """在系统文件管理器中定位文件(仅本机使用)。"""
    body = request.get_json(silent=True) or {}
    target = body.get("path") or str(EXPORTS_DIR)
    p = Path(target)
    if not p.exists():
        p = EXPORTS_DIR
    try:
        system = platform.system()
        if system == "Darwin":
            if p.is_file():
                subprocess.Popen(["open", "-R", str(p)])
            else:
                subprocess.Popen(["open", str(p)])
        elif system == "Windows":
            subprocess.Popen(["explorer", "/select,", str(p)])
        else:
            subprocess.Popen(["xdg-open", str(p.parent if p.is_file() else p)])
        return jsonify({"ok": True})
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(exc)}), 200


# ---------------------------------------------------------------------------
# 任务轮询
# ---------------------------------------------------------------------------

@app.get("/api/job/<job_id>")
def get_job(job_id: str) -> Any:
    job = jobs.get(job_id)
    if job is None:
        return jsonify({"error": "任务不存在"}), 404
    return jsonify(job.to_dict())


@app.post("/api/job/<job_id>/cancel")
def cancel_job(job_id: str) -> Any:
    job = jobs.get(job_id)
    if job is None:
        return jsonify({"error": "任务不存在"}), 404
    job.cancel()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# 启动
# ---------------------------------------------------------------------------

def _pick_port(start: int) -> int:
    import socket
    for port in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return start


def main() -> None:
    parser = argparse.ArgumentParser(description="本地视频防抖工具")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--generate-samples", action="store_true",
                        help="生成三套示例短片后退出")
    args = parser.parse_args()

    if args.generate_samples:
        paths = generate_all(progress=lambda p, m: print(f"[{p*100:5.1f}%] {m}"))
        print("生成完成:")
        for p in paths:
            print(" -", p)
        return

    port = _pick_port(args.port)
    url = f"http://{args.host}:{port}/"
    print("=" * 60)
    print("  本地视频防抖工具已启动")
    print(f"  请在浏览器打开: {url}")
    print("  按 Ctrl+C 停止服务")
    print("=" * 60)
    if not args.no_browser and not os.environ.get("VSTAB_NO_BROWSER"):
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    # threaded=True: 帧请求与任务轮询可以并发
    app.run(host=args.host, port=port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
