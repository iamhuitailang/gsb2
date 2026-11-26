"""本地 HTTP 服务: 静态前端 + JSON API。

安全边界:
- 只绑定 127.0.0.1, 不对外暴露;
- 所有文件访问经过 _resolve_allowed: 仅允许工作目录、上传目录、
  用户显式加入的目录(上传时带的真实路径所在目录)及输出目录;
- 导出接口拒绝写回源文件, 命名冲突自动加序号 (见 audioio)。
"""

from __future__ import annotations

import base64
import io
import json
import os
import sys
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

import numpy as np

# 允许 `python3 -I noisekit/server.py` 直接运行
if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from noisekit.audioio import SUPPORTED_READ_EXTS, file_sha256
    from noisekit.dsp import average_spectrum_db, choose_n_fft, waveform_peaks
    from noisekit.engine import Engine
    from noisekit.project import load_project, save_project
    from noisekit.samples import SAMPLES_DIR
else:
    from .audioio import SUPPORTED_READ_EXTS, file_sha256
    from .dsp import average_spectrum_db, choose_n_fft, waveform_peaks
    from .engine import Engine
    from .project import load_project, save_project
    from .samples import SAMPLES_DIR

WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")
UPLOAD_DIR = os.path.join(os.path.dirname(WEB_DIR), "tmp", "uploads")
DEFAULT_OUT_DIR = os.path.join(os.path.dirname(WEB_DIR), "tmp", "exports")

_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".wav": "audio/wav",
}


class AppState:
    def __init__(self) -> None:
        self.engine = Engine()
        self.allowed_dirs: set[str] = set()
        self.upload_dir = UPLOAD_DIR
        self.out_dir = DEFAULT_OUT_DIR
        self.tmp_dir = os.path.dirname(UPLOAD_DIR)
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        os.makedirs(DEFAULT_OUT_DIR, exist_ok=True)
        # 允许: web 资源、样音、整个 tmp (上传/导出/工程) 三个本地工作区
        for d in (self.tmp_dir, SAMPLES_DIR, WEB_DIR):
            self.allowed_dirs.add(os.path.abspath(d))

    def allow(self, path: str) -> None:
        self.allowed_dirs.add(os.path.abspath(os.path.dirname(path)))


STATE = AppState()


def _resolve_allowed(path: str) -> str:
    ap = os.path.abspath(path)
    if any(ap == d or ap.startswith(d + os.sep) for d in STATE.allowed_dirs):
        return ap
    raise PermissionError(f"路径不在允许访问的目录内: {ap}")


def _wav_bytes(data: np.ndarray, sr: int) -> bytes:
    """float (-1~1) 数组编码为 16-bit PCM WAV 字节。"""
    pcm = np.clip(data, -1.0, 1.0)
    if pcm.ndim == 1:
        pcm = pcm[:, np.newaxis]
    pcm16 = (pcm * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(pcm16.shape[1])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm16.tobytes())
    return buf.getvalue()


def _peaks_payload(peaks: dict[str, np.ndarray]) -> dict:
    return {
        "min": peaks["min"].tolist(),
        "max": peaks["max"].tolist(),
        "channels": int(peaks["min"].shape[0]),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "NoiseKit/1.0"

    # ------------------------------------------------------------------ #
    def log_message(self, fmt: str, *args) -> None:  # 安静一点
        pass

    def _send_json(self, obj, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, status: int, message: str) -> None:
        self._send_json({"error": message}, status)

    def _read_json(self) -> dict:
        n = int(self.headers.get("Content-Length", 0))
        if n <= 0:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8"))

    def _send_file(self, path: str) -> None:
        ctype = _CONTENT_TYPES.get(os.path.splitext(path)[1].lower(), "application/octet-stream")
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if ctype.startswith("audio"):
            self.send_header("Accept-Ranges", "none")
        self.end_headers()
        self.wfile.write(body)

    # ------------------------------------------------------------------ #
    def do_GET(self) -> None:  # noqa: N802
        try:
            parsed = urlparse(self.path)
            route = parsed.path
            if route in ("/", "/index.html"):
                return self._send_file(os.path.join(WEB_DIR, "index.html"))
            if route.startswith("/static/"):
                rel = route[len("/static/") :]
                return self._send_file(_resolve_allowed(os.path.join(WEB_DIR, rel)))
            if route == "/api/samples":
                return self._handle_samples()
            if route == "/api/audio":
                q = self._query(parsed.query)
                return self._handle_audio(q)
            if route == "/api/download":
                q = self._query(parsed.query)
                return self._handle_download(q)
            self._send_error_json(404, "未知路由")
        except PermissionError as exc:
            self._send_error_json(403, str(exc))
        except FileNotFoundError as exc:
            self._send_error_json(404, f"文件不存在: {exc.filename}")
        except Exception as exc:  # 单个请求失败不拖垮服务
            self._send_error_json(500, f"{type(exc).__name__}: {exc}")

    def do_POST(self) -> None:  # noqa: N802
        try:
            route = urlparse(self.path).path
            payload = self._read_json()
            if route == "/api/load":
                return self._handle_load(payload)
            if route == "/api/listdir":
                return self._handle_listdir(payload)
            if route == "/api/analyze":
                return self._handle_analyze(payload)
            if route == "/api/process":
                return self._handle_process(payload)
            if route == "/api/spectrum":
                return self._handle_spectrum(payload)
            if route == "/api/batch":
                return self._handle_batch(payload)
            if route == "/api/project/save":
                return self._handle_project_save(payload)
            if route == "/api/project/load":
                return self._handle_project_load(payload)
            if route == "/api/upload":
                return self._handle_upload(payload)
            self._send_error_json(404, "未知路由")
        except PermissionError as exc:
            self._send_error_json(403, str(exc))
        except (ValueError, KeyError) as exc:
            self._send_error_json(400, f"{type(exc).__name__}: {exc}")
        except FileNotFoundError as exc:
            self._send_error_json(404, f"文件不存在: {exc.filename}")
        except Exception as exc:
            self._send_error_json(500, f"{type(exc).__name__}: {exc}")

    @staticmethod
    def _query(qs: str) -> dict[str, str]:
        out = {}
        for pair in qs.split("&"):
            if "=" in pair:
                k, v = pair.split("=", 1)
                out[unquote(k)] = unquote(v)
        return out

    # ------------------------------------------------------------------ #
    # API 处理
    # ------------------------------------------------------------------ #
    def _handle_samples(self) -> None:
        manifest = os.path.join(SAMPLES_DIR, "manifest.json")
        if not os.path.exists(manifest):
            return self._send_json({"samples": [], "hint": "样音尚未生成, 请运行 python -m noisekit.cli generate-samples"})
        with open(manifest, encoding="utf-8") as f:
            items = json.load(f)
        for item in items:
            item["path"] = os.path.join(SAMPLES_DIR, item["file"])
        self._send_json({"samples": items, "dir": SAMPLES_DIR})

    def _handle_listdir(self, payload: dict) -> None:
        directory = _resolve_allowed(payload["dir"])
        if not os.path.isdir(directory):
            raise FileNotFoundError(directory)
        items = []
        for name in sorted(os.listdir(directory)):
            full = os.path.join(directory, name)
            if os.path.isfile(full) and os.path.splitext(name)[1].lower() in SUPPORTED_READ_EXTS:
                items.append({"name": name, "path": full})
        self._send_json({"dir": directory, "items": items})

    def _handle_load(self, payload: dict) -> None:
        path = _resolve_allowed(payload["path"])
        af = STATE.engine.load(path)
        STATE.allow(path)
        peaks = _peaks_payload(waveform_peaks(af.data, buckets=1400))
        self._send_json({"file": af.to_dict(), "peaks": peaks})

    def _handle_audio(self, q: dict) -> None:
        path = _resolve_allowed(q["path"])
        self._send_file(path)

    def _handle_analyze(self, payload: dict) -> None:
        path = _resolve_allowed(payload["path"])
        result = STATE.engine.analyze(path, float(payload["start"]), float(payload["end"]))
        result["profile"] = result["profile"]  # 列表, 可 JSON 序列化
        self._send_json(result)

    def _process_common(self, payload: dict) -> tuple[str, np.ndarray, dict]:
        path = _resolve_allowed(payload["path"])
        noise = payload["noise"]
        params = payload["params"]
        y = STATE.engine.process(path, noise, params)
        return path, y, params

    def _handle_process(self, payload: dict) -> None:
        path, y, params = self._process_common(payload)
        af = STATE.engine.get(path)
        diff = af.data - y
        self._send_json(
            {
                "sr": af.sr,
                "duration": af.duration,
                "wav_b64": _wav_bytes(y, af.sr).hex(),
                "peaks": _peaks_payload(waveform_peaks(y, buckets=1400)),
                "diff_peaks": _peaks_payload(waveform_peaks(diff, buckets=1400)),
                "diff_rms_db": round(20 * np.log10(np.sqrt(np.mean(diff**2)) + 1e-12), 2),
                "metrics": STATE.engine.metrics(path, y),
            }
        )

    def _handle_spectrum(self, payload: dict) -> None:
        path = _resolve_allowed(payload["path"])
        af = STATE.engine.load(path)
        n_fft = payload.get("n_fft") or choose_n_fft(af.sr)
        start, end = float(payload["start"]), float(payload["end"])
        f1, before = average_spectrum_db(af.data, af.sr, start, end, n_fft)
        if payload.get("noise") and payload.get("params"):
            y = STATE.engine.process(path, payload["noise"], payload["params"])
            _, after = average_spectrum_db(y, af.sr, start, end, n_fft)
        else:
            after = None
        self._send_json(
            {
                "freqs": f1.tolist(),
                "before": before.tolist(),
                "after": None if after is None else after.tolist(),
                "n_fft": n_fft,
            }
        )

    def _handle_batch(self, payload: dict) -> None:
        out_dir = os.path.abspath(payload.get("out_dir") or STATE.out_dir)
        # 输出目录也必须在白名单内, 不借导出之名向任意路径写文件
        if not any(out_dir == d or out_dir.startswith(d + os.sep) for d in STATE.allowed_dirs):
            raise PermissionError(
                f"输出目录不在允许的工作区内: {out_dir}（请使用 tmp/ 下的目录或已载入文件所在目录）"
            )
        os.makedirs(out_dir, exist_ok=True)
        # 路径校验下沉到每个 job: 单个文件越权/缺失只让该 job 失败, 不影响其余
        jobs, rejected = [], []
        for job in payload["jobs"]:
            try:
                path = _resolve_allowed(job["path"])
            except PermissionError as exc:
                rejected.append({"file": os.path.basename(job["path"]),
                                 "status": "error", "error": str(exc)})
                continue
            jobs.append({"path": path, "noise": job["noise"], "params": job["params"]})
        results = STATE.engine.batch_export(jobs, out_dir) + rejected
        ok = sum(1 for r in results if r["status"] == "ok")
        self._send_json({"out_dir": out_dir, "ok": ok,
                         "failed": len(results) - ok, "results": results})

    def _handle_download(self, q: dict) -> None:
        path = _resolve_allowed(q["path"])
        self._send_file(path)

    def _handle_project_save(self, payload: dict) -> None:
        path = _resolve_allowed(payload["path"])
        saved = save_project(payload["project"], path)
        self._send_json({"path": saved})

    def _handle_project_load(self, payload: dict) -> None:
        path = _resolve_allowed(payload["path"])
        project = load_project(path)
        missing, changed = [], []
        for f in project.get("files", []):
            if not os.path.exists(f["path"]):
                missing.append(f["name"])
                continue
            STATE.allow(f["path"])
            if file_sha256(f["path"]) != f.get("sha256"):
                changed.append(f["name"])
        self._send_json({"project": project, "missing": missing, "changed": changed})

    def _handle_upload(self, payload: dict) -> None:
        """浏览器上传: base64 内容落到 tmp/uploads, 再按普通文件加载。"""
        name = os.path.basename(payload["name"])
        ext = os.path.splitext(name)[1].lower()
        if ext not in SUPPORTED_READ_EXTS:
            raise ValueError(f"不支持的上传格式 {ext}")
        target = os.path.join(STATE.upload_dir, name)
        base, e = os.path.splitext(target)
        n = 2
        while os.path.exists(target):
            target = f"{base}_{n}{e}"
            n += 1
        with open(target, "wb") as f:
            f.write(base64.b64decode(payload["content_b64"]))
        af = STATE.engine.load(target)
        self._send_json(
            {
                "file": af.to_dict(),
                "peaks": _peaks_payload(waveform_peaks(af.data, buckets=1400)),
            }
        )


def run(host: str = "127.0.0.1", port: int = 8765) -> None:
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    print(f"NoiseKit 本地服务已启动: http://{host}:{port}")
    print("仅监听本机回环地址; Ctrl+C 退出。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出。")
    finally:
        server.server_close()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="NoiseKit 本地服务")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    run(args.host, args.port)
