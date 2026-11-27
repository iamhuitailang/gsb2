"""Content-addressed thumbnail cache.

Every thumbnail is addressed by *content*, not by shot index::

    key = sha1(media_fingerprint | start_ms | end_ms | offset_ms | width | version)

Consequences:

* moving a shot boundary changes the key, so a stale image can never be shown
  for the new in/out point ("抽帧错位");
* cache entries are immutable — a partly written file is never served
  (frames are written to a ``.part`` file and renamed atomically);
* the requested time and the PTS ffmpeg actually decoded are stored in a
  sidecar, so the UI can surface residual seek rounding instead of hiding it.

Concurrency is bounded by a semaphore: a grid of thumbnails would otherwise
spawn dozens of ffmpeg processes at once.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path

from . import media
from .store import thumbs_dir

VERSION = 3
_SEMAPHORE = threading.BoundedSemaphore(max(2, min(6, (os.cpu_count() or 4) // 2)))


def cache_key(
    fingerprint: str,
    start_ms: int,
    end_ms: int,
    offset_ms: int,
    width: int,
) -> str:
    seed = f"v{VERSION}|{fingerprint}|{start_ms}|{end_ms}|{offset_ms}|{width}"
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()[:24]


def image_path_for(project_id: str, key: str) -> Path:
    """Public accessor used by the HTTP handler and the exporter."""

    return thumbs_dir() / project_id / f"{key}.jpg"


def _paths(project_id: str, key: str) -> tuple[Path, Path]:
    folder = thumbs_dir() / project_id
    return image_path_for(project_id, key), folder / f"{key}.json"


def read_meta(project_id: str, key: str) -> dict | None:
    _, meta_path = _paths(project_id, key)
    if not meta_path.exists():
        return None
    try:
        with open(meta_path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None


def _sample_offset(duration_ms: int, position: float) -> int:
    """Choose the offset inside a shot for the representative frame.

    ``position`` is a fraction 0..1.  The frame is clamped at least one frame
    inside the shot so a decoded frame can never belong to the neighbouring
    shot because of seek rounding.
    """

    duration = max(1, int(duration_ms))
    position = max(0.0, min(1.0, float(position)))
    offset = int(round(duration * position))
    lead = min(120, max(1, duration // 10))
    if position <= 0:
        offset = lead
    return max(0, min(duration - 1, offset))


def sample_time(start_ms: int, end_ms: int, position: float = 0.35) -> int:
    """Public helper: the exact timeline position a thumbnail would sample."""

    return int(start_ms) + _sample_offset(int(end_ms) - int(start_ms), position)


def thumb_for(
    *,
    project_id: str,
    fingerprint: str,
    media_path: str,
    start_ms: int,
    end_ms: int,
    position: float,
    width: int = 480,
    generate: bool = True,
) -> dict | None:
    """Return a thumbnail descriptor, generating it on demand.

    With ``generate=False`` only an existing entry is returned (or ``None``),
    which lets the UI read the sample time / drift metadata without kicking
    off another extraction.
    """

    duration = max(1, int(end_ms) - int(start_ms))
    offset_ms = _sample_offset(duration, position)
    at_ms = int(start_ms) + offset_ms
    key = cache_key(fingerprint, int(start_ms), int(end_ms), offset_ms, width)
    image_path, meta_path = _paths(project_id, key)

    def read_cached() -> dict | None:
        if not (image_path.exists() and meta_path.exists()):
            return None
        meta = read_meta(project_id, key)
        if meta and meta.get("requested_ms") == at_ms:
            return {**meta, "key": key, "cached": True, "offset_ms": offset_ms}
        return None

    cached = read_cached()
    if cached:
        return cached
    if not generate:
        return None

    with _SEMAPHORE:
        cached = read_cached()  # another request may have finished meanwhile
        if cached:
            return cached
        actual_ms: int | None = None
        try:
            _, actual_ms = media.extract_frame_with_pts(media_path, at_ms, image_path, width=width)
        except media.MediaError:
            # A source that cannot be decoded at this instant still gets a
            # placeholder, so the UI shows "no preview" instead of a broken
            # image or a stale frame from another shot.
            try:
                media.make_placeholder(image_path, width=width)
            except media.MediaError:
                pass
        payload = {
            "key": key,
            "requested_ms": at_ms,
            "actual_ms": actual_ms,
            "start_ms": int(start_ms),
            "end_ms": int(end_ms),
            "offset_ms": offset_ms,
            "width": width,
            "drift_ms": (actual_ms - at_ms) if actual_ms is not None else None,
            "created_at": int(time.time()),
        }
        try:
            image_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = meta_path.with_name(meta_path.name + f".tmp{os.getpid()}")
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False)
            os.replace(tmp, meta_path)
        except OSError:
            pass
        return {**payload, "cached": False}


def project_thumb_stats(project_id: str) -> dict:
    folder = thumbs_dir() / project_id
    if not folder.exists():
        return {"files": 0, "bytes": 0, "path": str(folder)}
    files = 0
    total = 0
    for item in folder.iterdir():
        if item.is_file():
            files += 1
            try:
                total += item.stat().st_size
            except OSError:
                pass
    return {"files": files, "bytes": total, "path": str(folder)}
