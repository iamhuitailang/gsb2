"""本地视频亮度范围检查与转换页 —— HTTP 服务（仅标准库）。

启动：python3 -m app.server  （或 python3 app/server.py）
默认 http://127.0.0.1:8765 ，所有数据都留在本地工作区 workspace/ 内。
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 允许以 `python3 -I app/server.py` 直接启动（隔离模式下无包上下文）
if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import ffmpeg_core as ff
else:
    from . import ffmpeg_core as ff

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")
WORKSPACE = os.path.join(os.path.dirname(ROOT), "workspace")
SRC_DIR = os.path.join(WORKSPACE, "sources")
OUT_DIR = os.path.join(WORKSPACE, "outputs")
SAMPLE_DIR = os.path.join(WORKSPACE, "samples")
HISTORY_FILE = os.path.join(WORKSPACE, "history.json")

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._\-一-鿿]+")
_lock = threading.Lock()


def _safe_filename(name: str) -> str:
    name = os.path.basename(name).replace("\\", "_")
    cleaned = _SAFE_NAME.sub("_", name).strip("._") or "video"
    return cleaned[:120]


def _load_history() -> dict:
    if os.path.exists(HISTORY_FILE):
        try:
            with open(HISTORY_FILE, encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {"files": {}}


def _save_history(data: dict) -> None:
    os.makedirs(WORKSPACE, exist_ok=True)
    tmp = HISTORY_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, HISTORY_FILE)


def _file_record(file_id: str) -> dict | None:
    return _load_history()["files"].get(file_id)


def _ext_for(container: str, codec: str) -> str:
    if container in ("matroska", "webm"):
        return ".mkv"
    if container in ("avi",):
        return ".avi"
    return ".mp4"


class Handler(BaseHTTPRequestHandler):
    server_version = "RangeChecker/1.0"

    # ---------------- 基础工具 ---------------- #
    def _json(self, obj: int, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, msg: str, status: int = 400, detail: str = "") -> None:
        self._json({"error": msg, "detail": detail}, status)

    def _read_body(self) -> bytes:
        n = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(n) if n else b""

    def log_message(self, fmt, *args):  # 静默默认访问日志
        pass

    # ---------------- 路由 ---------------- #
    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        try:
            if path == "/api/health":
                return self._json({"ok": True})
            if path == "/api/history":
                return self._json(_load_history())
            if path == "/api/probe":
                return self._handle_probe()
            if path == "/api/frame":
                return self._handle_frame()
            if path == "/api/stats":
                return self._handle_stats()
            if path == "/api/media":
                return self._handle_media()
            if path in ("/", "/index.html"):
                return self._serve_static("index.html")
            return self._serve_static(path.lstrip("/"))
        except ff.FFmpegError as e:
            return self._error(str(e), 500, e.stderr)
        except FileNotFoundError as e:
            return self._error(f"文件不存在：{e.filename}", 404)
        except Exception as e:  # noqa: BLE001
            return self._error(f"服务器内部错误：{e}", 500)

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        try:
            if path == "/api/upload":
                return self._handle_upload()
            if path == "/api/convert":
                return self._handle_convert()
            if path == "/api/generate-samples":
                return self._handle_generate()
            if path == "/api/recheck":
                return self._handle_recheck()
            return self._error("未知接口", 404)
        except ff.FFmpegError as e:
            return self._error(str(e), 500, e.stderr)
        except Exception as e:  # noqa: BLE001
            return self._error(f"服务器内部错误：{e}", 500)

    # ---------------- 静态文件 ---------------- #
    def _serve_static(self, rel: str) -> None:
        rel = rel.replace("\\", "/").lstrip("/")
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(STATIC_DIR + os.sep) or not os.path.isfile(full):
            return self._error("资源不存在", 404)
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---------------- 媒体流（video 标签与下载共用） ---------------- #
    def _handle_media(self) -> None:
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(self.path).query)
        rec = _file_record(qs.get("id", [""])[0])
        if not rec:
            return self._error("未知文件 id", 404)
        full = rec["abs_path"]
        if not os.path.isfile(full):
            return self._error("文件已被移动或删除", 404)
        size = os.path.getsize(full)
        ctype = mimetypes.guess_type(full)[0] or "video/mp4"
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        status = 200
        if rng:
            m = re.match(r"bytes=(\d+)-(\d*)", rng)
            if m:
                start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
                status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with open(full, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(1 << 20, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    # ---------------- 上传 ---------------- #
    def _handle_upload(self) -> None:
        name = _safe_filename(self.headers.get("X-Filename", "video.mp4"))
        data = self._read_body()
        if not data:
            return self._error("上传内容为空")
        os.makedirs(SRC_DIR, exist_ok=True)
        file_id = uuid.uuid4().hex[:12]
        stored = f"{file_id}_{name}"
        abs_path = os.path.join(SRC_DIR, stored)
        with open(abs_path, "wb") as f:
            f.write(data)
        info = ff.probe(abs_path)
        if not info.get("video"):
            os.remove(abs_path)
            return self._error("该文件没有视频流，无法检查亮度范围")
        info["nb_frames"] = ff.count_frames(abs_path)
        with _lock:
            hist = _load_history()
            hist["files"][file_id] = {
                "id": file_id,
                "abs_path": abs_path,
                "original_name": name,
                "role": "source",
                "conversions": [],
                "probe": info,
            }
            _save_history(hist)
        self._json({"id": file_id, "probe": info})

    # ---------------- 探测 ---------------- #
    def _handle_probe(self) -> None:
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(self.path).query)
        rec = _file_record(qs.get("id", [""])[0])
        if not rec:
            return self._error("未知文件 id", 404)
        info = ff.probe(rec["abs_path"])
        info["nb_frames"] = rec["probe"].get("nb_frames") or ff.count_frames(rec["abs_path"])
        with _lock:
            hist = _load_history()
            hist["files"][rec["id"]]["probe"] = {**hist["files"][rec["id"]]["probe"], **info}
            _save_history(hist)
        self._json({"probe": info, "record": _public_record(hist["files"][rec["id"]])})

    # ---------------- 抽帧 + 统计 ---------------- #
    def _handle_frame(self) -> None:
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(self.path).query)
        rec = _file_record(qs.get("id", [""])[0])
        if not rec:
            return self._error("未知文件 id", 404)
        try:
            frame_no = max(0, int(qs.get("n", ["0"])[0]))
        except ValueError:
            return self._error("帧号必须是整数")
        yuv, w, h = ff.extract_frame(rec["abs_path"], frame_no)
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("X-Frame-Width", str(w))
        self.send_header("X-Frame-Height", str(h))
        self.send_header("X-Frame-No", str(frame_no))
        self.send_header("Content-Length", str(len(yuv)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(yuv)

    def _handle_stats(self) -> None:
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(self.path).query)
        rec = _file_record(qs.get("id", [""])[0])
        if not rec:
            return self._error("未知文件 id", 404)
        try:
            frame_no = max(0, int(qs.get("n", ["0"])[0]))
        except ValueError:
            return self._error("帧号必须是整数")
        yuv, w, h = ff.extract_frame(rec["abs_path"], frame_no)
        stats = ff.frame_stats(yuv, w, h)
        stats["frame_no"] = frame_no
        stats["declared_range"] = rec["probe"]["video"]["color_range"]
        self._json(stats)

    # ---------------- 转换 ---------------- #
    def _handle_convert(self) -> None:
        payload = json.loads(self._read_body() or b"{}")
        file_id = payload.get("id")
        mode = payload.get("mode")            # retag | pixels
        target = payload.get("target_range")  # tv | pc
        source_range = payload.get("source_range", "")  # pixels 模式必填
        confirmed = bool(payload.get("confirmed", False))
        if mode not in ("retag", "pixels") or target not in ("tv", "pc"):
            return self._error("参数 mode/target_range 不合法")
        rec = _file_record(file_id)
        if not rec:
            return self._error("未知文件 id", 404)

        # 重复转换提示：该文件已经按目标范围输出过（含另一种模式的历史）
        prior = [c for c in rec["conversions"] if c.get("target_range") == target]
        if prior and not confirmed:
            same_mode = [c for c in prior if c["mode"] == mode]
            if same_mode:
                msg = (
                    f"该素材此前已用相同方式（{_mode_label(mode)}）按目标范围 "
                    f"{ff.RANGE_LABEL[target]} 输出过 {len(same_mode)} 次。"
                    "像素模式重复转换会产生二次裁剪与量化误差，标记模式重复改写也可能掩盖真实问题。"
                    "请确认是否继续。"
                )
            else:
                msg = (
                    f"该素材此前已按目标范围 {ff.RANGE_LABEL[target]} 输出过，"
                    f"但用的是另一种方式（{_mode_label(prior[0]['mode'])}）。"
                    "两种方式对画面的影响不同：仅改标记不动像素，像素转换会重映射电平并重新编码。"
                    "请确认本次仍要继续。"
                )
            return self._json({
                "need_confirm": True,
                "reason": "already_converted",
                "message": msg,
                "prior": [{"output": c["output_name"], "mode": c["mode"],
                           "declared_after": c["declared_after"]} for c in prior],
            }, 200)

        info = rec["probe"]
        ext = _ext_for(info["container"], info["video"]["codec"])
        stamp = uuid.uuid4().hex[:6]
        out_name = (os.path.splitext(rec["original_name"])[0]
                    + f".{mode}_{target}_{stamp}{ext}")
        out_name = _safe_filename(out_name)
        out_abs = os.path.join(OUT_DIR, out_name)
        os.makedirs(OUT_DIR, exist_ok=True)

        declared_before = info["video"]["color_range"]
        if mode == "retag":
            result = ff.convert_retag(rec["abs_path"], target, out_abs)
        else:
            if source_range not in ("tv", "pc"):
                return self._error("像素转换必须明确选择源范围（limited 或 full）")
            result = ff.convert_pixels(rec["abs_path"], source_range, target, out_abs)

        after_probe = ff.probe(out_abs)
        # 回读实际电平变化，而不是只回显设置
        yuv_before, w, h = ff.extract_frame(rec["abs_path"], 0)
        yuv_after, _, _ = ff.extract_frame(out_abs, 0)
        s_before = ff.frame_stats(yuv_before, w, h)
        s_after = ff.frame_stats(yuv_after, w, h)

        new_id = uuid.uuid4().hex[:12]
        conv = {
            "conversion_id": new_id,
            "mode": mode,
            "target_range": target,
            "source_range_used": source_range or declared_before,
            "declared_before": declared_before,
            "declared_after": result.declared_after,
            "output_name": out_name,
            "lossless": result.lossless,
            "warning": result.warning,
            "ffmpeg_cmd": result.ffmpeg_cmd,
            "level_change_frame0": {
                "y_min_before": s_before["y_min"], "y_min_after": s_after["y_min"],
                "y_max_before": s_before["y_max"], "y_max_after": s_after["y_max"],
                "y_mean_before": s_before["y_mean"], "y_mean_after": s_after["y_mean"],
                "below_16_pct_before": s_before["below_16_pct"],
                "below_16_pct_after": s_after["below_16_pct"],
                "above_235_pct_before": s_before["above_235_pct"],
                "above_235_pct_after": s_after["above_235_pct"],
            },
        }
        with _lock:
            hist = _load_history()
            parent = hist["files"][file_id]
            parent["conversions"].append(conv)
            hist["files"][new_id] = {
                "id": new_id,
                "abs_path": out_abs,
                "original_name": out_name,
                "role": "output",
                "parent_id": file_id,
                "conversions": [],
                "probe": after_probe,
            }
            _save_history(hist)
        self._json({"ok": True, "output_id": new_id, "conversion": conv,
                    "probe_after": after_probe})

    # ---------------- 导出后回读复核 ---------------- #
    def _handle_recheck(self) -> None:
        payload = json.loads(self._read_body() or b"{}")
        rec = _file_record(payload.get("id", ""))
        if not rec:
            return self._error("未知文件 id", 404)
        info = ff.probe(rec["abs_path"])
        try:
            frame_no = max(0, int(payload.get("frame_no", 0)))
        except (TypeError, ValueError):
            frame_no = 0
        yuv, w, h = ff.extract_frame(rec["abs_path"], frame_no)
        stats = ff.frame_stats(yuv, w, h)
        stats["frame_no"] = frame_no
        self._json({
            "filename": rec["original_name"],
            "probe": info,
            "stats": stats,
            "conversions": rec.get("conversions", []),
        })

    # ---------------- 生成样例 ---------------- #
    def _handle_generate(self) -> None:
        os.makedirs(SAMPLE_DIR, exist_ok=True)
        results = ff.generate_samples(SAMPLE_DIR)
        with _lock:
            hist = _load_history()
            # 按文件名幂等：重复生成复用同一条历史记录，不产生重复条目
            existing_by_name = {
                f["original_name"]: f for f in hist["files"].values()
                if f.get("role") == "sample"
            }
            for r in results:
                info = ff.probe(r["path"])
                info["nb_frames"] = ff.count_frames(r["path"])
                old = existing_by_name.get(r["filename"])
                fid = old["id"] if old else uuid.uuid4().hex[:12]
                hist["files"][fid] = {
                    "id": fid,
                    "abs_path": r["path"],
                    "original_name": r["filename"],
                    "role": "sample",
                    "intent": r["intent"],
                    "conversions": old.get("conversions", []) if old else [],
                    "probe": info,
                }
                r["id"] = fid
            _save_history(hist)
        self._json({"samples": results})


def _mode_label(mode: str) -> str:
    return "仅改标记" if mode == "retag" else "像素转换"


def _public_record(rec: dict) -> dict:
    return {k: v for k, v in rec.items() if k != "abs_path"}


def main() -> None:
    ff.ensure_tools()
    for d in (SRC_DIR, OUT_DIR, SAMPLE_DIR):
        os.makedirs(d, exist_ok=True)
    port = int(os.environ.get("PORT", "8765"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"亮度范围检查页已启动： http://127.0.0.1:{port}")
    print("工作区（源文件与导出都在这里，源文件永不被修改）：", WORKSPACE)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
