"""Project storage and shot editing.

A project is a plain JSON document::

    {
      "version": 1,
      "id": "p-...",
      "name": "...",
      "media": {"path": "...", "name": "...", "fingerprint": "...", "info": {...}},
      "settings": {... detection settings ...},
      "manual": {"add": [ms...], "remove": [ms...]},
      "shots": [{id, start_ms, end_ms, tags, note, manual_*}, ...],
      "detection": {boundaries, summary, series, settings, fps, duration_ms}
    }

Two design rules keep edits and evidence consistent:

1. **Shot edits are local.** Split, merge and boundary drags edit only the
   shots involved; they never re-run detection and therefore never move tags
   or notes to a different shot.  The manual override lists are updated at
   the same time so a later re-detection honours the edit.
2. **Re-detection preserves identity.** ``rebuild`` gives every new shot the
   id of the old shot it overlaps most, then copies annotations by id.  Each
   old annotation set therefore lands on exactly one new shot — no
   duplication, no silent loss.

Everything is local; nothing in this module talks to the network.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import time
from pathlib import Path
from typing import Iterable, Sequence

from . import media
from .detect import (
    DetectSettings,
    detect,
    resolve_overlaps,
    shot_duration,
)
from .timecode import frame_duration_ms

VERSION = 1
PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{3,64}$")

_LOCK = threading.RLock()


class StoreError(RuntimeError):
    pass


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def root_dir() -> Path:
    override = os.environ.get("SHOT_SHELF_HOME")
    if override:
        return Path(override).expanduser().resolve()
    return Path(__file__).resolve().parent.parent


def _ensure(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def projects_dir() -> Path:
    return _ensure(root_dir() / "projects")


def data_dir() -> Path:
    return _ensure(root_dir() / "data")


def analysis_dir() -> Path:
    return _ensure(data_dir() / "analysis")


def thumbs_dir() -> Path:
    return _ensure(data_dir() / "thumbs")


def previews_dir() -> Path:
    return _ensure(data_dir() / "previews")


def exports_dir() -> Path:
    return _ensure(data_dir() / "exports")


def samples_dir() -> Path:
    return _ensure(root_dir() / "samples")


# ---------------------------------------------------------------------------
# Project files
# ---------------------------------------------------------------------------


def new_project_id() -> str:
    return "p-" + hashlib.sha1(f"{time.time_ns()}-{os.getpid()}".encode()).hexdigest()[:10]


def media_fingerprint(path: str | Path) -> str:
    """Identity of the analysed bytes, not just the path.

    Size + mtime + inode means a replaced or re-encoded file gets fresh
    analysis and thumbnails instead of frames from the old cut.
    """

    stat = os.stat(path)
    seed = f"{os.path.realpath(path)}|{stat.st_size}|{stat.st_mtime_ns}|{stat.st_ino}"
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()[:20]


def project_path(project_id: str) -> Path:
    if not PROJECT_ID_RE.match(project_id or ""):
        raise StoreError("项目编号不合法")
    return projects_dir() / f"{project_id}.json"


def _atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp{os.getpid()}.{threading.get_ident()}")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=1)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def save(project: dict) -> dict:
    with _LOCK:
        project["updated_at"] = _now()
        _atomic_write_json(project_path(project["id"]), project)
    return project


def load(project_id: str) -> dict:
    path = project_path(project_id)
    if not path.exists():
        raise StoreError(f"项目不存在：{project_id}")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            project = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise StoreError(f"项目文件损坏：{exc}") from exc
    if not isinstance(project, dict) or project.get("version") != VERSION:
        raise StoreError("项目版本不兼容")
    project.setdefault("manual", {"add": [], "remove": []})
    project.setdefault("shots", [])
    project.setdefault("detection", {})
    return project


def list_projects() -> list[dict]:
    items = []
    for path in sorted(projects_dir().glob("p-*.json")):
        try:
            with open(path, "r", encoding="utf-8") as handle:
                project = json.load(handle)
        except (OSError, json.JSONDecodeError):
            continue
        if project.get("version") != VERSION:
            continue
        media_info = project.get("media") or {}
        info = media_info.get("info") or {}
        items.append(
            {
                "id": project.get("id"),
                "name": project.get("name"),
                "media_name": media_info.get("name"),
                "media_path": media_info.get("path"),
                "media_exists": os.path.isfile(media_info.get("path", "")),
                "duration_ms": info.get("duration_ms", 0),
                "shot_count": len(project.get("shots") or []),
                "analysis_status": (project.get("analysis") or {}).get("status"),
                "updated_at": project.get("updated_at"),
                "created_at": project.get("created_at"),
            }
        )
    items.sort(key=lambda item: item.get("updated_at") or "", reverse=True)
    return items


def delete_project(project_id: str) -> None:
    with _LOCK:
        project_path(project_id).unlink(missing_ok=True)
        shutil.rmtree(thumbs_dir() / project_id, ignore_errors=True)
        shutil.rmtree(previews_dir() / project_id, ignore_errors=True)


def _settings_from(value) -> DetectSettings:
    if value is None:
        return DetectSettings().normalized()
    if isinstance(value, DetectSettings):
        return value.normalized()
    if isinstance(value, dict):
        known = DetectSettings.__dataclass_fields__
        return DetectSettings(**{k: v for k, v in value.items() if k in known}).normalized()
    raise StoreError("检测设置格式不正确")


def create_project(
    media_path: str,
    *,
    name: str | None = None,
    settings: DetectSettings | dict | None = None,
) -> dict:
    resolved = Path(media_path).expanduser().resolve()
    if not resolved.is_file():
        raise StoreError(f"视频文件不存在：{resolved}")
    info = media.probe(resolved)
    fingerprint = media_fingerprint(resolved)
    detect_settings = _settings_from(settings)
    project = {
        "version": VERSION,
        "id": new_project_id(),
        "name": (name or resolved.stem).strip()[:120] or resolved.stem,
        "created_at": _now(),
        "updated_at": _now(),
        "media": {
            "path": str(resolved),
            "name": resolved.name,
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
        },
        "settings": detect_settings.__dict__.copy(),
        "manual": {"add": [], "remove": []},
        "shots": [
            {
                "id": "s-0",
                "start_ms": 0,
                "end_ms": info.duration_ms,
                "tags": [],
                "note": "",
                "manual_start": False,
                "manual_end": False,
                "created_manual": False,
            }
        ],
        "detection": {},
        "analysis": {"fingerprint": fingerprint, "frame_count": 0, "status": "pending"},
    }
    save(project)
    return project


def ensure_media(project: dict) -> media.MediaInfo:
    path = (project.get("media") or {}).get("path")
    if not path or not os.path.isfile(path):
        raise StoreError(f"源视频不在原位置：{path or '（未记录）'}")
    fingerprint = media_fingerprint(path)
    if fingerprint != (project.get("media") or {}).get("fingerprint"):
        raise StoreError("源视频文件已变化（大小或修改时间不同），请重新导入以刷新分析。")
    info = project["media"].get("info") or {}
    return media.MediaInfo(
        duration_ms=int(info.get("duration_ms") or 0),
        fps=float(info.get("fps") or 30),
        width=int(info.get("width") or 0),
        height=int(info.get("height") or 0),
        codec=str(info.get("codec") or "unknown"),
        has_audio=bool(info.get("has_audio")),
        rotation=int(info.get("rotation") or 0),
        bit_rate=info.get("bit_rate"),
    )


# ---------------------------------------------------------------------------
# Analysis cache
# ---------------------------------------------------------------------------


def _analysis_cache_path(fingerprint: str) -> Path:
    return analysis_dir() / f"{fingerprint}.json"


def load_analysis(fingerprint: str) -> dict | None:
    path = _analysis_cache_path(fingerprint)
    if not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    if payload.get("fingerprint") != fingerprint or not payload.get("points"):
        return None
    return payload


def save_analysis(fingerprint: str, path: str, info: media.MediaInfo, points: list) -> dict:
    payload = {
        "fingerprint": fingerprint,
        "path": path,
        "duration_ms": info.duration_ms,
        "fps": info.fps,
        "points": points,
        "created_at": _now(),
        "analyzer": "ffmpeg scene + signalstats",
    }
    _atomic_write_json(_analysis_cache_path(fingerprint), payload)
    return payload


def rows_from(analysis: dict) -> list[tuple[int, float, float, float]]:
    rows = []
    for item in analysis.get("points") or []:
        try:
            rows.append((int(item[0]), float(item[1]), float(item[2]), float(item[3])))
        except (TypeError, ValueError, IndexError):
            continue
    return rows


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


def _overlap(a: dict, b: dict) -> int:
    return min(int(a["end_ms"]), int(b["end_ms"])) - max(int(a["start_ms"]), int(b["start_ms"]))


def _assign_ids(old_shots: Sequence[dict], new_shots: list[dict]) -> dict[str, list[dict]]:
    """Match old shots to new shots and carry annotations across.

    Each *old* shot is assigned to the single new shot it overlaps most
    (ties go to the earlier new shot).  Grouping is therefore many-to-one:

    * a **merge** (several old shots → one new shot) unions all their tags
      and notes onto the new shot;
    * a **split** (one old shot → several new shots) puts the annotation on
      the half with more overlap only, so nothing is duplicated.

    A new shot keeps the id of the old shot that contributed most overlap,
    which keeps selections and cached state stable across re-detection.
    """

    inherited: dict[int, list[dict]] = {index: [] for index in range(len(new_shots))}
    if not new_shots:
        return {}
    for old in old_shots:
        best_new = None
        best_overlap = 0
        for new_index, new in enumerate(new_shots):
            overlap = _overlap(new, old)
            if overlap > best_overlap:
                best_new, best_overlap = new_index, overlap
        if best_new is not None and best_overlap > 0:
            inherited[best_new].append(old)

    for position, shot in enumerate(new_shots):
        olds = inherited[position]
        if not olds:
            shot["id"] = f"s-{int(time.time_ns() % 1_000_000_000):09d}-{position}"
            continue
        # Largest-overlap old shot wins the id, then merge all annotations.
        olds.sort(key=lambda old: _overlap(shot, old), reverse=True)
        shot["id"] = olds[0]["id"]
        tags: list[str] = []
        notes: list[str] = []
        for old in olds:
            for tag in old.get("tags") or []:
                if tag not in tags:
                    tags.append(tag)
            note = (old.get("note") or "").strip()
            if note and note not in notes:
                notes.append(note)
        shot["tags"] = tags
        shot["note"] = "\n".join(notes)
        shot["created_manual"] = any(old.get("created_manual") for old in olds)

    # If two new shots somehow ended up with the same id (overlapping source
    # ranges), disambiguate the later one.
    seen: set[str] = set()
    for shot in new_shots:
        if shot["id"] in seen:
            shot["id"] = f"{shot['id']}-{shot['start_ms']}"
        seen.add(shot["id"])

    return {shot["id"]: inherited[index] for index, shot in enumerate(new_shots)}


def rebuild(
    project: dict,
    *,
    settings: DetectSettings | dict | None = None,
    analysis: dict | None = None,
    save_project: bool = False,
) -> dict:
    """Re-run detection with current settings and manual overrides.

    Only cached per-frame analysis is used, so this never decodes the video.
    Annotations move with shot identity (see :func:`_assign_ids`).
    """

    with _LOCK:
        info = ensure_media(project)
        fingerprint = project["media"]["fingerprint"]
        if analysis is None:
            analysis = load_analysis(fingerprint)
        if analysis is None:
            raise StoreError("还没有场景分析数据，请先分析视频。")

        detect_settings = _settings_from(settings) if settings is not None else _settings_from(project.get("settings"))
        project["settings"] = detect_settings.__dict__.copy()

        manual = _manual(project)
        rows = rows_from(analysis)
        result = detect(
            rows,
            detect_settings,
            fps=info.fps,
            duration_ms=info.duration_ms,
            extra_boundaries=manual["add"],
            removed_boundaries=manual["remove"],
        )
        old_shots = list(project.get("shots") or [])
        new_shots = result.shots
        _assign_ids(old_shots, new_shots)

        project["shots"] = new_shots
        project["detection"] = {
            "settings": result.settings,
            "boundaries": result.boundaries,
            "summary": result.summary,
            "series": result.series,
            "analyzed_at": analysis.get("created_at") or _now(),
            "fps": info.fps,
            "duration_ms": info.duration_ms,
        }
        project["analysis"] = {
            "fingerprint": fingerprint,
            "frame_count": len(rows),
            "status": "ready",
            "created_at": analysis.get("created_at"),
        }
        if save_project:
            save(project)
        return {"project": project, "result": result}


# ---------------------------------------------------------------------------
# Manual overrides
# ---------------------------------------------------------------------------


def _manual(project: dict) -> dict:
    manual = project.setdefault("manual", {"add": [], "remove": []})
    manual.setdefault("add", [])
    manual.setdefault("remove", [])
    return manual


def _frame_ms(project: dict) -> int:
    fps = float((project.get("media") or {}).get("info", {}).get("fps") or 30)
    return frame_duration_ms(fps)


def _near_cut(project: dict) -> int:
    """Tolerance for treating two boundary positions as the same cut."""

    return max(120, _frame_ms(project) * 3)


def _add_manual_cut(project: dict, at_ms: int) -> None:
    manual = _manual(project)
    at_ms = int(at_ms)
    tolerance = _near_cut(project)
    manual["add"] = [int(t) for t in manual["add"] if abs(int(t) - at_ms) > tolerance]
    manual["remove"] = [int(t) for t in manual["remove"] if abs(int(t) - at_ms) > tolerance]
    manual["add"].append(at_ms)
    manual["add"].sort()


def _drop_manual_cut(project: dict, at_ms: int) -> None:
    """Record that the cut near ``at_ms`` was removed by the user."""

    manual = _manual(project)
    at_ms = int(at_ms)
    tolerance = _near_cut(project)
    manual["add"] = [int(t) for t in manual["add"] if abs(int(t) - at_ms) > tolerance]
    manual["remove"] = [int(t) for t in manual["remove"] if abs(int(t) - at_ms) > tolerance]
    manual["remove"].append(at_ms)
    manual["remove"].sort()


def _manual_edits(project: dict) -> int:
    manual = _manual(project)
    return len(manual["add"]) + len(manual["remove"])


def _snap(project: dict, ms: int) -> int:
    """Snap a boundary to the nearest source frame and into the timeline."""

    duration = int((project.get("media") or {}).get("info", {}).get("duration_ms") or 0)
    fps = float((project.get("media") or {}).get("info", {}).get("fps") or 30)
    if fps > 0:
        ms = int(round(round(ms * fps / 1000.0) * 1000.0 / fps))
    return max(0, min(duration, ms))


def _duration(project: dict) -> int:
    return int((project.get("media") or {}).get("info", {}).get("duration_ms") or 0)


def _region_annotations(shots: Sequence[dict]) -> tuple[list[str], str]:
    tags = list(dict.fromkeys(tag for shot in shots for tag in (shot.get("tags") or [])))
    notes: list[str] = []
    for shot in shots:
        note = (shot.get("note") or "").strip()
        if note and note not in notes:
            notes.append(note)
    return tags, "\n".join(notes)


def find_shot(project: dict, shot_id: str) -> dict:
    for shot in project.get("shots") or []:
        if shot["id"] == shot_id:
            return shot
    raise StoreError(f"片段不存在：{shot_id}")


def _shot_index(project: dict, shot: dict) -> int:
    try:
        return project["shots"].index(shot)
    except ValueError as exc:  # pragma: no cover
        raise StoreError("片段不在项目里") from exc


# -- boundary evidence helpers --------------------------------------------


def _boundary_record(project: dict, at_ms: int, tolerance: int | None = None):
    tolerance = tolerance if tolerance is not None else _near_cut(project)
    for boundary in (project.get("detection") or {}).get("boundaries") or []:
        if abs(int(boundary.get("at_ms", -10**9)) - at_ms) <= tolerance:
            return boundary
    return None


def _mark_manual_boundary(project: dict, old_ms: int, new_ms: int | None, reason: str) -> None:
    """Retime or retire the evidence row for a cut the user just edited."""

    record = _boundary_record(project, old_ms)
    if record is None:
        if new_ms is None:
            return
        record = {
            "id": f"b-manual-{new_ms}",
            "at_ms": int(new_ms),
            "score": 0.0,
            "kind": "manual",
            "width_ms": 0,
            "sharpness": 0.0,
            "mass": 0.0,
            "luma_before": 0.0,
            "luma_after": 0.0,
            "luma_delta": 0.0,
            "sat_before": 0.0,
            "sat_after": 0.0,
            "sat_delta": 0.0,
            "prominence": 0.0,
            "source": "manual",
            "decision": "kept",
            "reason": reason,
            "strong": True,
            "confidence": 1.0,
            "confidence_label": "手动",
            "frame": 0,
            "transition_start_ms": int(new_ms),
            "transition_end_ms": int(new_ms),
        }
        (project.setdefault("detection", {})).setdefault("boundaries", []).append(record)
    if new_ms is None:
        record["decision"] = "merged"
        record["reason"] = reason
    else:
        record["at_ms"] = int(new_ms)
        record["source"] = "manual"
        record["kind"] = "manual"
        record["decision"] = "kept"
        record["confidence"] = 1.0
        record["confidence_label"] = "手动"
        record["reason"] = reason
    boundaries = (project.get("detection") or {}).get("boundaries") or []
    boundaries.sort(key=lambda b: b.get("at_ms", 0))
    _refresh_summary(project)


def _refresh_summary(project: dict) -> None:
    detection = project.setdefault("detection", {})
    existing = detection.get("summary") or {}
    boundaries = detection.get("boundaries") or []
    summary = dict(existing)
    summary["boundary_count"] = len(boundaries)
    summary["cuts"] = sum(1 for b in boundaries if b.get("decision") in {"kept", "short-kept"})
    summary["merged"] = sum(1 for b in boundaries if b.get("decision") == "merged")
    summary["kept_short"] = sum(1 for b in boundaries if b.get("decision") == "short-kept")
    summary["manual"] = sum(1 for b in boundaries if b.get("source") == "manual")
    summary["shot_count"] = len(project.get("shots") or [])
    detection["summary"] = summary


# ---------------------------------------------------------------------------
# Shot editing (local, annotation-safe)
# ---------------------------------------------------------------------------


def split_shot(project: dict, shot_id: str, at_ms: int, *, persist: bool = True) -> dict:
    """Split one shot in two.  The right half starts with no annotations."""

    with _LOCK:
        shot = find_shot(project, shot_id)
        frame_ms = _frame_ms(project)
        at_ms = _snap(project, int(at_ms))
        if not (shot["start_ms"] + frame_ms <= at_ms <= shot["end_ms"] - frame_ms):
            raise StoreError("切点必须落在片段内部（至少离边缘一帧）")
        index = _shot_index(project, shot)
        right = {
            "id": f"s-{int(time.time_ns() % 1_000_000_000):09d}",
            "start_ms": at_ms,
            "end_ms": shot["end_ms"],
            "tags": [],
            "note": "",
            "manual_start": True,
            "manual_end": bool(shot.get("manual_end")),
            "created_manual": False,
        }
        shot["end_ms"] = at_ms
        shot["manual_end"] = True
        project["shots"].insert(index + 1, right)
        _add_manual_cut(project, at_ms)
        _mark_manual_boundary(project, at_ms, at_ms, "用户在片段内部手动添加的切点，两侧都可继续编辑。")
        if persist:
            save(project)
        return {"project": project, "shot_id": right["id"]}


def merge_shots(project: dict, shot_ids: Iterable[str], *, persist: bool = True) -> dict:
    """Merge adjacent shots into one, unioning their annotations."""

    with _LOCK:
        ids = list(dict.fromkeys(str(s) for s in shot_ids))
        if len(ids) < 2:
            raise StoreError("至少选择两个相邻片段才能合并")
        shots = project.get("shots") or []
        indices = sorted(_shot_index(project, find_shot(project, shot_id)) for shot_id in ids)
        if indices[-1] - indices[0] + 1 != len(indices):
            raise StoreError("只能合并选择范围内连续相邻的片段")

        selected = [shots[i] for i in indices]
        tags, note = _region_annotations(selected)
        cut_times = [shots[i]["end_ms"] for i in indices[:-1]]

        merged = {
            **selected[0],
            "end_ms": selected[-1]["end_ms"],
            "tags": tags,
            "note": note,
            "manual_start": selected[0].get("manual_start", False),
            "manual_end": selected[-1].get("manual_end", False),
            "created_manual": True,
        }
        project["shots"] = shots[: indices[0]] + [merged] + shots[indices[-1] + 1 :]
        for cut in cut_times:
            _drop_manual_cut(project, cut)
            _mark_manual_boundary(project, cut, None, "人工把相邻片段合并，这个切点不再存在。")
        _refresh_summary(project)
        if persist:
            save(project)
        return {"project": project, "shot_id": merged["id"]}


def remove_cut(project: dict, at_ms: int, *, persist: bool = True) -> dict:
    """Merge across the cut nearest to ``at_ms``."""

    with _LOCK:
        tolerance = max(200, _near_cut(project))
        shots = project.get("shots") or []
        target = None
        for index in range(len(shots) - 1):
            if abs(shots[index]["end_ms"] - at_ms) <= tolerance:
                target = index
                break
        if target is None:
            raise StoreError("这个位置没有可删除的切点")
        cut = shots[target]["end_ms"]
        tags, note = _region_annotations([shots[target], shots[target + 1]])
        shots[target]["end_ms"] = shots[target + 1]["end_ms"]
        shots[target]["tags"] = tags
        shots[target]["note"] = note
        shots[target]["created_manual"] = True
        del shots[target + 1]
        _drop_manual_cut(project, cut)
        _mark_manual_boundary(project, cut, None, "人工删除了这个切点，两侧片段已合并。")
        _refresh_summary(project)
        if persist:
            save(project)
        return project


def update_shot(project: dict, shot_id: str, patch: dict, *, persist: bool = True) -> dict:
    """Update tags/notes and/or drag one of the shot's boundaries.

    Boundary drags edit only the two adjacent shots; tags and notes therefore
    stay exactly where they were.
    """

    with _LOCK:
        shot = find_shot(project, shot_id)

        if "tags" in patch:
            tags = patch.get("tags") or []
            if not isinstance(tags, list):
                raise StoreError("标签必须是数组")
            cleaned: list[str] = []
            for tag in tags:
                text = str(tag).strip()[:40]
                if text and text not in cleaned:
                    cleaned.append(text)
            shot["tags"] = cleaned[:24]
        if "note" in patch:
            shot["note"] = str(patch.get("note") or "")[:4000]

        if "start_ms" not in patch and "end_ms" not in patch:
            if persist:
                save(project)
            return project

        frame_ms = _frame_ms(project)
        duration = _duration(project)
        shots = project["shots"]
        index = _shot_index(project, shot)
        old_start = shot["start_ms"]
        old_end = shot["end_ms"]
        new_start = old_start
        new_end = old_end

        if patch.get("start_ms") is not None:
            if index == 0:
                raise StoreError("第一段的入点固定为视频开头")
            prev = shots[index - 1]
            want = _snap(project, int(patch["start_ms"]))
            new_start = max(prev["start_ms"] + frame_ms, min(old_end - frame_ms, want))

        if patch.get("end_ms") is not None:
            if index == len(shots) - 1:
                new_end = duration
            else:
                nxt = shots[index + 1]
                want = _snap(project, int(patch["end_ms"]))
                new_end = max(new_start + frame_ms, min(nxt["end_ms"] - frame_ms, want))

        if new_start == old_start and new_end == old_end:
            if persist:
                save(project)
            return project

        if new_start != old_start:
            shots[index - 1]["end_ms"] = new_start
            shots[index - 1]["manual_end"] = True
            shot["start_ms"] = new_start
            shot["manual_start"] = True
            _drop_manual_cut(project, old_start)
            _add_manual_cut(project, new_start)
            _mark_manual_boundary(
                project, old_start, new_start,
                f"人工把切点从 {old_start}ms 移到 {new_start}ms。",
            )

        if new_end != old_end:
            shot["end_ms"] = new_end
            shot["manual_end"] = True
            if index + 1 < len(shots):
                shots[index + 1]["start_ms"] = new_end
                shots[index + 1]["manual_start"] = True
            _drop_manual_cut(project, old_end)
            if new_end < duration:
                _add_manual_cut(project, new_end)
            _mark_manual_boundary(
                project, old_end, new_end if new_end < duration else None,
                f"人工把切点从 {old_end}ms 移到 {new_end}ms。",
            )

        shot["created_manual"] = True
        project["shots"] = resolve_overlaps(project["shots"])
        _refresh_summary(project)
        if persist:
            save(project)
        return project


def reset_manual(project: dict, *, persist: bool = True) -> dict:
    """Drop every manual override and re-detect."""

    project["manual"] = {"add": [], "remove": []}
    rebuild(project, save_project=persist)
    return project


def add_shot_region(project: dict, start_ms: int, end_ms: int | None = None, *, persist: bool = True) -> dict:
    """Create one explicit shot over a time range (manual boundary pair)."""

    with _LOCK:
        info = ensure_media(project)
        frame_ms = frame_duration_ms(info.fps)
        start_ms = _snap(project, max(0, int(start_ms)))
        end_ms = info.duration_ms if end_ms is None else _snap(project, min(info.duration_ms, int(end_ms)))
        if end_ms - start_ms < frame_ms * 2:
            raise StoreError("片段太短")
        project["manual"] = {"add": [], "remove": []}
        if start_ms > 0:
            _add_manual_cut(project, start_ms)
        if end_ms < info.duration_ms:
            _add_manual_cut(project, end_ms)
        rebuild(project)
        region = [s for s in project["shots"] if s["end_ms"] > start_ms and s["start_ms"] < end_ms]
        if region:
            tags, note = _region_annotations(region)
            target = next((s for s in project["shots"] if s["start_ms"] == start_ms), region[0])
            target["tags"] = tags
            target["note"] = note
            target["created_manual"] = True
        if persist:
            save(project)
        return project


# ---------------------------------------------------------------------------
# Tags, stats, cache
# ---------------------------------------------------------------------------


def all_tags(project: dict) -> list[dict]:
    counts: dict[str, int] = {}
    for shot in project.get("shots") or []:
        for tag in shot.get("tags") or []:
            counts[tag] = counts.get(tag, 0) + 1
    return [{"tag": tag, "count": n} for tag, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]


def stats(project: dict) -> dict:
    shots = project.get("shots") or []
    durations = [shot_duration(s) for s in shots]
    detection = project.get("detection") or {}
    return {
        "shot_count": len(shots),
        "total_ms": sum(durations),
        "avg_ms": int(sum(durations) / len(durations)) if durations else 0,
        "min_ms": min(durations) if durations else 0,
        "max_ms": max(durations) if durations else 0,
        "tagged": sum(1 for s in shots if s.get("tags")),
        "noted": sum(1 for s in shots if s.get("note")),
        "manual_shots": sum(1 for s in shots if s.get("created_manual")),
        "manual_edits": _manual_edits(project),
        "tags": all_tags(project),
        "boundary_count": len(detection.get("boundaries") or []),
    }


def _dir_usage(path: Path) -> tuple[int, int]:
    total = 0
    files = 0
    if not path.exists():
        return 0, 0
    for item in path.rglob("*"):
        if item.is_file():
            try:
                total += item.stat().st_size
                files += 1
            except OSError:
                pass
    return total, files


def cache_usage() -> dict:
    result = {}
    for name, path in (
        ("analysis", analysis_dir()),
        ("thumbs", thumbs_dir()),
        ("previews", previews_dir()),
        ("exports", exports_dir()),
        ("samples", samples_dir()),
    ):
        size, files = _dir_usage(path)
        result[name] = {"bytes": size, "files": files, "path": str(path)}
    result["projects"] = {
        "files": len(list(projects_dir().glob("*.json"))),
        "path": str(projects_dir()),
    }
    return result


def clear_cache(what: str = "all") -> dict:
    targets = {
        "analysis": analysis_dir(),
        "thumbs": thumbs_dir(),
        "previews": previews_dir(),
        "exports": exports_dir(),
        "samples": samples_dir(),
    }
    if what == "all":
        selected = list(targets.items())
    elif what in targets:
        selected = [(what, targets[what])]
    else:
        raise StoreError("未知的缓存类型")
    removed = []
    for name, path in selected:
        if path.exists():
            shutil.rmtree(path, ignore_errors=True)
        path.mkdir(parents=True, exist_ok=True)
        removed.append({"name": name, "path": str(path)})
    if any(name == "samples" for name, _ in selected):
        (samples_dir() / "sample_manifest.json").unlink(missing_ok=True)
    return {"removed": removed}
