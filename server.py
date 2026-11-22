#!/usr/bin/env python3
"""字幕版面预览与成片导出工具 —— 本地后端（仅标准库）。

用法: python3 server.py [端口]   然后浏览器打开 http://127.0.0.1:8765
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
SAMPLES = os.path.join(ROOT, "samples")
FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"

EXPORT = {"state": "idle", "log": "", "out": "", "dir": None, "events": []}
EXPORT_LOCK = threading.Lock()


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def probe(path):
    r = run([FFPROBE, "-v", "error", "-print_format", "json",
             "-show_format", "-show_streams", path])
    if r.returncode != 0:
        return None, r.stderr.strip()[-400:]
    info = json.loads(r.stdout)
    v = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
    a = next((s for s in info.get("streams", []) if s.get("codec_type") == "audio"), None)
    if not v:
        return None, "未找到视频流"
    out = {
        "width": v.get("width"), "height": v.get("height"),
        "duration": float(info.get("format", {}).get("duration", 0)),
        "hasAudio": bool(a),
        "audioChannels": a.get("channels") if a else 0,
        "audioLayout": a.get("channel_layout", "") if a else "",
    }
    return out, None


def make_samples():
    """生成亮/暗/混合画面的样例短片与含长句、短句、交叠的样例字幕。"""
    os.makedirs(SAMPLES, exist_ok=True)
    video = os.path.join(SAMPLES, "sample.mp4")
    srt = os.path.join(SAMPLES, "sample.srt")
    if not os.path.exists(video):
        font = "/System/Library/Fonts/PingFang.ttc"
        dt = ("drawtext=fontfile=%s:text='%%{pts\\:hms}':fontcolor=red:"
              "fontsize=36:x=40:y=40:" % font) if os.path.exists(font) else None
        segs = [
            # 亮场：浅底 + 深色块
            "color=c=0xF2F2F2:s=1280x720:r=30:d=10,"
            "drawbox=x=120:y=120:w=260:h=200:c=0x2A2A2A:t=fill,"
            "drawbox=x='820+200*sin(2*PI*t/5)':y=420:w=220:h=160:c=0x555555:t=fill",
            # 暗场：深底 + 浅色块
            "color=c=0x0E0E14:s=1280x720:r=30:d=10,"
            "drawbox=x=140:y=140:w=260:h=200:c=0xE8E8E8:t=fill,"
            "drawbox=x='760+220*sin(2*PI*t/4)':y=400:w=240:h=170:c=0xBBBBBB:t=fill",
            # 混合：测试图（含运动与亮暗区域）
            "testsrc2=s=1280x720:r=30:d=10",
        ]
        if dt:
            segs = [s + "," + dt for s in segs]
        cmd = [FFMPEG, "-y"]
        for s in segs:
            cmd += ["-f", "lavfi", "-i", s]
        cmd += ["-f", "lavfi", "-i", "sine=frequency=440:duration=30",
                "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
                "-map", "[v]", "-map", "3:a",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
                "-c:a", "aac", "-shortest", video]
        r = run(cmd)
        if r.returncode != 0 and dt:  # drawtext 不可用时退回无时间码
            return make_samples_no_dt(cmd, video)
        if r.returncode != 0:
            raise RuntimeError("样例视频生成失败: " + r.stderr[-500:])
    if not os.path.exists(srt):
        with open(srt, "w", encoding="utf-8") as f:
            f.write(SAMPLE_SRT)
    return video, srt


def make_samples_no_dt(cmd, video):
    cmd = [c.replace("drawtext", "nulltext") for c in cmd]
    r = run(cmd)
    if r.returncode != 0:
        raise RuntimeError("样例视频生成失败: " + r.stderr[-500:])
    return None


SAMPLE_SRT = """1
00:00:01,000 --> 00:00:03,500
亮场短句：画面很亮。

2
00:00:04,000 --> 00:00:08,800
这是一段故意写得非常长的字幕，用来检验长句在安全区内自动换行的效果；如果排版失败，它就会冲出画面边缘，甚至完全看不清楚。

3
00:00:09,200 --> 00:00:11,000
暗场短句：画面很暗。

4
00:00:11,500 --> 00:00:15,500
暗场里再来一句同样很长的字幕，白字黑边在黑底上应该依然清晰；同时观察描边和背景半透明底板在暗部的表现是否足够把字托住。

5
00:00:16,000 --> 00:00:20,000
第一条字幕：我先出现，位置靠下。

6
00:00:17,000 --> 00:00:19,500
第二条字幕：我们同时出现，我应该叠在它上方，并且两块底板要能分得清。

7
00:00:20,500 --> 00:00:24,000
标点测试：逗号，句号。问号？感叹号！冒号：引号“内文”书名号《篇名》、顿号、省略号……都不应该出现在行首。

8
00:00:24,500 --> 00:00:27,000
贴底测试：这一句用来检查竖版底部内容提示区是否会遮住字幕。

9
00:00:27,500 --> 00:00:29,500
样例结束。
"""


def build_export(video, out, ow, oh, crop_x, workdir, pieces, duration):
    """pieces: [{png, start, end}]，把每条字幕 PNG 按时间窗叠到输出画幅上。
    -t 锁定输出时长：looped 图片输入是无限流，不截断会永远编下去。"""
    cmd = [FFMPEG, "-y", "-i", video]
    for p in pieces:
        cmd += ["-loop", "1", "-framerate", "30", "-i", p["png"]]
    ar = ow / oh
    lines = []
    last = "base"
    # 裁切（竖版按 crop_x 取源画面中间一条）再缩放到输出画幅
    lines.append(
        "[0:v]crop=w='floor(min(iw,ih*%f)/2)*2':h=ih:"
        "x='(iw-ow)*%f':y=0,scale=%d:%d,setsar=1[base]"
        % (ar, crop_x, ow, oh))
    for i, p in enumerate(pieces):
        cur = "v%d" % i
        lines.append(
            "[%s][%d:v]overlay=0:0:enable='between(t,%.3f,%.3f)'[%s]"
            % (last, i + 1, p["start"], p["end"], cur))
        last = cur
    fc = ";\n".join(lines)
    fc_path = os.path.join(workdir, "filter.txt")
    with open(fc_path, "w") as f:
        f.write(fc)
    cmd += ["-filter_complex_script", fc_path,
            "-map", "[%s]" % last, "-map", "0:a?",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
            "-preset", "medium", "-c:a", "copy",
            "-t", "%.3f" % duration,
            "-movflags", "+faststart", out]
    return cmd


def export_thread(video, out, ow, oh, crop_x):
    global EXPORT
    try:
        workdir = EXPORT["dir"]
        pieces = EXPORT["events"]
        info, err = probe(video)
        if err:
            raise RuntimeError("无法读取源视频: " + err)
        cmd = build_export(video, out, ow, oh, crop_x, workdir, pieces,
                           info["duration"])
        with EXPORT_LOCK:
            EXPORT["log"] = "运行 ffmpeg …\n"
        proc = subprocess.Popen(cmd, stderr=subprocess.STDOUT,
                                stdout=subprocess.PIPE, text=True)
        tail = []
        for line in proc.stdout:
            tail.append(line.rstrip())
            tail = tail[-8:]
            with EXPORT_LOCK:
                EXPORT["log"] = "\n".join(tail)
        proc.wait()
        with EXPORT_LOCK:
            if proc.returncode == 0 and os.path.exists(out):
                EXPORT["state"] = "done"
                EXPORT["log"] += "\n完成: " + out
            else:
                EXPORT["state"] = "error"
                EXPORT["log"] += "\nffmpeg 退出码 %s" % proc.returncode
    except Exception as e:  # noqa: BLE001
        with EXPORT_LOCK:
            EXPORT["state"] = "error"
            EXPORT["log"] += "\n异常: %s" % e


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    # ---------- 工具 ----------
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _query(self):
        return urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

    def _route(self):
        return urllib.parse.urlparse(self.path).path

    # ---------- GET ----------
    def do_GET(self):
        r = self._route()
        try:
            if r == "/":
                return self._static("index.html")
            if r.startswith("/static/"):
                return self._static(r[len("/static/"):])
            if r == "/api/probe":
                return self._api_probe()
            if r == "/api/media":
                return self._api_media()
            if r == "/api/file":
                return self._api_file()
            if r == "/api/sample":
                return self._api_sample()
            if r == "/api/frame":
                return self._api_frame()
            if r == "/api/export/status":
                with EXPORT_LOCK:
                    return self._json({k: EXPORT[k] for k in
                                       ("state", "log", "out")})
            self._json({"error": "not found"}, 404)
        except Exception as e:  # noqa: BLE001
            self._json({"error": str(e)}, 500)

    def _static(self, name):
        name = os.path.normpath(name).lstrip("/")
        path = os.path.join(STATIC, name)
        if not path.startswith(STATIC) or not os.path.isfile(path):
            return self._json({"error": "not found"}, 404)
        mime = {".html": "text/html", ".js": "text/javascript",
                ".css": "text/css"}.get(os.path.splitext(path)[1],
                                        "application/octet-stream")
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", mime + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _api_probe(self):
        path = self._query().get("path", [""])[0]
        if not os.path.isfile(path):
            return self._json({"error": "文件不存在: " + path}, 400)
        info, err = probe(path)
        if err:
            return self._json({"error": err}, 400)
        return self._json(info)

    def _api_media(self):
        """带 Range 支持的视频流，供 <video> 拖动seek。"""
        path = self._query().get("path", [""])[0]
        if not os.path.isfile(path):
            return self._json({"error": "文件不存在"}, 404)
        size = os.path.getsize(path)
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        code = 200
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
                code = 206
        length = end - start + 1
        self.send_response(code)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if code == 206:
            self.send_header("Content-Range",
                             "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(1 << 20, left))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
                left -= len(chunk)

    def _api_file(self):
        path = self._query().get("path", [""])[0]
        if not os.path.isfile(path):
            return self._json({"error": "文件不存在: " + path}, 400)
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _api_sample(self):
        video, srt = make_samples()
        return self._json({"video": video, "srt": srt})

    def _api_frame(self):
        q = self._query()
        path, t = q.get("path", [""])[0], q.get("t", ["0"])[0]
        if not os.path.isfile(path):
            return self._json({"error": "文件不存在"}, 400)
        r = subprocess.run(
            [FFMPEG, "-v", "error", "-i", path, "-ss", t,
             "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
            capture_output=True)
        if r.returncode != 0 or not r.stdout:
            return self._json({"error": "取帧失败"}, 500)
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(r.stdout)))
        self.end_headers()
        self.wfile.write(r.stdout)

    # ---------- POST ----------
    def do_POST(self):
        r = self._route()
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            data = json.loads(body) if body else {}
            if r == "/api/export/reset":
                EXPORT.update({"state": "idle", "log": "", "out": "",
                               "events": []})
                if EXPORT.get("dir") and os.path.isdir(EXPORT["dir"]):
                    import shutil
                    shutil.rmtree(EXPORT["dir"], ignore_errors=True)
                EXPORT["dir"] = tempfile.mkdtemp(prefix="subexp_")
                return self._json({"ok": True})
            if r == "/api/export/upload":
                # 分块上传字幕 PNG: {events:[{start,end,png(dataURL)}]}
                if not EXPORT.get("dir"):
                    EXPORT["dir"] = tempfile.mkdtemp(prefix="subexp_")
                n = len(EXPORT["events"])
                for i, ev in enumerate(data["events"]):
                    png = ev["png"]
                    if png.startswith("data:"):
                        png = png.split(",", 1)[1]
                    fp = os.path.join(EXPORT["dir"], "p%04d.png" % (n + i))
                    import base64
                    with open(fp, "wb") as f:
                        f.write(base64.b64decode(png))
                    EXPORT["events"].append({"png": fp,
                                             "start": float(ev["start"]),
                                             "end": float(ev["end"])})
                return self._json({"ok": True, "count": len(EXPORT["events"])})
            if r == "/api/export/run":
                if EXPORT["state"] == "running":
                    return self._json({"error": "导出进行中"}, 400)
                EXPORT["state"] = "running"
                EXPORT["out"] = data["out"]
                os.makedirs(os.path.dirname(os.path.abspath(data["out"]))
                            or ".", exist_ok=True)
                threading.Thread(
                    target=export_thread,
                    args=(data["video"], data["out"], int(data["outW"]),
                          int(data["outH"]), float(data.get("cropX", 0.5))),
                    daemon=True).start()
                return self._json({"ok": True})
            self._json({"error": "not found"}, 404)
        except Exception as e:  # noqa: BLE001
            with EXPORT_LOCK:
                EXPORT["state"] = "error"
            self._json({"error": str(e)}, 500)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    EXPORT["dir"] = tempfile.mkdtemp(prefix="subexp_")
    print("字幕版面预览与导出工具: http://127.0.0.1:%d" % port)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
