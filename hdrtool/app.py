"""Flask application exposing the HDR tool's local HTTP API."""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from flask import Flask, jsonify, request, send_file, send_from_directory

from . import engine
from .session import WORKSPACE_ROOT, registry

app = Flask(__name__, static_folder="static", static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 256 * 1024 * 1024  # 256 MB total upload


# ---------------------------------------------------------------------------
# Error handling — failures carry a Chinese reason and never kill the session
# ---------------------------------------------------------------------------


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400, detail: str | None = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.detail = detail


@app.errorhandler(ApiError)
def handle_api_error(err: ApiError):
    payload = {"error": err.message}
    if err.detail:
        payload["detail"] = err.detail
    return jsonify(payload), err.status


@app.errorhandler(KeyError)
def handle_key_error(err: KeyError):
    return jsonify({"error": str(err).strip("'")}), 404


@app.errorhandler(Exception)
def handle_unexpected(err: Exception):
    app.logger.exception("Unhandled error")
    return jsonify({"error": f"服务器内部错误: {err}"}), 500


def get_session(sid: str):
    try:
        return registry.get(sid)
    except KeyError:
        raise ApiError("会话不存在或已过期，请重新打开页面或导入工程文件", 404)


def get_group(sess, gid: str):
    try:
        return sess.get_group(gid)
    except KeyError as err:
        raise ApiError(str(err), 404)


def info_dict(inf):
    from dataclasses import asdict
    return asdict(inf)


def group_dict(sess, g):
    from dataclasses import asdict
    return {
        **asdict(g),
        "auto_ghost_used": sess.is_auto_ghost_used(g.group_id),
        "frames": [info_dict(inf) for inf in sess.ordered_infos(g)],
        "fused": g.fused_npy is not None and Path(g.fused_npy).exists(),
    }


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


# ---------------------------------------------------------------------------
# Session lifecycle
# ---------------------------------------------------------------------------


@app.post("/api/sessions")
def create_session():
    s = registry.create()
    return jsonify({"session_id": s.session_id})


# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------


@app.post("/api/sessions/<sid>/images")
def upload_images(sid: str):
    sess = get_session(sid)
    files = request.files.getlist("files")
    if not files:
        raise ApiError("未收到图片文件")
    results, failures = [], []
    for f in files:
        try:
            data = f.read()
            inf = sess.add_image(f.filename or "unnamed", data)
            results.append(info_dict(inf))
        except Exception as err:  # one bad file must not reject the rest
            failures.append({"filename": f.filename, "reason": str(err)})
    return jsonify({"uploaded": results, "failed": failures}), (
        207 if failures else 200)


@app.get("/api/sessions/<sid>/images")
def list_images(sid: str):
    sess = get_session(sid)
    return jsonify([info_dict(i) for i in sess.info.values()])


@app.get("/api/sessions/<sid>/image/<iid>")
def full_image(sid: str, iid: str):
    sess = get_session(sid)
    if iid not in sess.info:
        raise ApiError("图片不存在", 404)
    return send_file(sess.image_path(iid))


@app.get("/api/sessions/<sid>/thumb/<iid>")
def thumb_image(sid: str, iid: str):
    sess = get_session(sid)
    if iid not in sess.info:
        raise ApiError("图片不存在", 404)
    return send_file(sess.thumb_path(iid))


@app.delete("/api/sessions/<sid>/images/<iid>")
def delete_image(sid: str, iid: str):
    sess = get_session(sid)
    if iid not in sess.info:
        raise ApiError("图片不存在", 404)
    sess.remove_image(iid)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Groups
# ---------------------------------------------------------------------------


@app.post("/api/sessions/<sid>/groups")
def create_group(sid: str):
    sess = get_session(sid)
    body = request.get_json(force=True)
    ids = body.get("image_ids") or []
    if len(ids) < 2:
        raise ApiError("一个曝光分组至少需要两张照片")
    missing = [i for i in ids if i not in sess.info]
    if missing:
        raise ApiError(f"图片不存在: {', '.join(missing)}")
    g = sess.create_group(body.get("name") or "未命名分组", ids)
    return jsonify(group_dict(sess, g))


@app.get("/api/sessions/<sid>/groups")
def list_groups(sid: str):
    sess = get_session(sid)
    return jsonify([group_dict(sess, g) for g in sess.groups.values()])


@app.post("/api/sessions/<sid>/groups/<gid>/sort-ev")
def sort_by_ev(sid: str, gid: str):
    sess = get_session(sid)
    g = get_group(sess, gid)
    evs = sess.sort_group_by_ev(gid)
    return jsonify({"ordered_ev": evs, "group": group_dict(sess, g)})


@app.post("/api/sessions/<sid>/groups/<gid>/reorder")
def reorder(sid: str, gid: str):
    sess = get_session(sid)
    get_group(sess, gid)
    body = request.get_json(force=True)
    try:
        sess.move_frame(gid, int(body["from"]), int(body["to"]))
    except ValueError as err:
        raise ApiError(str(err))
    return jsonify(group_dict(sess, sess.get_group(gid)))


# ---------------------------------------------------------------------------
# Alignment & ghost handling
# ---------------------------------------------------------------------------


@app.post("/api/sessions/<sid>/groups/<gid>/align")
def align(sid: str, gid: str):
    sess = get_session(sid)
    get_group(sess, gid)
    try:
        result = sess.align_group(gid)
    except ValueError as err:
        raise ApiError(str(err))
    return jsonify({**result, "group": group_dict(sess, sess.get_group(gid))})


@app.get("/api/sessions/<sid>/groups/<gid>/aligned/<int:index>")
def aligned_preview(sid: str, gid: str, index: int):
    sess = get_session(sid)
    g = get_group(sess, gid)
    aligned = sess.get_aligned(gid)
    if not (0 <= index < len(aligned)):
        raise ApiError("帧序号超出范围", 404)
    p = sess.preview_dir / f"{gid}_aligned_{index}.jpg"
    if not p.exists():
        p.write_bytes(engine.image_to_jpeg_bytes(
            engine.downscale_for_preview(aligned[index]), 85))
    return send_file(p)


@app.post("/api/sessions/<sid>/groups/<gid>/detect-ghost")
def detect_ghost(sid: str, gid: str):
    sess = get_session(sid)
    get_group(sess, gid)
    return jsonify(sess.detect_ghosts(gid))


@app.get("/api/sessions/<sid>/ghost-preview/<gid>")
def ghost_preview(sid: str, gid: str):
    sess = get_session(sid)
    get_group(sess, gid)
    p = sess.preview_dir / f"{gid}_ghost.png"
    if not p.exists():
        raise ApiError("请先执行重影检测", 404)
    return send_file(p)


@app.post("/api/sessions/<sid>/groups/<gid>/auto-ghost")
def toggle_auto_ghost(sid: str, gid: str):
    sess = get_session(sid)
    get_group(sess, gid)
    body = request.get_json(force=True)
    sess.set_auto_ghost_used(gid, bool(body.get("used")))
    return jsonify({"ok": True})


@app.post("/api/sessions/<sid>/groups/<gid>/marks")
def add_mark(sid: str, gid: str):
    sess = get_session(sid)
    get_group(sess, gid)
    body = request.get_json(force=True)
    try:
        m = sess.add_mark(gid, body["points"], int(body["source_index"]),
                          body.get("label", ""))
    except (KeyError, ValueError) as err:
        raise ApiError(str(err))
    return jsonify({"mark": m.__dict__})


@app.put("/api/sessions/<sid>/groups/<gid>/marks/<mid>")
def update_mark(sid: str, gid: str, mid: str):
    sess = get_session(sid)
    get_group(sess, gid)
    body = request.get_json(force=True)
    try:
        sess.update_mark(gid, mid,
                         source_index=body.get("source_index"),
                         points=body.get("points"))
    except KeyError as err:
        raise ApiError(str(err), 404)
    except ValueError as err:
        raise ApiError(str(err))
    return jsonify({"ok": True})


@app.delete("/api/sessions/<sid>/groups/<gid>/marks/<mid>")
def delete_mark(sid: str, gid: str, mid: str):
    sess = get_session(sid)
    get_group(sess, gid)
    sess.delete_mark(gid, mid)
    return jsonify({"ok": True})


@app.get("/api/sessions/<sid>/groups/<gid>/marks-overlay")
def marks_overlay(sid: str, gid: str):
    """Render all manual marks + accepted auto mask on the middle frame."""
    sess = get_session(sid)
    g = get_group(sess, gid)
    aligned = sess.get_aligned(gid)
    base = aligned[len(aligned) // 2].copy()
    union = sess.load_ghost_union(gid) if sess.is_auto_ghost_used(gid) else None
    if union is not None:
        base = engine.overlay_mask(base, union, color=(0, 180, 255), alpha=0.25)
    colors = [(0, 0, 255), (255, 0, 0), (0, 200, 0), (255, 0, 255), (0, 200, 255)]
    for k, m in enumerate(g.marks):
        mask = engine.polygon_to_mask(m.points, base.shape[:2])
        base = engine.overlay_mask(base, mask, color=colors[k % len(colors)])
    p = sess.preview_dir / f"{gid}_marks_overlay.png"
    p.write_bytes(engine.image_to_png_bytes(engine.downscale_for_preview(base)))
    return send_file(p)


# ---------------------------------------------------------------------------
# Fusion / tonemap / export
# ---------------------------------------------------------------------------


@app.post("/api/sessions/<sid>/groups/<gid>/fuse")
def fuse(sid: str, gid: str):
    sess = get_session(sid)
    get_group(sess, gid)
    body = request.get_json(silent=True) or {}
    try:
        result = sess.fuse_group(gid, body.get("use_auto_ghost"))
    except ValueError as err:
        raise ApiError(str(err))
    return jsonify({**result, "group": group_dict(sess, sess.get_group(gid))})


@app.get("/api/sessions/<sid>/fused-preview/<gid>")
def fused_preview(sid: str, gid: str):
    sess = get_session(sid)
    get_group(sess, gid)
    p = sess.preview_dir / f"{gid}_fused_preview.png"
    if not p.exists():
        raise ApiError("请先执行合成", 404)
    return send_file(p)


_TONEMAP_KEYS = ("exposure", "shadows", "highlights", "saturation")


@app.post("/api/sessions/<sid>/groups/<gid>/tonemap")
def tonemap(sid: str, gid: str):
    sess = get_session(sid)
    get_group(sess, gid)
    body = request.get_json(force=True)
    params = {k: float(body.get(k, default)) for k, default in
              zip(_TONEMAP_KEYS, (0.0, 0.0, 0.0, 1.0))}
    try:
        data = sess.tonemap_preview(gid, params)
    except ValueError as err:
        raise ApiError(str(err), 409)
    from flask import Response
    resp = Response(data, mimetype="image/jpeg")
    resp.headers["X-Tonemap-Params"] = json.dumps(params)
    return resp


@app.post("/api/sessions/<sid>/groups/<gid>/export")
def export(sid: str, gid: str):
    sess = get_session(sid)
    get_group(sess, gid)
    body = request.get_json(force=True)
    params = {k: float(body.get(k, default)) for k, default in
              zip(_TONEMAP_KEYS, (0.0, 0.0, 0.0, 1.0))}
    out_dir = sess.dir / "exports" / uuid.uuid4().hex[:8]
    try:
        result = sess.export(gid, out_dir, params)
    except ValueError as err:
        raise ApiError(str(err), 409)
    base = "/api/sessions/" + sid + "/download"
    return jsonify({
        "png_url": f"{base}/{out_dir.name}/{Path(result['png']).name}",
        "tiff_url": f"{base}/{out_dir.name}/{Path(result['tiff16']).name}",
        "params_url": f"{base}/{out_dir.name}/{Path(result['params']).name}",
    })


@app.get("/api/sessions/<sid>/download/<export_id>/<name>")
def download(sid: str, export_id: str, name: str):
    sess = get_session(sid)
    folder = sess.dir / "exports" / export_id
    if not folder.exists() or "/" in name or ".." in name:
        raise ApiError("文件不存在", 404)
    return send_from_directory(folder, name, as_attachment=True)


# ---------------------------------------------------------------------------
# Project save / load
# ---------------------------------------------------------------------------


@app.get("/api/sessions/<sid>/project")
def download_project(sid: str):
    sess = get_session(sid)
    path = sess.save_project(sess.dir / "project.hdrproj.json")
    return send_file(path, as_attachment=True, download_name="hdr_project.hdrproj.json")


@app.post("/api/projects/load")
def load_project():
    f = request.files.get("project")
    if not f:
        raise ApiError("未收到工程文件")
    try:
        payload = json.loads(f.read().decode("utf-8"))
        sess = registry.load_project(payload)
    except (json.JSONDecodeError, ValueError, KeyError) as err:
        raise ApiError(f"工程文件解析失败: {err}")
    return jsonify({"session_id": sess.session_id,
                    "groups": [group_dict(sess, g) for g in sess.groups.values()]})


@app.get("/api/health")
def health():
    return jsonify({"ok": True, "workspace": str(WORKSPACE_ROOT)})


def main():
    import argparse
    parser = argparse.ArgumentParser(description="本地 HDR 合成工具")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()
    app.run(host=args.host, port=args.port, debug=args.debug)


if __name__ == "__main__":
    main()
