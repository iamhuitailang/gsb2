#!/usr/bin/env python3
"""灵动标题工坊 · 本地一体化服务器（仅标准库）

职责：
1. 像 `python3 -m http.server` 一样托管仓库静态文件；
2. 提供 POST /api/encode，把前端逐帧渲染好的 PNG 序列 ZIP
   交给本机 ffmpeg，合成真正带 alpha 通道的视频：
     - webm: libvpx-vp9 + yuva420p（网页透明背景）
     - mov : prores_ks 4444 + yuva444p10le（剪辑软件透明通道）
3. GET /api/health 报告 ffmpeg 是否可用。

用法：
    python3 tools/studio_server.py [端口，默认 8123]
然后浏览器打开 http://127.0.0.1:8123/
"""
import json
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent.parent

# 常见安装位置兜底（PATH 里没有时，例如从 .command 启动的极简环境）
FFMPEG_CANDIDATES = [
    shutil.which("ffmpeg"),
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
]
FFMPEG = next((p for p in FFMPEG_CANDIDATES if p and Path(p).exists()), None)


def ffmpeg_version():
    if not FFMPEG:
        return None
    try:
        out = subprocess.run([FFMPEG, "-version"], capture_output=True, text=True, timeout=5)
        return out.stdout.splitlines()[0] if out.stdout else "ffmpeg"
    except Exception:
        return "ffmpeg"


class StudioHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):  # 保持控制台整洁
        sys.stderr.write("[studio] %s\n" % (fmt % args))

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == "/api/health":
            self._json({"ok": True, "ffmpeg": FFMPEG, "version": ffmpeg_version()})
            return
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/encode":
            self._json({"error": "not found"}, 404)
            return
        if not FFMPEG:
            self._json({"error": "未找到 ffmpeg，请先安装（macOS: brew install ffmpeg）"}, 500)
            return

        qs = parse_qs(parsed.query)
        fps = self._safe_float(qs.get("fps", ["30"])[0], 30.0)
        fmt = qs.get("fmt", ["webm"])[0]
        if fmt not in ("webm", "mov"):
            self._json({"error": "fmt 仅支持 webm / mov"}, 400)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            zip_bytes = self.rfile.read(length)
            data = self._encode(zip_bytes, fps, fmt)
        except subprocess.CalledProcessError as e:
            msg = (e.stderr or b"").decode("utf-8", "ignore")[-2000:]
            self._json({"error": "ffmpeg 合成失败", "detail": msg}, 500)
            return
        except Exception as e:  # noqa: BLE001
            self._json({"error": f"编码服务异常: {e}"}, 500)
            return

        ctype = "video/webm" if fmt == "webm" else "video/quicktime"
        fname = f"output_alpha.{fmt}"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Disposition", f'attachment; filename="{fname}"')
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    @staticmethod
    def _safe_float(v, default):
        try:
            return max(1.0, min(120.0, float(v)))
        except Exception:
            return default

    @staticmethod
    def _encode(zip_bytes: bytes, fps: float, fmt: str) -> bytes:
        with tempfile.TemporaryDirectory(prefix="mgs_encode_") as td:
            tdp = Path(td)
            zip_path = tdp / "seq.zip"
            zip_path.write_bytes(zip_bytes)
            frames_dir = tdp / "frames"
            frames_dir.mkdir()

            with zipfile.ZipFile(zip_path) as z:
                # 只解压 frame_*.png，且防止路径穿越
                for info in z.infolist():
                    name = Path(info.filename).name
                    if not re.fullmatch(r"frame_\d+\.png", name):
                        continue
                    target = frames_dir / name
                    with z.open(info) as src, open(target, "wb") as dst:
                        dst.write(src.read())

            frames = sorted(frames_dir.glob("frame_*.png"))
            if not frames:
                raise RuntimeError("ZIP 中没有 frame_*.png")

            m = re.search(r"frame_(\d+)\.png$", frames[0].name)
            pad = len(m.group(1)) if m else 4
            pattern = str(frames_dir / f"frame_%0{pad}d.png")

            out = tdp / ("out." + ("webm" if fmt == "webm" else "mov"))
            if fmt == "webm":
                cmd = [
                    FFMPEG, "-y",
                    "-framerate", str(fps),
                    "-start_number", "1",
                    "-i", pattern,
                    "-c:v", "libvpx-vp9",
                    "-pix_fmt", "yuva420p",
                    "-b:v", "0", "-crf", "32",
                    "-auto-alt-ref", "0",   # 保留 alpha 的关键参数
                    str(out),
                ]
            else:
                cmd = [
                    FFMPEG, "-y",
                    "-framerate", str(fps),
                    "-start_number", "1",
                    "-i", pattern,
                    "-c:v", "prores_ks",
                    "-profile:v", "4444",
                    "-pix_fmt", "yuva444p10le",
                    str(out),
                ]
            proc = subprocess.run(cmd, capture_output=True)
            if proc.returncode != 0:
                raise subprocess.CalledProcessError(proc.returncode, cmd, stderr=proc.stderr)
            return out.read_bytes()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    server = ThreadingHTTPServer(("127.0.0.1", port), StudioHandler)
    print("================================================")
    print("  灵动标题工坊 Motion Title Studio")
    print(f"  打开: http://127.0.0.1:{port}/")
    print(f"  根目录: {ROOT}")
    print(f"  ffmpeg: {FFMPEG or '未找到（透明视频一键合成不可用，PNG 序列不受影响）'}")
    print("  按 Ctrl+C 停止")
    print("================================================")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
