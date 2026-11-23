"""本地 Flask 服务：图像分析的 HTTP 接口。

全部接口仅监听 127.0.0.1，图片与工程文件只在本机临时目录流转，
不访问任何网络。前端是 web/ 下的原生 JS 单页。
"""

from __future__ import annotations

import base64
import io
import json
import tempfile
import uuid
from pathlib import Path

import cv2
import numpy as np
from flask import Flask, jsonify, request, send_file, send_from_directory

from .compare import compare_segmentations
from .demo_data import generate_all
from .export_project import (
    build_export, draw_annotation, load_project,
    restore_calibration, save_project, validate_project_against_image,
)
from .geometry import Calibration, Ruler
from .measurements import DEFAULT_PROJECTION_ANGLES, measure_all
from .segmentation import (
    SegmentParams, encode_png, load_gray, render_overlay, segment,
)

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
DEMO_DIR = Path(__file__).resolve().parent.parent / "demo"
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "output"


class AppState:
    """进程内会话状态（本地单用户工具，够用且无外部依赖）。"""

    def __init__(self) -> None:
        self.images: dict[str, dict] = {}
        self.segmentations: dict[str, dict] = {}   # image_id -> {params_key: Segmentation}
        self.calibrations: dict[str, Calibration] = {}
        self.pending: dict[str, dict[int, dict]] = {}
        self.snapshots: dict[str, list[dict]] = {}

    def reset_image(self, image_id: str) -> None:
        self.segmentations.pop(image_id, None)
        self.calibrations.pop(image_id, None)
        self.pending.pop(image_id, None)
        self.snapshots.pop(image_id, None)


STATE = AppState()


def create_app() -> Flask:
    app = Flask(__name__, static_folder=None)
    OUTPUT_DIR.mkdir(exist_ok=True)

    # ---------------- 静态页面 ---------------- #
    @app.get("/")
    def index():
        return send_from_directory(WEB_DIR, "index.html")

    @app.get("/favicon.ico")
    def favicon():
        return ("", 204)

    @app.get("/static/<path:fname>")
    def static_files(fname):
        return send_from_directory(WEB_DIR / "static", fname)

    @app.get("/api/demo/list")
    def demo_list():
        gt_path = DEMO_DIR / "ground_truth.json"
        if not gt_path.exists():
            generate_all(DEMO_DIR)
        gt = json.loads(gt_path.read_text(encoding="utf-8"))
        return jsonify(gt)

    @app.post("/api/demo/load/<name>")
    def demo_load(name: str):
        safe = {"a": "demo_a_aligned.png", "b": "demo_b_rotated.png",
                "c": "demo_c_edge.png"}.get(name)
        if not safe:
            return jsonify({"error": "未知演示"}), 404
        return _register_image(DEMO_DIR / safe)

    @app.post("/api/demo/calibration/<name>")
    def demo_calibration(name: str):
        """用 ground truth 里的标尺端点一键建立标定。"""
        gt = json.loads((DEMO_DIR / "ground_truth.json").read_text(encoding="utf-8"))
        image_id = request.json.get("image_id")
        entry = next((e for e in gt["images"]
                      if e["image"] == {"a": "demo_a_aligned.png",
                                        "b": "demo_b_rotated.png",
                                        "c": "demo_c_edge.png"}[name]), None)
        if not entry or image_id not in STATE.images:
            return jsonify({"error": "演示数据或图片不存在"}), 404
        # ground_truth 里 rulers 是 [横尺, 纵尺] 的列表
        calib = _calibration_from_payload(
            {"horizontal": entry["rulers"][0],
             "vertical": entry["rulers"][1]},
            STATE.images[image_id]["shape"],
        )
        STATE.calibrations[image_id] = calib
        return jsonify(_calibration_payload(calib))

    # ---------------- 图片导入 ---------------- #
    @app.post("/api/image/upload")
    def image_upload():
        f = request.files.get("image")
        if not f:
            return jsonify({"error": "缺少 image 文件"}), 400
        suffix = Path(f.filename or "upload.png").suffix or ".png"
        tmp = Path(tempfile.mkdtemp(prefix="measure_")) / f"scan{suffix}"
        f.save(tmp)
        try:
            return _register_image(tmp)
        except FileNotFoundError as exc:
            return jsonify({"error": str(exc)}), 400

    @app.get("/api/image/<image_id>/file")
    def image_file(image_id: str):
        rec = STATE.images.get(image_id)
        if not rec:
            return jsonify({"error": "图片不存在"}), 404
        return send_file(rec["path"])

    # ---------------- 标定 ---------------- #
    @app.post("/api/calibration/<image_id>")
    def set_calibration(image_id: str):
        rec = STATE.images.get(image_id)
        if not rec:
            return jsonify({"error": "图片不存在"}), 404
        try:
            calib = _calibration_from_payload(request.json, rec["shape"])
        except (KeyError, TypeError, ValueError) as exc:
            return jsonify({"error": f"标定参数无效: {exc}"}), 400
        STATE.calibrations[image_id] = calib
        return jsonify(_calibration_payload(calib))

    @app.get("/api/calibration/<image_id>")
    def get_calibration(image_id: str):
        calib = STATE.calibrations.get(image_id)
        if not calib:
            return jsonify({"error": "尚未标定"}), 404
        return jsonify(_calibration_payload(calib))

    # ---------------- 分割与轮廓 ---------------- #
    @app.post("/api/analyze/<image_id>")
    def analyze(image_id: str):
        rec = STATE.images.get(image_id)
        if not rec:
            return jsonify({"error": "图片不存在"}), 404
        p = request.json
        params = SegmentParams(
            threshold=int(p.get("threshold", 128)),
            min_speck_area_px=int(p.get("min_speck_area_px", 3000)),
            morph_open=int(p.get("morph_open", 0)),
            invert=bool(p.get("invert", False)),
        )
        seg = segment(rec["gray"], params)
        key = _params_key(params)
        STATE.segmentations.setdefault(image_id, {})[key] = seg

        overlay = render_overlay(rec["gray"], seg)
        png_bytes, scale = encode_png(overlay)
        payload = {
            "params": params.to_dict(),
            "params_key": key,
            "image_shape": list(seg.image_shape),
            "overlay_png": "data:image/png;base64,"
                           + base64.b64encode(png_bytes).decode("ascii"),
            "overlay_scale": scale,
            "counts": {
                "outer": sum(1 for c in seg.components.values()
                             if c.kind == "outer"),
                "hole": sum(1 for c in seg.components.values()
                            if c.kind == "hole"),
                "border": sum(1 for c in seg.components.values()
                              if c.kind == "border"),
                "dropped_specks": seg.dropped_speck_count,
                "kept_specks": seg.kept_speck_count,
            },
            "components": [
                {
                    "comp_id": c.comp_id,
                    "kind": c.kind,
                    "parent_id": c.parent_id,
                    "child_ids": c.child_ids,
                    "bbox": list(c.bbox),
                    "centroid": _centroid_payload(seg, c.comp_id),
                    "contour": c.preview_contour(1.5),
                }
                for c in seg.components.values()
            ],
            "bg_components": list(seg.bg_components.values()),
        }
        return jsonify(payload)

    # ---------------- 测量 ---------------- #
    @app.post("/api/measure/<image_id>")
    def measure(image_id: str):
        rec = STATE.images.get(image_id)
        calib = STATE.calibrations.get(image_id)
        if not rec:
            return jsonify({"error": "图片不存在"}), 404
        if not calib:
            return jsonify({"error": "请先建立标尺标定"}), 400
        params = SegmentParams(**{**SegmentParams().to_dict(),
                                  **request.json.get("params", {})})
        seg = STATE.segmentations.get(image_id, {}).get(_params_key(params))
        if seg is None:
            seg = segment(rec["gray"], params)
            STATE.segmentations.setdefault(image_id, {})[_params_key(params)] = seg
        angles = tuple(request.json.get(
            "projection_angles", DEFAULT_PROJECTION_ANGLES))
        measurements = measure_all(seg, calib, angles)
        comp_id = request.json.get("comp_id")
        pending = STATE.pending.get(image_id, {})
        result = {}
        for cid, m in measurements.items():
            d = m.to_dict()
            d["status"] = pending.get(cid, {}).get("status", d["status"])
            d["note"] = pending.get(cid, {}).get("note", d["note"])
            result[str(cid)] = d
        out = {"measurements": result}
        if comp_id is not None and int(comp_id) in measurements:
            out["selected"] = result[str(int(comp_id))]
            out["selected_contour"] = seg.components[int(comp_id)].preview_contour(1.0)
        return jsonify(out)

    @app.post("/api/measure/<image_id>/status")
    def set_status(image_id: str):
        """把某个读数标记为待确认 / 已确认。"""
        body = request.json
        cid = int(body["comp_id"])
        STATE.pending.setdefault(image_id, {})[cid] = {
            "status": body.get("status", "pending"),
            "note": body.get("note", ""),
        }
        return jsonify({"ok": True, "pending": STATE.pending[image_id]})

    # ---------------- 快照与叠加比较 ---------------- #
    @app.post("/api/snapshot/<image_id>")
    def add_snapshot(image_id: str):
        rec = STATE.images.get(image_id)
        calib = STATE.calibrations.get(image_id)
        if not rec or not calib:
            return jsonify({"error": "需要先导入图片并标定"}), 400
        params = SegmentParams(**{**SegmentParams().to_dict(),
                                  **request.json.get("params", {})})
        label = request.json.get("label", "")
        seg = STATE.segmentations.get(image_id, {}).get(_params_key(params))
        if seg is None:
            seg = segment(rec["gray"], params)
            STATE.segmentations.setdefault(image_id, {})[_params_key(params)] = seg
        snap = {
            "id": uuid.uuid4().hex[:8],
            "label": label,
            "params": params.to_dict(),
            "calibration": calib.to_dict(),
            "segmentation": seg,
        }
        STATE.snapshots.setdefault(image_id, []).append(snap)
        return jsonify({"ok": True, "snapshot_id": snap["id"],
                        "count": len(STATE.snapshots[image_id])})

    @app.get("/api/snapshot/<image_id>/list")
    def list_snapshots(image_id: str):
        snaps = STATE.snapshots.get(image_id, [])
        return jsonify({"snapshots": [
            {"id": s["id"], "label": s["label"], "params": s["params"]}
            for s in snaps
        ]})

    @app.post("/api/snapshot/<image_id>/diff")
    def snapshot_diff(image_id: str):
        body = request.json
        snaps = STATE.snapshots.get(image_id, [])
        old = next((s for s in snaps if s["id"] == body["old_id"]), None)
        new = next((s for s in snaps if s["id"] == body["new_id"]), None)
        if not old or not new:
            return jsonify({"error": "快照不存在"}), 404
        diff = compare_segmentations(old["segmentation"], new["segmentation"])
        return jsonify(diff.to_dict())

    @app.delete("/api/snapshot/<image_id>/<snap_id>")
    def delete_snapshot(image_id: str, snap_id: str):
        snaps = STATE.snapshots.get(image_id, [])
        STATE.snapshots[image_id] = [s for s in snaps if s["id"] != snap_id]
        return jsonify({"ok": True})

    # ---------------- 导出 / 读回 ---------------- #
    @app.post("/api/export/<image_id>")
    def export_project(image_id: str):
        rec = STATE.images.get(image_id)
        calib = STATE.calibrations.get(image_id)
        if not rec or not calib:
            return jsonify({"error": "需要先导入图片并标定"}), 400
        params = SegmentParams(**{**SegmentParams().to_dict(),
                                  **request.json.get("params", {})})
        seg = STATE.segmentations.get(image_id, {}).get(_params_key(params))
        if seg is None:
            return jsonify({"error": "请先运行轮廓分析"}), 400
        measurements = measure_all(seg, calib)
        diff = request.json.get("diff")
        project = build_export(
            image_path=rec["path"], image_shape=rec["shape"],
            calibration=calib, segmentation=seg, measurements=measurements,
            pending=STATE.pending.get(image_id), diff=diff,
            source_name=rec.get("name", ""),
        )
        fname = f"project_{image_id}.json"
        fpath = save_project(project, OUTPUT_DIR / fname)

        annotated = draw_annotation(
            rec["gray"], calib, project, measurements,
            selected_id=request.json.get("selected_id"),
        )
        png_path = OUTPUT_DIR / f"annotated_{image_id}.png"
        cv2.imwrite(str(png_path), annotated)
        return jsonify({
            "project_path": str(fpath),
            "annotated_path": str(png_path),
            "project": project,
        })

    @app.post("/api/import")
    def import_project():
        f = request.files.get("project")
        if not f:
            return jsonify({"error": "缺少 project 文件"}), 400
        data = json.loads(f.read().decode("utf-8"))
        shape = tuple(data["source"]["image_shape"])
        problems = []
        image_id = request.form.get("image_id")
        rec = STATE.images.get(image_id) if image_id else None
        if rec:
            problems = validate_project_against_image(data, rec["shape"])
        calib = restore_calibration(data, rec["shape"] if rec else shape)
        if rec:
            STATE.calibrations[rec["id"]] = calib
            STATE.pending[rec["id"]] = {
                int(k): v for k, v in data.get("pending_readings", {}).items()
            }
        return jsonify({
            "ok": True,
            "problems": problems,
            "calibration": _calibration_payload(calib),
            "project": data,
            "image_id": rec["id"] if rec else None,
        })

    @app.post("/api/annotate/<image_id>")
    def annotate(image_id: str):
        rec = STATE.images.get(image_id)
        calib = STATE.calibrations.get(image_id)
        if not rec or not calib:
            return jsonify({"error": "需要先导入图片并标定"}), 400
        params = SegmentParams(**{**SegmentParams().to_dict(),
                                  **request.json.get("params", {})})
        seg = STATE.segmentations.get(image_id, {}).get(_params_key(params))
        if seg is None:
            return jsonify({"error": "请先运行轮廓分析"}), 400
        measurements = measure_all(seg, calib)
        project = build_export(
            image_path=rec["path"], image_shape=rec["shape"],
            calibration=calib, segmentation=seg, measurements=measurements,
            pending=STATE.pending.get(image_id),
        )
        annotated = draw_annotation(
            rec["gray"], calib, project, measurements,
            selected_id=request.json.get("selected_id"),
        )
        png_bytes, scale = encode_png(annotated, max_side=2000)
        return jsonify({
            "annotated_png": "data:image/png;base64,"
                             + base64.b64encode(png_bytes).decode("ascii"),
            "scale": scale,
        })

    return app


# ---------------------------------------------------------------------- #
# 辅助
# ---------------------------------------------------------------------- #
def _register_image(path: Path) -> tuple:
    gray = load_gray(str(path))
    image_id = uuid.uuid4().hex[:10]
    STATE.images[image_id] = {
        "id": image_id,
        "path": str(path),
        "name": path.name,
        "gray": gray,
        "shape": gray.shape[:2],
    }
    return jsonify({
        "image_id": image_id,
        "name": path.name,
        "shape": list(gray.shape[:2]),
    })


def _calibration_from_payload(payload: dict, shape: tuple[int, int]) -> Calibration:
    h = payload["horizontal"] if "horizontal" in payload else payload["h"]
    v = payload["vertical"] if "vertical" in payload else payload["v"]
    # 兼容 ground_truth 的 {a,b,length_mm} 与前端 {a,b,length_mm}
    return Calibration(
        horizontal=Ruler(tuple(h["a"]), tuple(h["b"]),
                         float(h["length_mm"]), h.get("name", "横尺")),
        vertical=Ruler(tuple(v["a"]), tuple(v["b"]),
                       float(v["length_mm"]), v.get("name", "纵尺")),
        image_shape=shape,
    )


def _calibration_payload(calib: Calibration) -> dict:
    d = calib.to_dict()
    d["horizontal"]["pixel_length"] = calib.horizontal.pixel_length()
    d["vertical"]["pixel_length"] = calib.vertical.pixel_length()
    return d


def _params_key(params: SegmentParams) -> str:
    return json.dumps(params.to_dict(), sort_keys=True)


def _centroid_payload(seg, comp_id: int) -> list[float]:
    comp = seg.components[comp_id]
    m = cv2.moments(comp.contour)
    if abs(m["m00"]) < 1e-9:
        x, y, w, h = comp.bbox
        return [x + w / 2, y + h / 2]
    return [m["m10"] / m["m00"], m["m01"] / m["m00"]]
