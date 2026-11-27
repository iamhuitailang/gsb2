"""Local HTTP server and JSON API.

Runs on 127.0.0.1 only.  There is no upload endpoint: the browser sends a
*path* to a file that already exists on this machine, and the server reads it
directly.  Video is streamed back with HTTP Range support so the built-in
player can seek without loading the whole file.
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import subprocess
import threading
import time
import traceback
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import export as exporter
from . import media, samples, store, thumbnails
from .detect import DetectSettings, shot_duration
from .timecode import format_duration, format_tc_frames, ms_to_frame, ms_to_timecode

APP_ROOT = Path(__file__).resolve().parent.parent
WEB_ROOT = APP_ROOT / "web"
SAMPLES_ROOT = APP_ROOT / "samples"

_JOBS: dict[str, dict] = {}
_JOBS_LOCK = threading.Lock()


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400, code: str = "bad_request"):
        super().__init__(message)
        self.status = status
        self.code = code


# ---------------------------------------------------------------------------
# Project helpers
# ---------------------------------------------------------------------------


def project_payload(project: dict) -> dict:
    info = project["media"]["info"]
    fps = float(info.get("fps") or 30)
    detection = project.get("detection") or {}
    stats = store.stats(project)
    shots = []
    for index, shot in enumerate(project.get("shots") or []):
        start = int(shot["start_ms"])
        end = int(shot["end_ms"])
        thumb_ms = thumbnails.sample_time(start, end, 0.35)
        shots.append(
            {
                **shot,
                "index": index,
                "number": index + 1,
                "duration_ms": shot_duration(shot),
                "start_tc": ms_to_timecode(start),
                "end_tc": ms_to_timecode(end),
                "start_frame": format_tc_frames(start, fps),
                "end_frame": format_tc_frames(end, fps),
                "start_seconds": round(start / 1000.0, 3),
                "end_seconds": round(end / 1000.0, 3),
                "thumb_sample_ms": thumb_ms,
                "thumb_sample_tc": ms_to_timecode(thumb_ms),
            }
        )
    payload = {
        "id": project["id"],
        "name": project.get("name"),
        "created_at": project.get("created_at"),
        "updated_at": project.get("updated_at"),
        "media": {
            **project["media"],
            "exists": os.path.isfile(project["media"].get("path", "")),
        },
        "settings": project.get("settings"),
        "manual": project.get("manual") or {"add": [], "remove": []},
        "analysis": project.get("analysis"),
        "detection": {
            "settings": detection.get("settings"),
            "boundaries": detection.get("boundaries") or [],
            "summary": detection.get("summary") or {},
            "series": detection.get("series") or [],
            "analyzed_at": detection.get("analyzed_at"),
            "fps": detection.get("fps") or fps,
        },
        "shots": shots,
        "stats": stats,
        "tags": stats.get("tags") or [],
        "thumb_stats": thumbnails.project_thumb_stats(project["id"]),
    }
    return payload


def require_project(project_id: str, *, media_ok: bool = True) -> dict:
    project = store.load(project_id)
    if media_ok:
        store.ensure_media(project)
    return project


def _clean_settings(payload: dict | None) -> DetectSettings | None:
    """Validate a settings dict without silently normalising the numbers here.

    Normalisation (clamping ranges) happens inside the detector, which is the
    single place that defines what a legal setting is.
    """

    if payload is None:
        return None
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise ApiError("设置格式不正确") from exc
    if not isinstance(payload, dict):
        raise ApiError("设置格式不正确")
    known = DetectSettings.__dataclass_fields__
    cleaned = {}
    for key, value in payload.items():
        if key not in known:
            continue
        field_type = type(getattr(DetectSettings(), key))
        if field_type is bool:
            if not isinstance(value, bool):
                raise ApiError(f"设置 {key} 需要是布尔值")
            cleaned[key] = value
        elif field_type is float:
            try:
                cleaned[key] = float(value)
            except (TypeError, ValueError) as exc:
                raise ApiError(f"设置 {key} 需要是数字") from exc
        elif field_type is int:
            try:
                cleaned[key] = int(float(value))
            except (TypeError, ValueError) as exc:
                raise ApiError(f"设置 {key} 需要是整数") from exc
        elif field_type is str:
            cleaned[key] = str(value)
    return DetectSettings(**cleaned)


# ---------------------------------------------------------------------------
# Analysis jobs
# ---------------------------------------------------------------------------


def _job_snapshot(job_id: str) -> dict:
    with _JOBS_LOCK:
        job = dict(_JOBS.get(job_id) or {})
    if not job:
        raise ApiError("任务不存在", status=404, code="not_found")
    return job


def start_analysis(project_id: str, *, force: bool = False) -> dict:
    project = store.load(project_id)
    store.ensure_media(project)
    job_id = f"j-{int(time.time() * 1000)}-{os.getpid() % 1000}"
    with _JOBS_LOCK:
        _JOBS[job_id] = {
            "id": job_id,
            "kind": "analyze",
            "project_id": project_id,
            "status": "queued",
            "progress": 0,
            "message": "排队中",
            "started_at": time.time(),
        }

    def worker() -> None:
        with _JOBS_LOCK:
            _JOBS[job_id].update(status="running", message="正在解码并分析画面变化…")
        try:
            project_local = store.load(project_id)
            info = store.ensure_media(project_local)
            fingerprint = project_local["media"]["fingerprint"]
            cached = None if force else store.load_analysis(fingerprint)
            if cached:
                with _JOBS_LOCK:
                    _JOBS[job_id].update(progress=70, message="使用已有的分析缓存")
                analysis = cached
            else:
                last = {"count": 0}

                def on_progress(count: int) -> None:
                    if count - last["count"] < 150:
                        return
                    last["count"] = count
                    # ffmpeg doesn't report total frames cheaply here; use time.
                    estimate = min(88, 5 + count / max(1, info.duration_ms / 1000.0) * 2)
                    with _JOBS_LOCK:
                        _JOBS[job_id].update(progress=round(estimate), message=f"已分析 {count} 帧")

                result = media.analyze_scene(project_local["media"]["path"], progress=on_progress)
                analysis = store.save_analysis(fingerprint, project_local["media"]["path"], info, result["points"])
            with _JOBS_LOCK:
                _JOBS[job_id].update(progress=92, message="生成镜头切点…")
            store.rebuild(project_local, analysis=analysis)
            store.save(project_local)
            with _JOBS_LOCK:
                _JOBS[job_id].update(
                    progress=100,
                    status="done",
                    message=f"完成，检测到 {len(project_local['shots'])} 个片段",
                    finished_at=time.time(),
                )
        except Exception as exc:  # noqa: BLE001 - report to UI
            with _JOBS_LOCK:
                _JOBS[job_id].update(
                    status="error",
                    message=str(exc),
                    detail=traceback.format_exc(limit=4),
                    finished_at=time.time(),
                )

    threading.Thread(target=worker, name=f"analyze-{job_id}", daemon=True).start()
    return {"job_id": job_id}


# ---------------------------------------------------------------------------
# Request handling
# ---------------------------------------------------------------------------


def _json_response(handler: BaseHTTPRequestHandler, payload, status: int = 200, headers: dict | None = None) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    for key, value in (headers or {}).items():
        handler.send_header(key, value)
    handler.end_headers()
    handler.wfile.write(body)


def _bytes_response(
    handler: BaseHTTPRequestHandler,
    body: bytes,
    content_type: str,
    *,
    status: int = 200,
    headers: dict | None = None,
    cache: str = "no-store",
) -> None:
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", cache)
    for key, value in (headers or {}).items():
        handler.send_header(key, value)
    handler.end_headers()
    try:
        handler.wfile.write(body)
    except (BrokenPipeError, ConnectionResetError):
        pass


class Handler(BaseHTTPRequestHandler):
    server_version = "ShotShelf/1.0"
    protocol_version = "HTTP/1.1"

    # -- plumbing ---------------------------------------------------------

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        if os.environ.get("SHOT_SHELF_VERBOSE"):
            super().log_message(fmt, *args)

    def _parse_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > 8 * 1024 * 1024:
            raise ApiError("请求体过大", status=413)
        raw = self.rfile.read(length)
        content_type = (self.headers.get("Content-Type") or "").split(";")[0].strip()
        if content_type == "application/json":
            try:
                payload = json.loads(raw.decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                raise ApiError("JSON 格式不正确") from exc
            if not isinstance(payload, dict):
                raise ApiError("JSON 顶层必须是对象")
            return payload
        raise ApiError("只接受 application/json")

    def _query(self) -> dict:
        parsed = urllib.parse.urlparse(self.path)
        return {
            "path": parsed.path,
            "query": {k: v[-1] for k, v in urllib.parse.parse_qs(parsed.query).items()},
        }

    def do_GET(self) -> None:  # noqa: N802
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")

    def do_PATCH(self) -> None:  # noqa: N802
        self._dispatch("PATCH")

    def do_DELETE(self) -> None:  # noqa: N802
        self._dispatch("DELETE")

    def _dispatch(self, method: str) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = {k: v[-1] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        try:
            if path.startswith("/api/"):
                self._api(method, path, query)
            else:
                self._static(path)
        except ApiError as exc:
            _json_response(self, {"error": str(exc), "code": exc.code}, exc.status)
        except store.StoreError as exc:
            _json_response(self, {"error": str(exc), "code": "store_error"}, HTTPStatus.BAD_REQUEST)
        except media.MediaError as exc:
            _json_response(self, {"error": str(exc), "code": "media_error"}, HTTPStatus.UNPROCESSABLE_ENTITY)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            detail = traceback.format_exc(limit=6)
            if os.environ.get("SHOT_SHELF_VERBOSE"):
                print(detail)
            _json_response(
                self,
                {"error": f"服务器内部错误：{exc}", "code": "internal", "detail": detail if os.environ.get("SHOT_SHELF_VERBOSE") else None},
                HTTPStatus.INTERNAL_SERVER_ERROR,
            )

    # -- API routing ------------------------------------------------------

    def _api(self, method: str, path: str, query: dict) -> None:
        if path == "/api/health" and method == "GET":
            return _json_response(self, self._health())
        if path == "/api/projects" and method == "GET":
            return _json_response(self, {"projects": store.list_projects()})
        if path == "/api/projects" and method == "POST":
            return self._create_project()
        if path == "/api/samples" and method == "GET":
            return _json_response(self, samples.describe())
        if path == "/api/samples" and method == "POST":
            body = self._parse_body()
            return self._create_sample(body)
        if path == "/api/cache" and method == "GET":
            return _json_response(self, {"usage": store.cache_usage(), "projects": len(store.list_projects())})
        if path == "/api/cache/clear" and method == "POST":
            body = self._parse_body()
            return _json_response(self, store.clear_cache(str(body.get("what") or "all")))
        if path == "/api/exports" and method == "GET":
            return _json_response(self, {"exports": exporter.list_exports()})
        if path == "/api/reveal" and method == "POST":
            return self._reveal()
        if path == "/api/pick-file" and method == "GET":
            return self._pick_file()

        match = re.fullmatch(r"/api/jobs/([A-Za-z0-9_-]+)", path)
        if match and method == "GET":
            return _json_response(self, _job_snapshot(match.group(1)))

        project_match = re.fullmatch(r"/api/projects/([A-Za-z0-9_-]+)(/.*)?", path)
        if not project_match:
            raise ApiError("接口不存在", status=404, code="not_found")
        project_id = project_match.group(1)
        rest = project_match.group(2) or ""

        if rest == "" and method == "GET":
            return _json_response(self, {"project": project_payload(store.load(project_id))})
        if rest == "" and method == "DELETE":
            store.delete_project(project_id)
            return _json_response(self, {"ok": True})
        if rest == "" and method == "PATCH":
            body = self._parse_body()
            project = require_project(project_id)
            if "name" in body:
                name = str(body.get("name") or "").strip()[:120]
                if not name:
                    raise ApiError("项目名不能为空")
                project["name"] = name
            if "settings" in body:
                settings = _clean_settings(body.get("settings"))
                store.rebuild(project, settings=settings)
            store.save(project)
            return _json_response(self, {"project": project_payload(project)})

        if rest == "/analyze" and method == "POST":
            body = self._parse_body()
            return _json_response(self, start_analysis(project_id, force=bool(body.get("force"))), status=202)
        if rest == "/detect" and method == "POST":
            body = self._parse_body()
            project = require_project(project_id)
            settings = _clean_settings(body.get("settings")) if body.get("settings") is not None else None
            store.rebuild(project, settings=settings, save_project=True)
            return _json_response(self, {"project": project_payload(store.load(project_id))})
        if rest == "/rename" and method == "POST":
            body = self._parse_body()
            project = require_project(project_id)
            name = str(body.get("name") or "").strip()[:120]
            if not name:
                raise ApiError("项目名不能为空")
            project["name"] = name
            store.save(project)
            return _json_response(self, {"project": project_payload(project)})
        if rest == "/reset" and method == "POST":
            project = require_project(project_id)
            store.reset_manual(project, persist=True)
            return _json_response(self, {"project": project_payload(store.load(project_id))})
        if rest == "/split" and method == "POST":
            body = self._parse_body()
            shot_id = str(body.get("shot_id") or "")
            at_ms = int(body.get("at_ms") or 0)
            project = require_project(project_id)
            store.split_shot(project, shot_id, at_ms)
            return _json_response(self, {"project": project_payload(store.load(project_id))})
        if rest == "/merge" and method == "POST":
            body = self._parse_body()
            shot_ids = body.get("shot_ids") or []
            if not isinstance(shot_ids, list):
                raise ApiError("shot_ids 必须是数组")
            project = require_project(project_id)
            store.merge_shots(project, [str(s) for s in shot_ids])
            return _json_response(self, {"project": project_payload(store.load(project_id))})
        if rest == "/boundaries/add" and method == "POST":
            body = self._parse_body()
            at_ms = int(body.get("at_ms") or -1)
            project = require_project(project_id)
            info = store.ensure_media(project)
            if not (0 < at_ms < info.duration_ms):
                raise ApiError("切点超出视频范围")
            target = None
            for shot in project["shots"]:
                if shot["start_ms"] < at_ms < shot["end_ms"]:
                    target = shot
                    break
            if target is None:
                raise ApiError("切点必须落在某个片段内部")
            store.split_shot(project, target["id"], at_ms)
            return _json_response(self, {"project": project_payload(store.load(project_id))})
        if rest == "/boundaries/remove" and method == "POST":
            body = self._parse_body()
            at_ms = int(body.get("at_ms") or -1)
            project = require_project(project_id)
            store.remove_cut(project, at_ms)
            return _json_response(self, {"project": project_payload(store.load(project_id))})

        shot_match = re.fullmatch(r"/shots/([A-Za-z0-9_-]+)", rest)
        if shot_match and method == "PATCH":
            body = self._parse_body()
            project = require_project(project_id)
            store.update_shot(project, shot_match.group(1), body)
            return _json_response(self, {"project": project_payload(store.load(project_id))})

        if rest == "/thumb" and method == "GET":
            return self._thumb(project_id, query)
        if rest == "/frame" and method == "GET":
            return self._frame(project_id, query)
        if rest == "/video" and method == "GET":
            return self._video(project_id)
        if rest == "/export" and method == "POST":
            body = self._parse_body()
            project = require_project(project_id)
            return _json_response(self, exporter.export_project(project, name=body.get("name")))

        raise ApiError("接口不存在", status=404, code="not_found")

    # -- endpoints --------------------------------------------------------

    def _health(self) -> dict:
        report = media.doctor()
        report["projects"] = len(store.list_projects())
        report["samples"] = samples.describe()
        report["app_root"] = str(APP_ROOT)
        report["data_dir"] = str(store.data_dir())
        report["version"] = 1
        return report

    def _create_project(self) -> None:
        body = self._parse_body()
        raw_path = str(body.get("path") or "").strip()
        if not raw_path:
            raise ApiError("请填写本地视频路径")
        path = Path(raw_path).expanduser()
        if not path.is_absolute():
            raise ApiError("请填写绝对路径（例如 /Users/you/Movies/clip.mp4）")
        if not path.is_file():
            raise ApiError(f"找不到文件：{path}")
        settings = _clean_settings(body.get("settings"))
        project = store.create_project(str(path), name=body.get("name"), settings=settings)
        return _json_response(self, {"project": project_payload(project)}, status=201)

    def _create_sample(self, body: dict) -> None:
        try:
            result = samples.ensure_sample(regenerate=bool(body.get("regenerate")))
        except samples.SampleError as exc:
            raise ApiError(str(exc), status=422, code="sample_error") from exc

        video_path = result["video_path"]
        fingerprint = store.media_fingerprint(video_path)
        existing = None
        for item in store.list_projects():
            if item.get("media_path") == video_path:
                existing = store.load(item["id"])
                break

        settings = _clean_settings(body.get("settings")) or DetectSettings()
        if existing is None:
            project = store.create_project(
                video_path,
                name="样片 · 镜头切分演示",
                settings=settings,
            )
        else:
            project = existing
            project["settings"] = settings.__dict__.copy()
            if project["media"].get("fingerprint") != fingerprint:
                # The sample was regenerated: refresh media info and drop shots
                # that refer to the previous bytes.  Analysis is re-run by the
                # UI, since there is none for the new fingerprint yet.
                info = media.probe(video_path)
                project["media"] = {
                    "path": video_path,
                    "name": os.path.basename(video_path),
                    "fingerprint": fingerprint,
                    "info": {
                        "duration_ms": info.duration_ms,
                        "fps": info.fps,
                        "width": info.width,
                        "height": info.height,
                        "codec": info.codec,
                        "has_audio": info.has_audio,
                        "rotation": info.rotation,
                        "bit_rate": info.bit_rate,
                    },
                }
                project["shots"] = []
                project["detection"] = {}
                project["manual"] = {"add": [], "remove": []}
                project["analysis"] = {
                    "fingerprint": fingerprint,
                    "frame_count": 0,
                    "status": "pending",
                }
            elif store.load_analysis(fingerprint):
                store.rebuild(project, settings=settings)
            store.save(project)

        return _json_response(
            self,
            {
                "project": project_payload(project),
                "sample": result,
                "needs_analysis": not bool(store.load_analysis(fingerprint)),
            },
            status=201,
        )

    def _pick_file(self) -> None:
        """macOS native file picker. Fails soft elsewhere.

        The script is written so a cancel (returncode 1 / "User canceled")
        is a normal, non-error response and the dialog stays usable.
        """

        script = 'POSIX path of (choose file with prompt "选择视频" of type {"public.movie"})'
        try:
            result = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True,
                text=True,
                timeout=300,
            )
        except FileNotFoundError:
            return _json_response(
                self,
                {"path": None, "error": "当前系统没有 osascript，请直接粘贴视频的绝对路径。"},
            )
        except subprocess.TimeoutExpired:
            return _json_response(self, {"path": None, "error": "文件选择器超时，请直接粘贴路径。"})
        if result.returncode != 0:
            return _json_response(self, {"path": None, "cancelled": True})
        picked = (result.stdout or "").strip()
        return _json_response(self, {"path": picked or None})

    def _reveal(self) -> None:
        """Open an exported index.html in the default browser."""

        body = self._parse_body()
        raw = str(body.get("path") or "").strip()
        if not raw:
            raise ApiError("缺少路径")
        path = Path(raw).expanduser().resolve()
        try:
            path.relative_to(store.exports_dir().resolve())
        except ValueError:
            raise ApiError("只能打开导出目录内的文件", status=403)
        if not path.is_file():
            raise ApiError("文件不存在", status=404)
        opener = "open" if os.uname().sysname == "Darwin" else "xdg-open"
        if shutil.which(opener) is None:
            raise ApiError(f"找不到系统打开命令 {opener}")
        subprocess.Popen([opener, str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return _json_response(self, {"ok": True})

    def _thumb(self, project_id: str, query: dict) -> None:
        project = store.load(project_id)
        store.ensure_media(project)
        shot_id = query.get("shot_id") or query.get("shot") or ""
        shot = store.find_shot(project, shot_id)
        try:
            position = float(query.get("pos") or 0.35)
        except ValueError:
            position = 0.35
        try:
            width = int(query.get("w") or 480)
        except ValueError:
            width = 480
        width = max(160, min(960, width))
        meta = thumbnails.thumb_for(
            project_id=project_id,
            fingerprint=project["media"]["fingerprint"],
            media_path=project["media"]["path"],
            start_ms=shot["start_ms"],
            end_ms=shot["end_ms"],
            position=position,
            width=width,
        )
        image_path = thumbnails.image_path_for(project_id, meta["key"])
        if not image_path.exists():
            raise ApiError("缩略图生成失败", status=500)
        body = image_path.read_bytes()
        headers = {
            "X-Requested-Ms": str(meta.get("requested_ms")),
            "X-Actual-Ms": str(meta.get("actual_ms") if meta.get("actual_ms") is not None else ""),
            "X-Drift-Ms": str(meta.get("drift_ms") if meta.get("drift_ms") is not None else ""),
            "X-Shot-Start-Ms": str(shot["start_ms"]),
            "X-Shot-End-Ms": str(shot["end_ms"]),
        }
        _bytes_response(
            self,
            body,
            "image/jpeg",
            headers=headers,
            cache="private, max-age=31536000, immutable",
        )

    def _frame(self, project_id: str, query: dict) -> None:
        project = store.load(project_id)
        info = store.ensure_media(project)
        try:
            requested = int(round(float(query.get("t_ms") or 0)))
        except ValueError as exc:
            raise ApiError("t_ms 需要是数字") from exc
        requested = max(0, min(info.duration_ms - 1, requested))
        try:
            width = int(query.get("w") or 720)
        except ValueError:
            width = 720
        width = max(240, min(1280, width))

        preview_dir = store.data_dir() / "previews" / project_id
        preview_dir.mkdir(parents=True, exist_ok=True)
        key = f"{project['media']['fingerprint']}-{requested}-{width}"
        image_path = preview_dir / f"{key}.jpg"
        meta_path = preview_dir / f"{key}.json"
        meta: dict = {}
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                meta = {}
        if not image_path.exists() or meta.get("requested_ms") != requested:
            _, actual = media.extract_frame_with_pts(project["media"]["path"], requested, image_path, width=width)
            meta = {"requested_ms": requested, "actual_ms": actual}
            try:
                meta_path.write_text(json.dumps(meta), encoding="utf-8")
            except OSError:
                pass
        actual = meta.get("actual_ms")
        fps = float(info.fps or 30)
        body = image_path.read_bytes()
        headers = {
            "X-Requested-Ms": str(requested),
            "X-Actual-Ms": str(actual if actual is not None else ""),
            "X-Drift-Ms": str(actual - requested if isinstance(actual, int) else ""),
            "X-Requested-Tc": ms_to_timecode(requested),
            "X-Actual-Tc": ms_to_timecode(actual) if isinstance(actual, int) else "",
            "X-Frame": str(ms_to_frame(requested, fps)),
            "X-Fps": f"{fps:g}",
            "X-Duration-Ms": str(info.duration_ms),
        }
        _bytes_response(self, body, "image/jpeg", headers=headers, cache="private, max-age=600")

    def _video(self, project_id: str) -> None:
        project = store.load(project_id)
        store.ensure_media(project)
        path = project["media"]["path"]
        size = os.path.getsize(path)
        content_type = mimetypes.guess_type(path)[0] or "video/mp4"
        range_header = self.headers.get("Range")
        if range_header:
            match = re.match(r"bytes=(\d*)-(\d*)", range_header)
            if not match:
                raise ApiError("Range 头格式不正确", status=416)
            start = int(match.group(1) or 0)
            end = int(match.group(2)) if match.group(2) else size - 1
            if start >= size or end < start:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            end = min(end, size - 1)
            length = end - start + 1
            self.send_response(HTTPStatus.PARTIAL_CONTENT)
            self.send_header("Content-Type", content_type)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            remaining = length
            with open(path, "rb") as handle:
                handle.seek(start)
                while remaining > 0:
                    chunk = handle.read(min(1024 * 256, remaining))
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        return
                    remaining -= len(chunk)
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            with open(path, "rb") as handle:
                while True:
                    chunk = handle.read(1024 * 512)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # -- static files -----------------------------------------------------

    def _static(self, path: str) -> None:
        if path in {"", "/"}:
            relative = "index.html"
        else:
            relative = path.lstrip("/")
        candidate = (WEB_ROOT / relative).resolve()
        try:
            candidate.relative_to(WEB_ROOT.resolve())
        except ValueError:
            raise ApiError("禁止访问", status=403)
        if not candidate.is_file():
            raise ApiError("文件不存在", status=404, code="not_found")
        content_type = mimetypes.guess_type(str(candidate))[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {"application/javascript", "application/json"}:
            content_type += "; charset=utf-8"
        body = candidate.read_bytes()
        cache = "no-store" if candidate.name in {"index.html"} else "public, max-age=60"
        _bytes_response(self, body, content_type, cache=cache)


def run(host: str = "127.0.0.1", port: int = 8765) -> None:
    store.data_dir()
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    url = f"http://{host}:{port}/"
    print("Shot Shelf 镜头剪辑台")
    print(f"  地址: {url}")
    print(f"  数据: {store.data_dir()}")
    if not media.analysis_supported():
        print("  ⚠ ffmpeg 缺少 select / signalstats / metadata 滤镜，场景分析可能不可用")
    print("  Ctrl+C 退出")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出。")
    finally:
        server.server_close()


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="本地视频镜头整理工具")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("SHOT_SHELF_PORT", "8765")))
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    parser.add_argument("--generate-sample", action="store_true", help="生成示例视频后退出")
    args = parser.parse_args(argv)
    if args.generate_sample:
        result = samples.ensure_sample(regenerate=True)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.open:
        import webbrowser

        threading.Timer(0.6, lambda: webbrowser.open(f"http://{args.host}:{args.port}/")).start()
    run(args.host, args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
