"""本地网页界面（Flask）。

所有数据都在本机处理，不发起任何外部网络请求。会话图片存在工作目录下，
原图只读、永不覆盖。
"""

from __future__ import annotations

import json
import os
import time
import uuid

import cv2
import numpy as np
from flask import (Flask, jsonify, request, send_file, send_from_directory)

from ..batch import run_batch
from ..params import ProcessParams
from ..pipeline import (histogram, overlay_issues, process_array, process_file,
                        read_gray, to_gray)

PREVIEW_MAX_DIM = 1100


def _workspace() -> str:
    ws = os.environ.get("SKETCHCLEAN_WORKSPACE",
                        os.path.join(os.path.expanduser("~"), ".sketchclean"))
    os.makedirs(ws, exist_ok=True)
    return ws


def create_app() -> Flask:
    app = Flask(__name__, static_folder="static", template_folder="templates")
    ws = _workspace()
    sessions_dir = os.path.join(ws, "sessions")
    exports_dir = os.path.join(ws, "exports")
    os.makedirs(sessions_dir, exist_ok=True)
    os.makedirs(exports_dir, exist_ok=True)

    def _sess_dir(sid: str) -> str:
        if ".." in sid or "/" in sid or "\\" in sid or not os.path.isdir(
                os.path.join(sessions_dir, sid)):
            from werkzeug.exceptions import NotFound
            raise NotFound("会话不存在")
        return os.path.join(sessions_dir, sid)

    @app.errorhandler(FileNotFoundError)
    def _not_found(_exc):
        return jsonify({"ok": False, "error": "会话不存在"}), 404

    @app.errorhandler(404)
    def _http_not_found(_exc):
        return jsonify({"ok": False, "error": "资源不存在"}), 404

    def _params() -> ProcessParams:
        d = request.get_json(silent=True) or {}
        return ProcessParams.from_dict(d.get("params", {}))

    @app.route("/")
    def index():
        return send_from_directory(app.template_folder, "index.html")

    @app.route("/favicon.ico")
    def favicon():
        return ("", 204)

    @app.route("/static/<path:fname>")
    def static_files(fname):
        return send_from_directory(app.static_folder, fname)

    # ------------------------------------------------------------ 导入
    @app.route("/api/upload", methods=["POST"])
    def upload():
        f = request.files.get("file")
        if f is None or not f.filename:
            return jsonify({"ok": False, "error": "未收到文件"}), 400
        sid = uuid.uuid4().hex[:12]
        sdir = os.path.join(sessions_dir, sid)
        os.makedirs(sdir, exist_ok=True)
        # 只信任扩展名做命名，文件内容交给 PIL 解码验证。
        ext = os.path.splitext(f.filename)[1].lower() or ".png"
        src = os.path.join(sdir, f"original{ext}")
        f.save(src)
        try:
            gray = read_gray(src)
        except Exception as exc:
            return jsonify({"ok": False,
                            "error": f"无法读取图片: {type(exc).__name__}: {exc}"}), 400
        h, w = gray.shape
        scale = min(1.0, PREVIEW_MAX_DIM / max(h, w))
        preview = cv2.resize(gray, (max(1, int(round(w * scale))),
                                    max(1, int(round(h * scale)))),
                             interpolation=cv2.INTER_AREA) \
            if scale < 1.0 else gray
        cv2.imwrite(os.path.join(sdir, "preview.png"), preview)
        hist = histogram(gray)
        return jsonify({"ok": True, "session": sid,
                        "width": w, "height": h,
                        "preview_width": preview.shape[1],
                        "preview_height": preview.shape[0],
                        "histogram": hist.tolist(),
                        "hist_median": float(np.median(gray)),
                        "hist_p05": float(np.quantile(gray, 0.05)),
                        "hist_p95": float(np.quantile(gray, 0.95)),
                        "name": f.filename})

    @app.route("/api/sample/<which>")
    def load_sample(which: str):
        root = os.path.dirname(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))))
        name = ("sketch_shadow.png" if which == "shadow"
                else "sketch_paper_texture.png")
        path = os.path.join(root, "samples", name)
        if not os.path.exists(path):
            return jsonify({"ok": False, "error": "样图不存在，先运行 "
                                                  "python -m sketchclean.samples"}), 404
        sid = uuid.uuid4().hex[:12]
        sdir = os.path.join(sessions_dir, sid)
        os.makedirs(sdir, exist_ok=True)
        gray = read_gray(path)
        cv2.imwrite(os.path.join(sdir, "original.png"), gray)
        h, w = gray.shape
        scale = min(1.0, PREVIEW_MAX_DIM / max(h, w))
        preview = cv2.resize(gray, (int(round(w * scale)),
                                    int(round(h * scale))),
                             interpolation=cv2.INTER_AREA) \
            if scale < 1.0 else gray
        cv2.imwrite(os.path.join(sdir, "preview.png"), preview)
        return jsonify({"ok": True, "session": sid,
                        "width": w, "height": h,
                        "preview_width": preview.shape[1],
                        "preview_height": preview.shape[0],
                        "histogram": histogram(gray).tolist(),
                        "hist_median": float(np.median(gray)),
                        "hist_p05": float(np.quantile(gray, 0.05)),
                        "hist_p95": float(np.quantile(gray, 0.95)),
                        "name": name})

    @app.route("/api/image/<sid>/<kind>")
    def get_image(sid: str, kind: str):
        sdir = _sess_dir(sid)
        mapping = {"original": "preview.png",
                   "cleaned": "cleaned.png",
                   "background": "background.png",
                   "inspect": "inspect.png"}
        if kind not in mapping:
            return jsonify({"ok": False, "error": "未知图像"}), 400
        path = os.path.join(sdir, mapping[kind])
        if not os.path.exists(path):
            return jsonify({"ok": False, "error": "图像尚未生成"}), 404
        # 加时间戳防浏览器缓存旧处理结果。
        return send_file(path, mimetype="image/png",
                         download_name=mapping[kind])

    # ------------------------------------------------------------ 处理
    @app.route("/api/process/<sid>", methods=["POST"])
    def process(sid: str):
        sdir = _sess_dir(sid)
        p = _params()
        preview = cv2.imread(os.path.join(sdir, "preview.png"),
                             cv2.IMREAD_GRAYSCALE)
        if preview is None:
            return jsonify({"ok": False, "error": "预览图丢失"}), 400
        t0 = time.time()
        result = process_array(preview, p)
        cv2.imwrite(os.path.join(sdir, "cleaned.png"), result.cleaned)
        cv2.imwrite(os.path.join(sdir, "background.png"), result.background)
        overlay = overlay_issues(result.cleaned, {
            "breaks": result.break_mask,
            "dots": result.small_dot_mask,
            "shadow": result.shadow_mask,
        })
        cv2.imwrite(os.path.join(sdir, "inspect.png"), overlay)
        with open(os.path.join(sdir, "last_params.json"), "w",
                  encoding="utf-8") as f:
            json.dump(p.to_dict(), f, ensure_ascii=False)
        return jsonify({
            "ok": True,
            "ms": int((time.time() - t0) * 1000),
            "width": int(result.cleaned.shape[1]),
            "height": int(result.cleaned.shape[0]),
            "counts": {"dots": len(result.meta.get("dots", [])),
                       "breaks": int(result.break_mask.sum()),
                       "shadow": int(result.shadow_mask.sum())},
            "hist_cleaned": histogram(result.cleaned).tolist(),
            "hist_original": histogram(result.original).tolist(),
        })

    # ------------------------------------------------------------ 导出（原尺寸）
    @app.route("/api/export/<sid>", methods=["POST"])
    def export(sid: str):
        sdir = _sess_dir(sid)
        p = _params()
        originals = [f for f in os.listdir(sdir) if f.startswith("original.")]
        if not originals:
            return jsonify({"ok": False, "error": "原图丢失"}), 400
        gray = read_gray(os.path.join(sdir, originals[0]))
        result = process_array(gray, p)  # 同一条管线、同一套归一化参数
        outdir = os.path.join(exports_dir, sid)
        os.makedirs(outdir, exist_ok=True)
        out_img = os.path.join(outdir, "cleaned.full.png")
        cv2.imwrite(out_img, result.cleaned)
        with open(os.path.join(outdir, "params.json"), "w",
                  encoding="utf-8") as f:
            json.dump(p.to_dict(), f, ensure_ascii=False, indent=2)
        return jsonify({"ok": True, "output": out_img,
                        "params": os.path.join(outdir, "params.json"),
                        "width": int(result.cleaned.shape[1]),
                        "height": int(result.cleaned.shape[0])})

    @app.route("/api/download/<sid>")
    def download(sid: str):
        _sess_dir(sid)  # 校验会话存在且 sid 合法
        name = request.args.get("file", "cleaned.full.png")
        if name not in ("cleaned.full.png", "params.json"):
            return jsonify({"ok": False, "error": "非法文件名"}), 400
        outdir = os.path.join(exports_dir, sid)
        if not os.path.exists(os.path.join(outdir, name)):
            return jsonify({"ok": False, "error": "文件尚未导出"}), 404
        return send_file(os.path.join(outdir, name), as_attachment=True)

    # ------------------------------------------------------------ 批量
    @app.route("/api/batch", methods=["POST"])
    def batch():
        d = request.get_json(silent=True) or {}
        paths = d.get("paths") or []
        outdir = d.get("outdir") or os.path.join(exports_dir,
                                                 f"batch_{int(time.time())}")
        params = ProcessParams.from_dict(d.get("params", {}))
        if not paths:
            return jsonify({"ok": False, "error": "未选择输入"}), 400
        report = run_batch(paths, outdir, params)
        return jsonify({"ok": True, "outdir": outdir,
                        "report": report.to_dict()})

    return app


def main() -> int:
    app = create_app()
    port = int(os.environ.get("SKETCHCLEAN_PORT", "8765"))
    app.run(host="127.0.0.1", port=port, threaded=True)
    return 0
