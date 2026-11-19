"""本地 HTTP 服务: 静态页面 + 拼接 API。

仅监听 127.0.0.1, 所有计算与素材均在本机完成。
Python 3.13 移除了 cgi 模块, multipart/form-data 在此手写解析。
"""
from __future__ import annotations

import base64
import json
import re
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import cv2
import numpy as np

from .render import render_panorama
from .stitch import FeatureStore, estimate_chain

ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "static"
SAMPLES_DIR = ROOT / "samples" / "demo"
PREVIEW_MAX_DIM = 1400                    # 预览图最长边

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
}


class Session:
    """单用户会话状态。"""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.images: dict[str, np.ndarray] = {}
        self.meta: dict[str, dict] = {}
        self.order: list[str] = []
        self.pairs: list = []
        self.offsets: dict[str, list[float]] = {}
        self.gains: dict[str, float] = {}
        self.feather_px = 60.0
        self.auto_exposure = True
        self.store = FeatureStore()

    def reset(self) -> None:
        self.images.clear()
        self.meta.clear()
        self.order.clear()
        self.pairs.clear()
        self.offsets.clear()
        self.gains.clear()
        self.store = FeatureStore()


SESSION = Session()


# ---------------------------------------------------------------- multipart

def parse_multipart(body: bytes, content_type: str) -> list[dict]:
    """极简 multipart/form-data 解析, 返回 [{name, filename, data}]。"""
    match = re.search(r"boundary=([^;]+)", content_type)
    if not match:
        raise ValueError("缺少 boundary")
    boundary = match.group(1).strip().strip('"')
    delimiter = b"--" + boundary.encode()
    parts: list[dict] = []
    for chunk in body.split(delimiter):
        if not chunk or chunk in (b"--", b"--\r\n", b"\r\n"):
            continue
        if chunk.startswith(b"\r\n"):
            chunk = chunk[2:]
        header_end = chunk.find(b"\r\n\r\n")
        if header_end < 0:
            continue
        header = chunk[:header_end].decode("utf-8", "replace")
        data = chunk[header_end + 4:]
        if data.endswith(b"\r\n"):
            data = data[:-2]
        name_match = re.search(r'name="([^"]+)"', header)
        file_match = re.search(r'filename="([^"]*)"', header)
        parts.append({
            "name": name_match.group(1) if name_match else "",
            "filename": file_match.group(1) if file_match else None,
            "data": data,
        })
    return parts


def decode_image(data: bytes) -> np.ndarray:
    arr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("无法解码图片(请使用 PNG/JPEG 格式)")
    return img


# ------------------------------------------------------------------ 渲染

def _preview_scale(order: list[str]) -> float:
    if not order:
        return 1.0
    longest = max(SESSION.images[i].shape[1] for i in order)
    return min(1.0, PREVIEW_MAX_DIM / float(longest))


def do_render() -> dict:
    s = SESSION
    if not s.order:
        return {"coverage": [], "groups": [], "gains": {}, "preview": None}
    offsets = {i: tuple(s.offsets.get(i, (0.0, 0.0))) for i in s.order}
    result = render_panorama(
        order=s.order, images=s.images, pairs=s.pairs,
        offsets=offsets, feather_px=float(s.feather_px),
        auto_exposure=bool(s.auto_exposure),
        manual_gains=s.gains, scale=_preview_scale(s.order),
    )
    ok, buf = cv2.imencode(".jpg", result.bgr, [cv2.IMWRITE_JPEG_QUALITY, 82])
    if not ok:
        raise RuntimeError("预览图编码失败")
    return {
        "preview": "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode(),
        "coverage": result.coverage,
        "groups": result.groups,
        "gains": result.gains,
        "group_of": result.group_of,
    }


def public_state(extra: dict | None = None) -> dict:
    s = SESSION
    state = {
        "detector": s.store.detector_name,
        "order": s.order,
        "images": {
            i: {
                "id": i,
                "name": s.meta[i].get("name", i),
                "width": int(s.images[i].shape[1]),
                "height": int(s.images[i].shape[0]),
                "offset": s.offsets.get(i, [0.0, 0.0]),
                "gain": s.gains.get(i),
            }
            for i in s.order
        },
        "pairs": [
            {
                "index": p.index,
                "ok": p.ok,
                "reason": p.reason,
                "inliers": p.inliers,
                "total_matches": p.total_matches,
                "a": s.order[p.index] if p.index < len(s.order) else None,
                "b": s.order[p.index + 1] if p.index + 1 < len(s.order) else None,
            }
            for p in s.pairs
        ],
        "feather_px": s.feather_px,
        "auto_exposure": s.auto_exposure,
    }
    if extra:
        state.update(extra)
    return state


# ------------------------------------------------------------------ handler

class Handler(BaseHTTPRequestHandler):
    server_version = "LocalPanorama/1.0"

    def log_message(self, fmt: str, *args) -> None:  # 安静一点
        pass

    # --- 基础工具 ---
    def _json(self, payload: dict, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, message: str, status: int = HTTPStatus.BAD_REQUEST) -> None:
        self._json({"error": message}, status)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length else b""

    def _json_body(self) -> dict:
        return json.loads(self._read_body().decode("utf-8"))

    def _serve_file(self, path: Path) -> None:
        if not path.is_file():
            self._error("not found", HTTPStatus.NOT_FOUND)
            return
        body = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header(
            "Content-Type",
            CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream"),
        )
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # --- 路由 ---
    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)
        try:
            if path in ("/", "/index.html"):
                self._serve_file(STATIC_DIR / "index.html")
            elif path.startswith("/static/"):
                target = (STATIC_DIR / path[len("/static/"):]).resolve()
                if STATIC_DIR.resolve() not in target.parents and target != STATIC_DIR.resolve():
                    self._error("forbidden", HTTPStatus.FORBIDDEN)
                    return
                self._serve_file(target)
            elif path == "/api/state":
                with SESSION.lock:
                    self._json(public_state())
            elif path == "/api/image":
                self._serve_image(query)
            elif path == "/api/export":
                self._export(query)
            elif path == "/api/project":
                self._download_project()
            elif path == "/api/samples":
                self._list_samples()
            else:
                self._error("not found", HTTPStatus.NOT_FOUND)
        except Exception as exc:  # 兜底, 保证前端拿到 JSON 错误
            self._error(f"服务器错误: {exc}", HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            with SESSION.lock:
                if path == "/api/upload":
                    self._upload()
                elif path == "/api/reorder":
                    self._reorder()
                elif path == "/api/remove":
                    self._remove()
                elif path == "/api/align":
                    self._align()
                elif path == "/api/render":
                    self._render()
                elif path == "/api/update-image":
                    self._update_image()
                elif path == "/api/reset":
                    SESSION.reset()
                    self._json(public_state())
                elif path == "/api/project/open":
                    self._open_project()
                elif path == "/api/load-samples":
                    self._load_samples()
                elif path == "/api/samples":
                    self._list_samples()
                else:
                    self._error("not found", HTTPStatus.NOT_FOUND)
        except ValueError as exc:
            self._error(str(exc))
        except Exception as exc:
            self._error(f"服务器错误: {exc}", HTTPStatus.INTERNAL_SERVER_ERROR)

    # --- API 实现 ---
    def _upload(self) -> None:
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ctype:
            raise ValueError("上传需要 multipart/form-data")
        added = []
        for part in parse_multipart(self._read_body(), ctype):
            if part["filename"] is None or not part["data"]:
                continue
            img = decode_image(part["data"])
            image_id = uuid.uuid4().hex[:12]
            SESSION.images[image_id] = img
            SESSION.meta[image_id] = {"name": Path(part["filename"]).name}
            SESSION.order.append(image_id)
            added.append(image_id)
        if not added:
            raise ValueError("没有收到有效图片")
        self._json(public_state({"render": do_render()}))

    def _reorder(self) -> None:
        order = self._json_body().get("order", [])
        if sorted(order) != sorted(SESSION.order):
            raise ValueError("排序结果与当前图片集合不一致")
        SESSION.order = list(order)
        # 顺序变化后旧的相邻匹配失效
        SESSION.pairs = []
        self._json(public_state({"render": do_render()}))

    def _remove(self) -> None:
        image_id = self._json_body().get("id", "")
        if image_id not in SESSION.images:
            raise ValueError("图片不存在")
        del SESSION.images[image_id]
        SESSION.meta.pop(image_id, None)
        SESSION.offsets.pop(image_id, None)
        SESSION.gains.pop(image_id, None)
        SESSION.store.drop(image_id)
        SESSION.order = [i for i in SESSION.order if i != image_id]
        SESSION.pairs = []
        self._json(public_state({"render": do_render()}))

    def _align(self) -> None:
        if len(SESSION.order) < 2:
            raise ValueError("至少需要两张图片才能估计对齐关系")
        SESSION.pairs = estimate_chain(
            SESSION.order, SESSION.images, SESSION.store
        )
        # 重新对齐时清掉手动偏移, 但保留手动增益
        SESSION.offsets = {i: [0.0, 0.0] for i in SESSION.order}
        failed = [
            {
                "index": p.index,
                "a": SESSION.meta[SESSION.order[p.index]]["name"],
                "b": SESSION.meta[SESSION.order[p.index + 1]]["name"],
                "reason": p.reason,
            }
            for p in SESSION.pairs if not p.ok
        ]
        self._json(public_state({
            "render": do_render(),
            "failed_pairs": failed,
        }))

    def _render(self) -> None:
        payload = self._json_body()
        if "feather_px" in payload:
            SESSION.feather_px = float(np.clip(payload["feather_px"], 0.0, 1000.0))
        if "auto_exposure" in payload:
            SESSION.auto_exposure = bool(payload["auto_exposure"])
        self._json(public_state({"render": do_render()}))

    def _update_image(self) -> None:
        payload = self._json_body()
        image_id = payload.get("id", "")
        if image_id not in SESSION.images:
            raise ValueError("图片不存在")
        if "offset_x" in payload or "offset_y" in payload:
            cur = SESSION.offsets.get(image_id, [0.0, 0.0])
            SESSION.offsets[image_id] = [
                float(np.clip(payload.get("offset_x", cur[0]), -5000, 5000)),
                float(np.clip(payload.get("offset_y", cur[1]), -5000, 5000)),
            ]
        if "gain" in payload:
            if payload["gain"] is None:
                SESSION.gains.pop(image_id, None)
            else:
                SESSION.gains[image_id] = float(payload["gain"])
        self._json(public_state({"render": do_render()}))

    def _serve_image(self, query: dict) -> None:
        image_id = (query.get("id") or [""])[0]
        if image_id not in SESSION.images:
            self._error("图片不存在", HTTPStatus.NOT_FOUND)
            return
        img = SESSION.images[image_id]
        if query.get("thumb"):
            h, w = img.shape[:2]
            tw = 180
            th = max(1, int(round(h * tw / w)))
            out = cv2.resize(img, (tw, th), interpolation=cv2.INTER_AREA)
        else:
            out = img
        ok, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 85])
        data = buf.tobytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _export(self, query: dict) -> None:
        if not SESSION.order:
            raise ValueError("没有可导出的图片")
        fmt = (query.get("format") or ["png"])[0].lower()
        if fmt not in ("png", "jpeg", "jpg"):
            raise ValueError("格式仅支持 png/jpeg")
        offsets = {i: tuple(SESSION.offsets.get(i, (0.0, 0.0))) for i in SESSION.order}
        result = render_panorama(
            order=SESSION.order, images=SESSION.images, pairs=SESSION.pairs,
            offsets=offsets, feather_px=float(SESSION.feather_px),
            auto_exposure=bool(SESSION.auto_exposure),
            manual_gains=SESSION.gains, scale=1.0,
        )
        ext = "jpg" if fmt in ("jpeg", "jpg") else "png"
        if ext == "jpg":
            ok, buf = cv2.imencode(".jpg", result.bgr, [cv2.IMWRITE_JPEG_QUALITY, 92])
        else:
            ok, buf = cv2.imencode(".png", result.bgr)
        if not ok:
            raise RuntimeError("导出编码失败")
        data = buf.tobytes()
        fname = f"panorama_{time.strftime('%Y%m%d_%H%M%S')}.{ext}"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"image/{'jpeg' if ext == 'jpg' else 'png'}")
        self.send_header("Content-Length", str(len(data)))
        self.send_header(
            "Content-Disposition", f'attachment; filename="{fname}"'
        )
        self.end_headers()
        self.wfile.write(data)

    def _project_payload(self) -> dict:
        s = SESSION
        data_images = {}
        for image_id in s.order:
            ok, buf = cv2.imencode(
                ".jpg", s.images[image_id], [cv2.IMWRITE_JPEG_QUALITY, 90]
            )
            data_images[image_id] = (
                "data:image/jpeg;base64,"
                + base64.b64encode(buf.tobytes()).decode()
            )
        return {
            "format": "local-panorama-project",
            "version": 1,
            "saved_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "order": s.order,
            "feather_px": s.feather_px,
            "auto_exposure": s.auto_exposure,
            "offsets": s.offsets,
            "gains": s.gains,
            "pairs": [
                {
                    "index": p.index, "ok": p.ok, "reason": p.reason,
                    "inliers": p.inliers, "total_matches": p.total_matches,
                }
                for p in s.pairs
            ],
            "images": {
                image_id: {
                    "data": data_images[image_id],
                    "name": s.meta[image_id].get("name", image_id),
                }
                for image_id in s.order
            },
        }

    def _download_project(self) -> None:
        if not SESSION.order:
            raise ValueError("当前没有图片, 无法保存项目")
        body = json.dumps(
            self._project_payload(), ensure_ascii=False
        ).encode("utf-8")
        fname = f"panorama_project_{time.strftime('%Y%m%d_%H%M%S')}.json"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header(
            "Content-Disposition", f'attachment; filename="{fname}"'
        )
        self.end_headers()
        self.wfile.write(body)

    def _open_project(self) -> None:
        ctype = self.headers.get("Content-Type", "")
        if "application/json" in ctype:
            payload = json.loads(self._read_body().decode("utf-8"))
        else:
            parts = parse_multipart(self._read_body(), ctype)
            if not parts:
                raise ValueError("缺少项目文件")
            payload = json.loads(parts[0]["data"].decode("utf-8"))

        if payload.get("format") != "local-panorama-project":
            raise ValueError("不是本工具的项目文件")
        images_in = payload.get("images", {})
        order = payload.get("order", [])
        if not order or any(i not in images_in for i in order):
            raise ValueError("项目文件缺少图片数据")

        SESSION.reset()
        for image_id in order:
            entry = images_in[image_id]
            data_url = entry.get("data", "")
            header, _, b64 = data_url.partition(",")
            if not b64:
                raise ValueError(f"图片 {image_id} 数据损坏")
            img = decode_image(base64.b64decode(b64))
            SESSION.images[image_id] = img
            SESSION.meta[image_id] = {"name": entry.get("name", image_id)}
            SESSION.order.append(image_id)

        SESSION.feather_px = float(payload.get("feather_px", 60.0))
        SESSION.auto_exposure = bool(payload.get("auto_exposure", True))
        SESSION.offsets = {
            i: [float(v) for v in payload.get("offsets", {}).get(i, [0.0, 0.0])]
            for i in SESSION.order
        }
        SESSION.gains = {
            i: float(g) for i, g in payload.get("gains", {}).items()
            if i in SESSION.images
        }
        # 重新计算匹配对象(描述子缓存不进项目文件), 保留成功/失败标记
        from .stitch import PairResult
        restored = []
        for p in payload.get("pairs", []):
            restored.append(PairResult(
                index=int(p["index"]), ok=bool(p["ok"]),
                reason=p.get("reason", ""), inliers=int(p.get("inliers", 0)),
                total_matches=int(p.get("total_matches", 0)),
                homography=None,
            ))
        # 恢复的项目需要重新跑一次匹配拿到矩阵, 失败对仍会失败但不影响加载
        fresh = estimate_chain(SESSION.order, SESSION.images, SESSION.store)
        by_index = {p.index: p for p in fresh}
        SESSION.pairs = [
            by_index.get(p.index, p) if p.ok else p for p in restored
        ]
        self._json(public_state({"render": do_render()}))

    def _list_samples(self) -> None:
        if not SAMPLES_DIR.is_dir():
            self._json({"samples": []})
            return
        files = sorted(
            p.name for p in SAMPLES_DIR.iterdir()
            if p.suffix.lower() in (".jpg", ".jpeg", ".png")
            and not p.name.startswith("00_")   # 00_ 前缀为参考全景, 不是输入照片
        )
        self._json({"samples": files, "dir": str(SAMPLES_DIR)})

    def _load_samples(self) -> None:
        if not SAMPLES_DIR.is_dir():
            raise ValueError(
                "samples/demo 目录不存在, 请先运行 python3 -m scripts.generate_samples"
            )
        files = sorted(
            p for p in SAMPLES_DIR.iterdir()
            if p.suffix.lower() in (".jpg", ".jpeg", ".png")
            and not p.name.startswith("00_")
        )
        if not files:
            raise ValueError("samples/demo 中没有图片")
        SESSION.reset()
        for path in files:
            img = decode_image(path.read_bytes())
            image_id = uuid.uuid4().hex[:12]
            SESSION.images[image_id] = img
            SESSION.meta[image_id] = {"name": path.name}
            SESSION.order.append(image_id)
        self._json(public_state({"render": do_render()}))


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="本地全景拼接工具")
    parser.add_argument("--port", type=int, default=8765, help="监听端口(默认 8765)")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址(默认本机回环)")
    args = parser.parse_args()

    server = None
    port = args.port
    for candidate in range(args.port, args.port + 20):
        try:
            server = ThreadingHTTPServer((args.host, candidate), Handler)
            port = candidate
            break
        except OSError:
            continue
    if server is None:
        raise SystemExit(f"端口 {args.port}..{args.port + 19} 均被占用, 请用 --port 指定其它端口")
    print(f"全景拼接工具已启动: http://{args.host}:{port}")
    if port != args.port:
        print(f"(默认端口 {args.port} 被占用, 自动改用 {port})")
    print("按 Ctrl+C 停止")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
