"""本地 Web 服务：页面管理、检测、手工编辑、导出与自检。

只监听 127.0.0.1，所有数据留在本地项目目录。
"""

from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np
from flask import Flask, jsonify, request, send_file, send_from_directory

from .detection import ABSENT, PRESENT
from .exporter import export_cells
from .geometry import (RotationInfo, original_to_rectified,
                       rectified_to_original)
from .grid import GridModel
from .pipeline import (STATUS_PENDING, STATUS_READY, ProjectStore,
                       process_image)
from .synth import default_spec, generate
from .verify import verify

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


def create_app(project_root: str | Path) -> Flask:
    app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
    store = ProjectStore(project_root)

    # 内存缓存：name -> (model, rotation, deskewed)
    cache: dict[str, tuple[GridModel, RotationInfo, np.ndarray]] = {}

    def load_page(name: str):
        if name in cache:
            return cache[name]
        data = store.load_page(name)
        if data is None:
            raise KeyError(name)
        model = GridModel.from_dict(data["grid"])
        rot = RotationInfo.from_dict(data["rotation"])
        dpath = store.deskewed / Path(name).name
        deskewed = cv2.imdecode(np.fromfile(str(dpath), np.uint8),
                                cv2.IMREAD_COLOR)
        cache[name] = (model, rot, deskewed)
        return cache[name]

    def persist(name: str, model: GridModel, rot: RotationInfo,
                extra: dict | None = None) -> None:
        pages = store.list_pages()
        previous = store.load_page(name) or {}
        page_data = {
            "name": name,
            "rotation": rot.to_dict(),
            "grid": model.to_dict(),
        }
        # 保留既有的额外字段（如合成图真值路径），新传入的字段覆盖同名项
        for k, v in previous.items():
            if k not in ("rotation", "grid"):
                page_data[k] = v
        if extra:
            page_data.update(extra)
        store.save_page(name, page_data)
        for p in pages:
            if p["name"] == name:
                p["status"] = STATUS_READY
                p.pop("error", None)
                break
        store.save_index(pages)

    # ------------------------------------------------------------ 页面
    @app.get("/")
    def index():
        return send_from_directory(STATIC_DIR, "index.html")

    @app.get("/api/pages")
    def list_pages():
        return jsonify({"pages": store.list_pages()})

    @app.post("/api/generate")
    def api_generate():
        """生成一张合成缺陷表样。"""
        body = request.get_json(force=True, silent=True) or {}
        spec = default_spec()
        spec.seed = int(body.get("seed", spec.seed))
        spec.rotation_deg = float(body.get("rotation_deg", spec.rotation_deg))
        if body.get("no_stamp"):
            spec.stamp = False
        name = f"synth_seed{spec.seed}.png"
        out = store.originals / name
        generate(spec, out)
        truth = out.with_name(out.stem + ".truth.json")
        return _ingest(out, truth=truth)

    @app.post("/api/upload")
    def api_upload():
        f = request.files.get("image")
        if f is None:
            return jsonify({"ok": False, "error": "缺少 image 文件"}), 400
        safe = Path(f.filename or "upload.png").name
        out = store.originals / safe
        f.save(out)
        return _ingest(out)

    def _ingest(path: Path, truth: Path | None = None):
        result = process_image(path)
        pages = store.list_pages()
        pages = [p for p in pages if p["name"] != result.name]
        if result.status == STATUS_READY:
            assert result.model is not None and result.rotation is not None
            # 重新读取原图并生成拉正图缓存
            image = cv2.imdecode(np.fromfile(str(path), np.uint8),
                                 cv2.IMREAD_COLOR)
            from .geometry import deskew
            deskewed, _ = deskew(image)
            store.save_deskewed(result.name, deskewed)
            cache[result.name] = (result.model, result.rotation, deskewed)
            extra = {"truth": str(truth)} if truth and truth.exists() else None
            persist(result.name, result.model, result.rotation, extra)
            pages.append({"name": result.name, "status": STATUS_READY})
        else:
            # 待处理：单独记录，不影响其他图
            store.save_page(result.name, {"name": result.name,
                                          "status": STATUS_PENDING,
                                          "error": result.error})
            pages.append({"name": result.name, "status": STATUS_PENDING,
                          "error": result.error})
        store.save_index(pages)
        return jsonify({"ok": True, "name": result.name,
                        "status": result.status, "error": result.error})

    @app.get("/api/page/<name>")
    def api_page(name):
        try:
            model, rot, _ = load_page(name)
        except KeyError:
            return jsonify({"ok": False, "error": "页面不存在"}), 404
        data = store.load_page(name) or {}
        return jsonify({
            "ok": True,
            "name": name,
            "rotation": rot.to_dict(),
            "grid": model.to_dict(),
            "truth": data.get("truth"),
        })

    @app.get("/api/image/<name>/<kind>")
    def api_image(name, kind):
        """kind=original|deskewed。"""
        if kind == "original":
            p = store.originals / Path(name).name
        elif kind == "deskewed":
            p = store.deskewed / Path(name).name
        else:
            return jsonify({"ok": False, "error": "kind 非法"}), 400
        if not p.exists():
            return jsonify({"ok": False, "error": "图片不存在"}), 404
        return send_file(str(p))

    @app.post("/api/page/<name>/edge")
    def api_edge(name):
        """增删/修改边段：切换 present/absent，或删除覆写。"""
        body = request.get_json(force=True)
        model, rot, _ = load_page(name)
        orient = body["orientation"]
        a, b = int(body["a"]), int(body["b"])
        action = body.get("action", "toggle")
        if action == "reset":
            model.set_edge_override(orient, a, b, None)
        else:
            cur = model.edge_state(orient, a, b)
            target = ABSENT if cur != ABSENT else PRESENT
            model.set_edge_override(orient, a, b, target)
        persist(name, model, rot)
        return jsonify({"ok": True, "grid": model.to_dict()})

    @app.post("/api/page/<name>/line/add")
    def api_line_add(name):
        body = request.get_json(force=True)
        model, rot, _ = load_page(name)
        if body["orientation"] == "v":
            idx = model.add_vline(float(body["pos"]))
        else:
            idx = model.add_hline(float(body["pos"]))
        persist(name, model, rot)
        return jsonify({"ok": True, "idx": idx, "grid": model.to_dict()})

    @app.post("/api/page/<name>/line/remove")
    def api_line_remove(name):
        body = request.get_json(force=True)
        model, rot, _ = load_page(name)
        try:
            if body["orientation"] == "v":
                model.remove_vline(int(body["idx"]))
            else:
                model.remove_hline(int(body["idx"]))
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        persist(name, model, rot)
        return jsonify({"ok": True, "grid": model.to_dict()})

    @app.post("/api/page/<name>/merge")
    def api_merge(name):
        """手工确认/取消一个矩形合并范围。"""
        body = request.get_json(force=True)
        model, rot, _ = load_page(name)
        r0, r1, c0, c1 = (int(body[k]) for k in ("r0", "r1", "c0", "c1"))
        if body.get("unmerge"):
            model.unmerge_at(r0, c0)
        else:
            model.confirm_merge(r0, r1, c0, c1)
        persist(name, model, rot)
        return jsonify({"ok": True, "grid": model.to_dict()})

    @app.post("/api/page/<name>/map-point")
    def api_map_point(name):
        """原图 <-> 拉正图坐标联动（单点）。"""
        body = request.get_json(force=True)
        _, rot, _ = load_page(name)
        pts = np.array([[float(body["x"]), float(body["y"])]])
        if body["direction"] == "r2o":
            out = rectified_to_original(pts, rot)
        else:
            out = original_to_rectified(pts, rot)
        return jsonify({"x": float(out[0, 0]), "y": float(out[0, 1])})

    @app.post("/api/page/<name>/map-points")
    def api_map_points(name):
        """批量坐标映射，避免前端逐角点请求造成的往返风暴。"""
        body = request.get_json(force=True)
        _, rot, _ = load_page(name)
        pts = np.array([[float(p[0]), float(p[1])] for p in body["points"]],
                       dtype=np.float64)
        if pts.size == 0:
            return jsonify({"points": []})
        if body["direction"] == "r2o":
            out = rectified_to_original(pts, rot)
        else:
            out = original_to_rectified(pts, rot)
        return jsonify({"points": [[float(x), float(y)] for x, y in out]})

    @app.post("/api/page/<name>/export")
    def api_export(name):
        model, rot, deskewed = load_page(name)
        out_dir = store.root / "exports" / Path(name).stem
        res = export_cells(deskewed, model, out_dir, name)
        # 同步空白标记到页面快照
        persist(name, model, rot)
        pages = store.list_pages()
        for p in pages:
            if p["name"] == name:
                p["last_export"] = str(out_dir)
        store.save_index(pages)
        return jsonify({"ok": True, "n_cells": res.n_cells,
                        "n_blank": res.n_blank,
                        "manifest": str(res.manifest_path)})

    @app.get("/api/page/<name>/verify")
    def api_verify(name):
        data = store.load_page(name) or {}
        truth = data.get("truth")
        if not truth or not Path(truth).exists():
            return jsonify({"ok": False,
                            "error": "该图没有真值文件（仅合成图可自检）"}), 400
        model, rot, _ = load_page(name)
        report = verify(model, rot, truth)
        return jsonify(report)

    @app.get("/api/export/<stem>/manifest")
    def api_manifest(stem):
        p = store.root / "exports" / stem / "manifest.json"
        if not p.exists():
            return jsonify({"ok": False, "error": "尚未导出"}), 404
        return jsonify(json.loads(p.read_text(encoding="utf-8")))

    @app.get("/api/export/<stem>/cell/<path:fname>")
    def api_cell_image(stem, fname):
        base = store.root / "exports" / stem / "images"
        # 防目录穿越
        target = (base / fname).resolve()
        if not str(target).startswith(str(base.resolve())):
            return jsonify({"ok": False, "error": "非法路径"}), 400
        if not target.exists():
            return jsonify({"ok": False, "error": "格图不存在"}), 404
        return send_file(str(target))

    @app.post("/api/batch-export")
    def api_batch_export():
        """批量导出：待处理图跳过，其他图照常保存。"""
        results = []
        for p in store.list_pages():
            name = p["name"]
            if p["status"] == STATUS_PENDING:
                results.append({"name": name, "skipped": True,
                                "reason": p.get("error", "待处理")})
                continue
            try:
                model, rot, deskewed = load_page(name)
                out_dir = store.root / "exports" / Path(name).stem
                res = export_cells(deskewed, model, out_dir, name)
                results.append({"name": name, "ok": True,
                                "n_cells": res.n_cells, "n_blank": res.n_blank})
            except Exception as exc:  # noqa: BLE001
                results.append({"name": name, "ok": False, "error": str(exc)})
        return jsonify({"results": results})

    return app
