"""Session and project-file management.

A session is a working directory under WORKSPACE_ROOT holding original uploads
(never modified), generated previews and cached fusion results. Project files
are self-contained JSON: images are embedded as base64 so a saved project can
be reopened on another machine / clean workspace.
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from dataclasses import asdict
from pathlib import Path

import cv2
import numpy as np

from . import engine
from .engine import GhostMark, GroupState, ImageInfo

WORKSPACE_ROOT = Path(os.environ.get("HDRTOOL_WORKSPACE",
                                     Path(__file__).resolve().parent.parent / "workspace"))


def _secure_filename(name: str) -> str:
    """Path-traversal-safe filename (local replacement for werkzeug's helper).

    Non-ASCII characters are replaced too, so stored names and their download
    URLs stay percent-encodable; the original name is kept in metadata/records.
    """
    name = os.path.basename(name.replace("\\", "/"))
    cleaned = "".join(c if (c.isascii() and (c.isalnum() or c in ".-_"))
                      else "_" for c in name).strip("._")
    return cleaned[:120]


class Session:
    """One open project, backed by a directory on disk."""

    def __init__(self, session_id: str | None = None):
        self.session_id = session_id or uuid.uuid4().hex[:12]
        self.dir = WORKSPACE_ROOT / self.session_id
        self.images_dir = self.dir / "images"
        self.preview_dir = self.dir / "previews"
        self.images_dir.mkdir(parents=True, exist_ok=True)
        self.preview_dir.mkdir(parents=True, exist_ok=True)
        # image_id -> ImageInfo
        self.info: dict[str, ImageInfo] = {}
        # image_id -> original BGR uint8 cache
        self._cache: dict[str, np.ndarray] = {}
        # group_id -> aligned BGR frames (instance-local, never shared)
        self._aligned_cache: dict[str, list[np.ndarray]] = {}
        self.groups: dict[str, GroupState] = {}
        self._lock = threading.RLock()

    # ------------------------------------------------------------------
    # Images
    # ------------------------------------------------------------------

    def add_image(self, filename: str, data: bytes) -> ImageInfo:
        image_id = uuid.uuid4().hex[:10]
        safe = _secure_filename(filename) or f"{image_id}.jpg"
        path = self.images_dir / f"{image_id}_{safe}"
        path.write_bytes(data)

        img = engine.read_image_bgr(str(path))
        exif = engine.read_exif(str(path))
        h, w = img.shape[:2]
        info = ImageInfo(
            image_id=image_id,
            filename=safe,
            width=w,
            height=h,
            ev=exif["ev"],
            ev_source="exif" if exif["ev"] is not None else "unknown",
            exposure_time=exif["exposure_time"],
            f_number=exif["f_number"],
            iso=exif["iso"],
        )
        self.info[image_id] = info
        self._cache[image_id] = img
        self._write_thumb(image_id)
        return info

    def _write_thumb(self, image_id: str) -> Path:
        img = self.get_image(image_id)
        thumb = engine.make_thumbnail(img)
        p = self.preview_dir / f"{image_id}_thumb.jpg"
        p.write_bytes(engine.image_to_jpeg_bytes(thumb, 82))
        return p

    def thumb_path(self, image_id: str) -> Path:
        p = self.preview_dir / f"{image_id}_thumb.jpg"
        if not p.exists():
            self._write_thumb(image_id)
        return p

    def image_path(self, image_id: str) -> Path:
        info = self.info[image_id]
        matches = list(self.images_dir.glob(f"{image_id}_*"))
        if matches:
            return matches[0]
        raise FileNotFoundError(info.filename)

    def get_image(self, image_id: str) -> np.ndarray:
        if image_id not in self._cache:
            self._cache[image_id] = engine.read_image_bgr(
                str(self.image_path(image_id)))
        return self._cache[image_id]

    def remove_image(self, image_id: str) -> None:
        with self._lock:
            self.info.pop(image_id, None)
            self._cache.pop(image_id, None)
            for p in self.images_dir.glob(f"{image_id}_*"):
                p.unlink(missing_ok=True)
            for p in self.preview_dir.glob(f"{image_id}_*"):
                p.unlink(missing_ok=True)
            for g in self.groups.values():
                if image_id in g.image_ids:
                    idx = g.image_ids.index(image_id)
                    g.image_ids.pop(idx)
                    g.order = [i for i in g.order if i != idx]
                    g.order = [i - (1 if i > idx else 0) for i in g.order]
                    g.marks = [m for m in g.marks if m.source_index != idx]
                    g.marks = [GhostMark(m.mark_id, m.points,
                                         m.source_index - (1 if m.source_index > idx else 0),
                                         m.label) for m in g.marks]

    # ------------------------------------------------------------------
    # Groups
    # ------------------------------------------------------------------

    def create_group(self, name: str, image_ids: list[str]) -> GroupState:
        gid = uuid.uuid4().hex[:10]
        ids = [i for i in image_ids if i in self.info]
        group = GroupState(group_id=gid, name=name, image_ids=ids,
                           order=list(range(len(ids))))
        self.groups[gid] = group
        self.sort_group_by_ev(gid)
        return group

    def get_group(self, gid: str) -> GroupState:
        if gid not in self.groups:
            raise KeyError(f"分组不存在: {gid}")
        return self.groups[gid]

    def ordered_images(self, group: GroupState) -> list[np.ndarray]:
        return [self.get_image(group.image_ids[i]) for i in group.order]

    def ordered_infos(self, group: GroupState) -> list[ImageInfo]:
        return [self.info[group.image_ids[i]] for i in group.order]

    def sort_group_by_ev(self, gid: str) -> list[float]:
        """Order dark→bright using EXIF EV, estimating missing values."""
        group = self.get_group(gid)
        imgs = [self.get_image(i) for i in group.image_ids]
        known = [self.info[i].ev for i in group.image_ids]
        if all(v is not None for v in known):
            evs = known
            source = "exif"
        else:
            evs = engine.estimate_evs(imgs)
            source = "estimated"
        order = sorted(range(len(group.image_ids)), key=lambda k: -evs[k])  # high EV = dark first
        group.order = order
        for idx, iid in enumerate(group.image_ids):
            inf = self.info[iid]
            inf.ev = float(evs[idx])
            inf.ev_source = source if inf.ev_source != "exif" else "exif"
        return [float(evs[i]) for i in order]

    def move_frame(self, gid: str, from_pos: int, to_pos: int) -> None:
        group = self.get_group(gid)
        if not (0 <= from_pos < len(group.order) and 0 <= to_pos < len(group.order)):
            raise ValueError("调整位置超出范围")
        order = group.order
        order.insert(to_pos, order.pop(from_pos))
        group.order = order

    # ------------------------------------------------------------------
    # Alignment / marks / fusion orchestration
    # ------------------------------------------------------------------

    def align_group(self, gid: str) -> dict:
        group = self.get_group(gid)
        imgs = self.ordered_images(group)
        if len(imgs) < 2:
            raise ValueError("分组内至少需要两张照片")
        shapes = {im.shape[:2] for im in imgs}
        size_issues = [self.ordered_infos(group)[i].filename
                       for i, im in enumerate(imgs)
                       if im.shape[:2] != imgs[0].shape[:2]]
        if size_issues:
            for i, inf in enumerate(self.ordered_infos(group)):
                if inf.filename in size_issues:
                    inf.status, inf.message = "error", "尺寸与其他照片不一致，无法参与对齐"
        aligned, shifts, reports = engine.align_images(imgs)
        for inf, shift, rep in zip(self.ordered_infos(group), shifts, reports):
            inf.shift = shift
            inf.aligned = rep["aligned"]
            inf.status = rep["status"]
            inf.message = rep["message"]
        # Cache aligned frames for fusion / preview use.
        self._aligned_cache[gid] = aligned
        return {"reports": reports,
                "shifts": [list(s) for s in shifts]}

    def get_aligned(self, gid: str) -> list[np.ndarray]:
        cached = self._aligned_cache.get(gid)
        return cached if cached else self.ordered_images(self.get_group(gid))

    def detect_ghosts(self, gid: str) -> dict:
        group = self.get_group(gid)
        aligned = self.get_aligned(gid)
        pair_masks = engine.detect_ghost_masks(aligned)
        union = engine.union_masks(pair_masks)
        area = int((union > 0).sum())
        overlay = engine.overlay_mask(aligned[len(aligned) // 2], union)
        out_path = self.preview_dir / f"{gid}_ghost.png"
        out_path.write_bytes(engine.image_to_png_bytes(overlay))
        group.auto_ghost = {"area_px": area,
                            "coverage": round(area / union.size, 4),
                            "mask_path": str(out_path)}
        # Persist the union mask for fusion.
        np.save(self.preview_dir / f"{gid}_ghostmask.npy", union)
        return {"area_px": area, "coverage": group.auto_ghost["coverage"],
                "preview_url": f"/api/sessions/{self.session_id}/ghost-preview/{gid}"}

    def load_ghost_union(self, gid: str) -> np.ndarray | None:
        p = self.preview_dir / f"{gid}_ghostmask.npy"
        if p.exists():
            return np.load(p)
        return None

    def add_mark(self, gid: str, points: list[list[float]],
                 source_index: int, label: str = "") -> GhostMark:
        group = self.get_group(gid)
        if not (0 <= source_index < len(group.order)):
            raise ValueError("重影来源帧序号无效")
        mark = GhostMark(mark_id=uuid.uuid4().hex[:8],
                         points=points, source_index=source_index, label=label)
        group.marks.append(mark)
        return mark

    def update_mark(self, gid: str, mark_id: str,
                    source_index: int | None = None,
                    points: list[list[float]] | None = None) -> None:
        group = self.get_group(gid)
        for m in group.marks:
            if m.mark_id == mark_id:
                if source_index is not None:
                    if not (0 <= source_index < len(group.order)):
                        raise ValueError("重影来源帧序号无效")
                    m.source_index = source_index
                if points is not None:
                    m.points = points
                return
        raise KeyError("标记不存在")

    def delete_mark(self, gid: str, mark_id: str) -> None:
        group = self.get_group(gid)
        group.marks = [m for m in group.marks if m.mark_id != mark_id]

    def set_auto_ghost_used(self, gid: str, used: bool) -> None:
        group = self.get_group(gid)
        if used:
            if group.auto_ghost is None:
                raise ValueError("请先执行重影检测")
        group._auto_used = used  # type: ignore[attr-defined]

    def is_auto_ghost_used(self, gid: str) -> bool:
        return getattr(self.get_group(gid), "_auto_used", False)

    def fuse_group(self, gid: str, use_auto_ghost: bool | None = None) -> dict:
        group = self.get_group(gid)
        aligned = self.get_aligned(gid)
        if use_auto_ghost is None:
            use_auto_ghost = self.is_auto_ghost_used(gid)
        union = self.load_ghost_union(gid) if use_auto_ghost else None
        fused = engine.fuse_exposures(aligned, marks=group.marks,
                                      auto_union=union)
        npy_path = self.preview_dir / f"{gid}_fused.npy"
        np.save(npy_path, fused)
        group.fused_npy = str(npy_path)
        preview = engine.tonemap(engine.downscale_for_preview(fused))
        pv_path = self.preview_dir / f"{gid}_fused_preview.png"
        pv_path.write_bytes(engine.image_to_png_bytes(preview))
        return {"preview_url": f"/api/sessions/{self.session_id}/fused-preview/{gid}",
                "shape": list(fused.shape)}

    def get_fused(self, gid: str) -> np.ndarray:
        group = self.get_group(gid)
        if not group.fused_npy or not Path(group.fused_npy).exists():
            raise ValueError("请先执行合成")
        return np.load(group.fused_npy)

    def tonemap_preview(self, gid: str, params: dict) -> bytes:
        fused = self.get_fused(gid)
        small = engine.downscale_for_preview(fused)
        out = engine.tonemap(small, **params)
        self.get_group(gid).last_params = dict(params)
        return engine.image_to_jpeg_bytes(out, 88)

    # ------------------------------------------------------------------
    # Project save / load / export
    # ------------------------------------------------------------------

    def to_project(self) -> dict:
        with self._lock:
            payload = {
                "format": "hdrtool-project/1",
                "session_id": self.session_id,
                "images": [],
                "groups": [],
            }
            for iid, inf in self.info.items():
                img = self.get_image(iid)
                payload["images"].append({
                    "info": asdict(inf),
                    "data_url": engine.encode_png_data_url(img),
                })
            for gid, g in self.groups.items():
                payload["groups"].append({
                    **asdict(g),
                    "auto_ghost_used": self.is_auto_ghost_used(gid),
                    "auto_ghost_mask": (
                        engine.encode_png_data_url(self.load_ghost_union(gid))
                        if self.load_ghost_union(gid) is not None else None
                    ),
                })
            return payload

    def save_project(self, path: str | Path) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_project(), ensure_ascii=False),
                        encoding="utf-8")
        return path

    @classmethod
    def from_project(cls, payload: dict, new_session: bool = True) -> "Session":
        if payload.get("format") != "hdrtool-project/1":
            raise ValueError("工程文件格式不被支持")
        sess = cls()
        old_to_new: dict[str, str] = {}
        for item in payload["images"]:
            img = engine.decode_data_url(item["data_url"])
            inf = ImageInfo(**item["info"])
            iid = inf.image_id if not new_session else uuid.uuid4().hex[:10]
            old_to_new[item["info"]["image_id"]] = iid
            inf.image_id = iid
            ext = ".png"
            (sess.images_dir / f"{iid}_{inf.filename or 'image'}{ext}").write_bytes(
                engine.image_to_png_bytes(img))
            sess.info[iid] = inf
            sess._cache[iid] = img
            sess._write_thumb(iid)
        for gp in payload["groups"]:
            ids = [old_to_new[i] for i in gp["image_ids"] if i in old_to_new]
            marks = [GhostMark(**m) for m in gp.get("marks", [])]
            g = GroupState(
                group_id=uuid.uuid4().hex[:10] if new_session else gp["group_id"],
                name=gp["name"], image_ids=ids, order=list(gp["order"]),
                marks=marks, auto_ghost=gp.get("auto_ghost"),
                fused_npy=None, last_params=gp.get("last_params"),
            )
            sess.groups[g.group_id] = g
            if gp.get("auto_ghost_mask"):
                mask = engine.decode_data_url(gp["auto_ghost_mask"])
                np.save(sess.preview_dir / f"{g.group_id}_ghostmask.npy",
                        (mask[..., 0] if mask.ndim == 3 else mask))
                g.auto_ghost = g.auto_ghost or {}
            if gp.get("auto_ghost_used"):
                g._auto_used = True  # type: ignore[attr-defined]
            # Replay the persisted per-frame shifts so fusion uses the same
            # aligned geometry without re-running the search.
            sess._replay_alignment(g.group_id)
        return sess

    def _replay_alignment(self, gid: str) -> None:
        """Rebuild the aligned-frame cache from stored per-frame shifts."""
        import cv2

        group = self.get_group(gid)
        infos = self.ordered_infos(group)
        if not any(inf.aligned and inf.shift != (0, 0) for inf in infos):
            return
        h, w = self.get_image(group.image_ids[0]).shape[:2]
        aligned = []
        frames = self.ordered_images(group)
        for inf, frame in zip(infos, frames):
            if inf.aligned and inf.shift != (0, 0):
                dx, dy = inf.shift
                m = np.float32([[1, 0, -dx], [0, 1, -dy]])
                frame = cv2.warpAffine(frame, m, (w, h),
                                       flags=cv2.INTER_LINEAR,
                                       borderMode=cv2.BORDER_REFLECT_101)
            aligned.append(frame)
        self._aligned_cache[gid] = aligned

    def export(self, gid: str, out_dir: Path, params: dict) -> dict:
        """Write final 8-bit PNG, 16-bit TIFF and a parameter record JSON."""
        group = self.get_group(gid)
        fused = self.get_fused(gid)
        out8 = engine.tonemap(fused, **params)
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        # ASCII-safe file stem: download URLs must stay percent-encodable.
        base = _secure_filename(group.name) or gid
        png_path = out_dir / f"{base}_hdr.png"
        tiff_path = out_dir / f"{base}_hdr16.tif"
        png_path.write_bytes(engine.image_to_png_bytes(out8))
        engine.save_tiff16(str(tiff_path), out8, fused)
        record = {
            "group": group.name,
            "frames": [
                {"filename": inf.filename, "ev": inf.ev, "ev_source": inf.ev_source,
                 "shift": list(inf.shift), "status": inf.status, "message": inf.message}
                for inf in self.ordered_infos(group)
            ],
            "ghost_marks": [asdict(m) for m in group.marks],
            "auto_ghost_used": self.is_auto_ghost_used(gid),
            "tonemap_params": params,
        }
        rec_path = out_dir / f"{base}_params.json"
        rec_path.write_text(json.dumps(record, ensure_ascii=False, indent=2),
                            encoding="utf-8")
        return {"png": str(png_path), "tiff16": str(tiff_path),
                "params": str(rec_path)}


# ---------------------------------------------------------------------------
# Session registry
# ---------------------------------------------------------------------------


class SessionRegistry:
    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    def create(self) -> Session:
        s = Session()
        with self._lock:
            self._sessions[s.session_id] = s
        return s

    def get(self, sid: str) -> Session:
        with self._lock:
            s = self._sessions.get(sid)
        if s is None:
            raise KeyError("会话不存在或已过期，请重新打开/导入工程")
        return s

    def load_project(self, payload: dict) -> Session:
        s = Session.from_project(payload)
        with self._lock:
            self._sessions[s.session_id] = s
        return s


registry = SessionRegistry()
