"""Dependency-free local HTTP server and browser UI API."""

from __future__ import annotations

import json
import mimetypes
import re
import shutil
import tempfile
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from . import core

WEB_ROOT = Path(__file__).resolve().parent / "web"
RUNTIME_ROOT = Path(tempfile.mkdtemp(prefix="wav-sample-tool-"))
SOURCES: dict[str, dict[str, Any]] = {}
ASSEMBLIES: dict[str, dict[str, Any]] = {}


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _spool_request_body(handler: BaseHTTPRequestHandler, dest: Path) -> int:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    dest.parent.mkdir(parents=True, exist_ok=True)
    copied = 0
    with dest.open("wb") as out:
        while copied < length:
            chunk = handler.rfile.read(min(1 << 20, length - copied))
            if not chunk:
                break
            out.write(chunk)
            copied += len(chunk)
    return copied


def _read_json_body(handler: BaseHTTPRequestHandler) -> Any:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    raw = handler.rfile.read(length) if length else b"{}"
    try:
        return json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise core.WavToolError(f"请求 JSON 无效：{exc}") from exc


def _cuts_from_config(reader: core.WavReader, config: dict) -> tuple[list[dict], list[dict]]:
    total = reader.info.total_frames
    rate = reader.info.sample_rate
    mode = config.get("mode", "fixed")
    if mode == "fixed":
        cuts = core.plan_fixed_cuts(total, rate, float(config.get("interval_seconds", 1)))
    elif mode == "custom":
        cuts = core.plan_custom_cuts(
            total,
            rate,
            config.get("values", []),
            config.get("unit", "seconds"),
        )
    elif mode == "frames":
        cuts = core.plan_custom_cuts(total, rate, config.get("values", []), "frames")
    else:
        raise core.CutError(f"未知切点模式：{mode}")
    segments = core.segments_from_cuts(total, cuts)
    for seg in segments:
        seg["start_seconds"] = seg["start_frame"] / rate
        seg["end_seconds"] = seg["end_frame"] / rate
    return cuts, segments


class Handler(BaseHTTPRequestHandler):
    server_version = "WavSampleTool/1.0"

    def log_message(self, fmt: str, *args) -> None:  # quieter local server
        pass

    # ------------------------------------------------------------------
    # Response helpers
    # ------------------------------------------------------------------
    def send_json(self, value: Any, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, exc: Exception, status: int = 400) -> None:
        self.send_json({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, status)

    def send_file(self, path: str | Path, content_type: str | None = None, download_name: str | None = None) -> None:
        path = Path(path)
        if not path.is_file():
            self.send_json({"ok": False, "error": f"文件不存在：{path.name}"}, 404)
            return
        if content_type is None:
            content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        file_size = path.stat().st_size

        start = 0
        end = file_size - 1
        status = 200
        content_range = None
        range_header = self.headers.get("Range")
        if range_header and range_header.startswith("bytes="):
            spec = range_header[len("bytes="):].split(",", 1)[0].strip()
            start_text, _, end_text = spec.partition("-")
            try:
                if start_text == "":
                    # Suffix range: bytes=-N
                    suffix = int(end_text)
                    start = max(0, file_size - suffix)
                    end = file_size - 1
                else:
                    start = int(start_text)
                    end = int(end_text) if end_text else file_size - 1
                end = min(end, file_size - 1)
                if start < 0 or start >= file_size or end < start:
                    raise ValueError("invalid range")
                status = 206
                content_range = f"bytes {start}-{end}/{file_size}"
            except ValueError:
                body = b"range not satisfiable"
                self.send_response(416)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Range", f"bytes */{file_size}")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        if content_range:
            self.send_header("Content-Range", content_range)
        if download_name:
            quoted = urllib.parse.quote(download_name)
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quoted}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with path.open("rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(1 << 20, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    # ------------------------------------------------------------------
    # Routing
    # ------------------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/api/health":
                self.send_json({"ok": True, "runtime": str(RUNTIME_ROOT)})
            elif path == "/api/demo/source":
                self.create_demo_source()
            elif m := re.fullmatch(r"/api/sources/([a-f0-9]+)/raw", path):
                source = self._source(m.group(1))
                self.send_file(source["path"], "audio/wav", source.get("filename"))
            elif m := re.fullmatch(r"/api/sources/([a-f0-9]+)/audition", path):
                # Audition is POST because its parameters are JSON.
                self.send_json({"error": "use POST"}, 405)
            elif m := re.fullmatch(r"/api/assemblies/([a-f0-9]+)/audio", path):
                self.get_assembly_audio(m.group(1), query)
            elif path == "/" or path == "/index.html":
                self.send_file(WEB_ROOT / "index.html", "text/html; charset=utf-8")
            elif path in ("/app.js", "/styles.css"):
                ctype = "text/javascript; charset=utf-8" if path.endswith(".js") else "text/css; charset=utf-8"
                self.send_file(WEB_ROOT / path.lstrip("/"), ctype)
            else:
                self.send_json({"ok": False, "error": "not found"}, 404)
        except Exception as exc:
            self.send_error_json(exc)

    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/api/sources":
                self.upload_source()
            elif path == "/api/demo/source":
                self.create_demo_source()
            elif m := re.fullmatch(r"/api/sources/([a-f0-9]+)/plan", path):
                self.plan_source(m.group(1))
            elif m := re.fullmatch(r"/api/sources/([a-f0-9]+)/export", path):
                self.export_source(m.group(1))
            elif m := re.fullmatch(r"/api/sources/([a-f0-9]+)/audition", path):
                self.audition_source(m.group(1))
            elif path == "/api/assemblies":
                self.create_assembly()
            elif m := re.fullmatch(r"/api/assemblies/([a-f0-9]+)/verify", path):
                self.verify_assembly(m.group(1))
            elif m := re.fullmatch(r"/api/assemblies/([a-f0-9]+)/clear", path):
                self.clear_assembly(m.group(1))
            elif m := re.fullmatch(r"/api/assemblies/([a-f0-9]+)/original", path):
                self.upload_original(m.group(1))
            elif m := re.fullmatch(r"/api/demo/run", path):
                qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                self.run_demo(qs.get("case", ["normal"])[0])
            else:
                self.send_json({"ok": False, "error": "not found"}, 404)
        except Exception as exc:
            self.send_error_json(exc)

    def do_PUT(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        try:
            if m := re.fullmatch(r"/api/assemblies/([a-f0-9]+)/segments/(\d+)", path):
                self.upload_segment(m.group(1), int(m.group(2)))
            else:
                self.send_json({"ok": False, "error": "not found"}, 404)
        except Exception as exc:
            self.send_error_json(exc)

    # ------------------------------------------------------------------
    # Source endpoints
    # ------------------------------------------------------------------
    def upload_source(self) -> None:
        sid = _new_id()
        sdir = RUNTIME_ROOT / "sources" / sid
        source_path = sdir / "source.wav"
        _spool_request_body(self, source_path)
        reader = core.WavReader(source_path)
        original_name = urllib.parse.unquote(self.headers.get("X-Filename", source_path.name))
        SOURCES[sid] = {"path": source_path, "filename": original_name, "info": reader.info.to_dict()}
        self.send_json({"ok": True, "source_id": sid, "filename": original_name, "wav": reader.info.to_dict()})

    def create_demo_source(self) -> None:
        sid = _new_id()
        sdir = RUNTIME_ROOT / "sources" / sid
        source_path = sdir / "demo_sample.wav"
        demo = core.create_demo_wav(source_path)
        reader = core.WavReader(source_path)
        SOURCES[sid] = {"path": source_path, "filename": "demo_sample.wav", "info": reader.info.to_dict(), "demo": demo}
        self.send_json(
            {
                "ok": True,
                "source_id": sid,
                "filename": "demo_sample.wav",
                "wav": reader.info.to_dict(),
                "demo": demo,
            }
        )

    def _source(self, sid: str) -> dict[str, Any]:
        source = SOURCES.get(sid)
        if not source:
            raise core.WavToolError("会话已失效，请重新选择音频")
        return source

    def plan_source(self, sid: str) -> None:
        source = self._source(sid)
        config = _read_json_body(self)
        reader = core.WavReader(source["path"])
        cuts, segments = _cuts_from_config(reader, config)
        self.send_json({"ok": True, "cuts": cuts, "segments": segments})

    def export_source(self, sid: str) -> None:
        source = self._source(sid)
        config = _read_json_body(self)
        reader = core.WavReader(source["path"])
        cuts, _ = _cuts_from_config(reader, config)
        eid = _new_id()
        export_dir = RUNTIME_ROOT / "exports" / eid
        manifest = core.split_wav(source["path"], export_dir, cuts=cuts)
        zip_base = RUNTIME_ROOT / "zips" / eid
        zip_base.parent.mkdir(parents=True, exist_ok=True)
        zip_path = Path(shutil.make_archive(str(zip_base), "zip", root_dir=export_dir))
        self.send_file(zip_path, "application/zip", "wav_segments_with_manifest.zip")

    def audition_source(self, sid: str) -> None:
        source = self._source(sid)
        payload = _read_json_body(self)
        reader = core.WavReader(source["path"])
        total = reader.info.total_frames
        rate = reader.info.sample_rate

        if "start_frame" in payload and "end_frame" in payload:
            start = int(payload["start_frame"])
            end = int(payload["end_frame"])
        else:
            center = int(payload.get("frame", payload.get("cut_frame", 0)))
            pre_seconds = float(payload.get("pre_seconds", 0.05))
            post_seconds = float(payload.get("post_seconds", 0.10))
            pre = int(round(pre_seconds * rate))
            post = int(round(post_seconds * rate))
            if "pre_frames" in payload:
                pre = int(payload["pre_frames"])
            if "post_frames" in payload:
                post = int(payload["post_frames"])
            start = max(0, center - pre)
            end = min(total, center + post)

        start = max(0, min(start, total))
        end = max(start + 1, min(end, total))
        raw = reader.read_raw_range(start, end)
        body = _wav_bytes_from_raw(reader.info, raw, end - start)
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ------------------------------------------------------------------
    # Assembly endpoints
    # ------------------------------------------------------------------
    def create_assembly(self) -> None:
        manifest = _read_json_body(self)
        aid = _new_id()
        adir = RUNTIME_ROOT / "assemblies" / aid
        adir.mkdir(parents=True, exist_ok=True)
        core.write_manifest(manifest, adir / "manifest.json")
        ASSEMBLIES[aid] = {"dir": adir, "manifest": manifest, "uploads": {}}
        self.send_json({"ok": True, "assembly_id": aid, "segment_count": len(manifest.get("segments", []))})

    def _assembly(self, aid: str) -> dict[str, Any]:
        item = ASSEMBLIES.get(aid)
        if not item:
            raise core.WavToolError("导入会话已失效，请重新选择清单")
        return item

    def upload_segment(self, aid: str, index: int) -> None:
        item = self._assembly(aid)
        manifest = item["manifest"]
        if not 0 <= index < len(manifest["segments"]):
            raise core.WavToolError(f"段序号超出范围：{index + 1}")
        safe_name = f"slot_{index:04d}.wav"
        dest = item["dir"] / "uploads" / safe_name
        size = _spool_request_body(self, dest)
        provided_name = urllib.parse.unquote(self.headers.get("X-Filename", safe_name))
        item["uploads"][index] = {"path": dest, "filename": provided_name, "size": size}
        self.send_json({"ok": True, "index": index, "filename": provided_name, "size": size})

    def _assignments(self, item: dict[str, Any]):
        assignments = {}
        names = {}
        for idx, upload in item["uploads"].items():
            assignments[idx] = upload["path"]
            names[idx] = upload["filename"]
        return assignments, names

    def clear_assembly(self, aid: str) -> None:
        item = self._assembly(aid)
        upload_dir = item["dir"] / "uploads"
        if upload_dir.exists():
            shutil.rmtree(upload_dir)
        item["uploads"] = {}
        item["verification"] = None
        item["comparison"] = None
        for name in ("partial_preview.wav", "restored.wav"):
            p = item["dir"] / name
            if p.exists():
                p.unlink()
        item["partial"] = None
        item["restored"] = None
        self.send_json({"ok": True})

    def verify_assembly(self, aid: str) -> None:
        item = self._assembly(aid)
        manifest = item["manifest"]
        assignments, names = self._assignments(item)
        report = core.verify_assignments(manifest, assignments, names)
        partial_path = item["dir"] / "partial_preview.wav"
        core.write_assembly(partial_path, manifest, assignments, report, partial=True)
        restored_path = item["dir"] / "restored.wav"
        if report["sample_complete"]:
            core.write_assembly(restored_path, manifest, assignments, report, partial=False)
        elif restored_path.exists():
            restored_path.unlink()
        item["verification"] = report
        item["partial"] = partial_path
        item["restored"] = restored_path if report["sample_complete"] else None

        comparison = None
        if item.get("original_path"):
            candidate = restored_path if report["sample_complete"] else partial_path
            comparison = core.compare_wavs(item["original_path"], candidate)
            item["comparison"] = comparison
        self.send_json(
            {
                "ok": True,
                "report": report,
                "comparison": comparison,
                "partial_audio_url": f"/api/assemblies/{aid}/audio?kind=partial",
                "restored_audio_url": f"/api/assemblies/{aid}/audio?kind=restored",
            }
        )

    def upload_original(self, aid: str) -> None:
        item = self._assembly(aid)
        original_path = item["dir"] / "original.wav"
        _spool_request_body(self, original_path)
        core.WavReader(original_path)  # validate before compare
        item["original_path"] = original_path
        report = item.get("verification")
        if report is None:
            assignments, names = self._assignments(item)
            report = core.verify_assignments(item["manifest"], assignments, names)
            item["verification"] = report
            partial_path = item["dir"] / "partial_preview.wav"
            core.write_assembly(partial_path, item["manifest"], assignments, report, partial=True)
            item["partial"] = partial_path
            if report["sample_complete"]:
                restored = item["dir"] / "restored.wav"
                core.write_assembly(restored, item["manifest"], assignments, report)
                item["restored"] = restored

        candidate = item.get("restored") or item.get("partial")
        if candidate is None:
            candidate = item["dir"] / "partial_preview.wav"
            core.write_assembly(candidate, item["manifest"], {}, report, partial=True)
        comparison = core.compare_wavs(original_path, candidate)
        item["comparison"] = comparison
        self.send_json({"ok": True, "comparison": comparison})

    def get_assembly_audio(self, aid: str, query: dict[str, list[str]]) -> None:
        item = self._assembly(aid)
        kind = query.get("kind", ["partial"])[0]
        if kind == "restored":
            path = item.get("restored")
            if not path or not Path(path).exists():
                # Hash-identified swap correction is still a valid timeline preview.
                path = item.get("partial")
        else:
            path = item.get("partial")
        if not path or not Path(path).exists():
            self.send_json({"ok": False, "error": "音频尚未生成"}, 404)
            return
        download_name = None
        if query.get("download") == ["1"]:
            download_name = "restored.wav" if kind == "restored" else "partial_timeline_preview.wav"
        self.send_file(path, "audio/wav", download_name)

    # ------------------------------------------------------------------
    # Demo
    # ------------------------------------------------------------------
    def run_demo(self, case: str) -> None:
        aid = _new_id()
        demo_dir = RUNTIME_ROOT / "demos" / aid
        result = core.make_demo_workspace(demo_dir, case)
        ASSEMBLIES[aid] = {
            "dir": demo_dir,
            "manifest": result["manifest"],
            "uploads": {},
            "verification": result["verification"],
            "partial": Path(result["partial_preview"]),
            "restored": Path(result["restored"]) if result["restored"] else None,
            "original_path": Path(result["source"]),
            "comparison": result["comparison_partial"],
            "demo_result": result,
        }
        self.send_json(
            {
                "ok": True,
                "assembly_id": aid,
                "case": case,
                "source_id": None,
                "demo": result["demo"],
                "cuts": result["cuts"],
                "manifest": result["manifest"],
                "report": result["verification"],
                "comparison": result["comparison_partial"],
                "partial_audio_url": f"/api/assemblies/{aid}/audio?kind=partial",
                "restored_audio_url": f"/api/assemblies/{aid}/audio?kind=restored",
            }
        )


def _wav_bytes_from_raw(info: core.WavInfo, raw: bytes, frames: int) -> bytes:
    import io

    buf = io.BytesIO()
    core.write_wav_header(
        buf,
        channels=info.channels,
        sample_rate=info.sample_rate,
        sample_width=info.sample_width,
        total_frames=frames,
        audio_format=info.audio_format,
    )
    buf.write(raw)
    return buf.getvalue()


def run_server(host: str = "127.0.0.1", port: int = 8765) -> None:
    httpd = ThreadingHTTPServer((host, port), Handler)
    url = f"http://{host}:{port}/"
    print(f"WAV 采样点级分段/复原工具已启动：{url}")
    print("按 Ctrl+C 停止。所有处理均在本机完成，运行临时目录：", RUNTIME_ROOT)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    run_server()
