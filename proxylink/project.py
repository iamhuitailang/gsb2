"""高层业务操作：登记、挂接、标定、剪辑点、播放头、重挂接、导出。"""

import csv
import io
import json
import os
import uuid

from .errors import (
    CalibrationError,
    DuplicateMediaError,
    LinkError,
    MediaNotFoundError,
    OutOfRangeError,
    SignatureMismatchError,
)
from .mapping import Anchor, Mapping
from .media import full_signature, iter_candidate_paths, verify_candidate
from .store import (
    CutPoint,
    Link,
    Media,
    Session,
    Store,
    media_id_for,
    utc_now_iso,
)
from .timecode import format_smpte, parse_timecode, snap_to_frame


def _short_id(prefix):
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


class Project:
    """对外主接口，CLI 与 Web UI 共用。"""

    def __init__(self, base_dir="."):
        self.store = Store(base_dir)
        self.state = self.store.load()

    # ---- 保存 -------------------------------------------------------

    def save(self):
        self.store.save(self.state)

    # ---- 素材登记 ---------------------------------------------------

    def register(self, path):
        """登记一个素材并探测特征；已登记则直接返回原记录。"""
        media_id = media_id_for(path)
        if media_id in self.state.media:
            raise DuplicateMediaError(f"素材已登记: {media_id}")
        info = full_signature(path)
        media = Media.from_probe(path, info)
        self.state.media[media.id] = media
        self.save()
        return media

    def list_media(self):
        return list(self.state.media.values())

    def media_detail(self, media_id):
        media = self._resolve_media(media_id)
        data = media.to_dict()
        data["exists"] = media.exists
        data["links"] = [
            {"link_id": lk.id, "role": self._link_role(lk, media.id)}
            for lk in self.state.links_for_media(media.id)
        ]
        # 同文件名的其他记录，提示用户这些是不同目录下的不同文件
        data["same_filename_others"] = [
            m.id for m in self.state.find_by_filename(media.filename) if m.id != media.id
        ]
        return data

    def _link_role(self, link, media_id):
        if link.original_id == media_id:
            return "original"
        return "proxy"

    def check_files(self):
        """检查所有已登记文件是否仍在原位。"""
        return [
            {"id": m.id, "filename": m.filename, "path": m.path, "exists": m.exists}
            for m in self.state.media.values()
        ]

    def _resolve_media(self, ref):
        """id、绝对路径或文件名都可作为素材引用；同名多文件时报歧义。"""
        # 1. 精确匹配已登记的 id（id 即规范化绝对路径）
        if ref in self.state.media:
            return self.state.media[ref]
        ap = os.path.realpath(os.path.abspath(os.path.expanduser(ref)))
        if ap in self.state.media:
            return self.state.media[ap]
        # 2. 退而求其次按文件名匹配；多个同名时要求用完整路径消歧
        matches = self.state.find_by_filename(os.path.basename(ref))
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise MediaNotFoundError(
                f"文件名 {os.path.basename(ref)!r} 在库中有多个登记记录，"
                f"请用完整路径指定: {[m.path for m in matches]}"
            )
        raise MediaNotFoundError(f"未登记的素材: {ref}")

    # ---- 挂接与标定 -------------------------------------------------

    def create_link(self, original_ref, proxy_ref, label=""):
        original = self._resolve_media(original_ref)
        proxy = self._resolve_media(proxy_ref)
        if original.id == proxy.id:
            raise LinkError("原片与代理不能是同一个文件")
        for lk in self.state.links.values():
            if lk.original_id == original.id and lk.proxy_id == proxy.id:
                raise LinkError(f"挂接已存在: {lk.id}")
        link = Link(
            id=_short_id("link"),
            original_id=original.id,
            proxy_id=proxy.id,
            created_at=utc_now_iso(),
            updated_at=utc_now_iso(),
            label=label,
        )
        self.state.links[link.id] = link
        self.save()
        return link

    def calibrate(self, link_id, anchor_pairs):
        """标定锚点。anchor_pairs 为 [(original_tc, proxy_tc), ...]，1 或 2 对。"""
        link = self._get_link(link_id)
        original = self.state.get_media(link.original_id)
        proxy = self.state.get_media(link.proxy_id)
        pairs = [
            (
                parse_timecode(o, original.fps),
                parse_timecode(p, proxy.fps),
            )
            for o, p in anchor_pairs
        ]
        mapping = Mapping.build(original, proxy, [Anchor(o, p) for o, p in pairs])
        link.calibration = mapping.to_dict()
        link.updated_at = utc_now_iso()
        self.save()
        return mapping

    def link_status(self, link_id):
        """挂接详情 + 可靠区间/首尾匹配报告。"""
        link = self._get_link(link_id)
        original = self.state.get_media(link.original_id)
        proxy = self.state.get_media(link.proxy_id)
        result = {
            "link_id": link.id,
            "label": link.label,
            "original": self.media_detail(original.id),
            "proxy": self.media_detail(proxy.id),
            "calibrated": bool(link.calibration.get("anchors")),
        }
        if result["calibrated"]:
            mapping = link.mapping(self.state.media)
            result["calibration"] = link.calibration
            result["coverage"] = mapping.coverage()
        return result

    def locate(self, link_id, side, timecode):
        """定位检查：给出对应画面时间，越界时返回明确原因。"""
        link = self._get_link(link_id)
        mapping = link.mapping(self.state.media)
        source_fps = (self.state.get_media(link.original_id).fps
                      if side == "original"
                      else self.state.get_media(link.proxy_id).fps)
        t = parse_timecode(timecode, source_fps)
        return mapping.locate(side, t)

    def _get_link(self, link_id):
        lk = self.state.links.get(link_id)
        if lk is None:
            raise LinkError(f"挂接不存在: {link_id}")
        return lk

    # ---- 剪辑点 -----------------------------------------------------

    def add_cut_point(self, link_id, timecode, side="original", label=""):
        """添加剪辑点。可从原片时间或代理时间录入，均换算为原片时间并留溯源。"""
        link = self._get_link(link_id)
        original = self.state.get_media(link.original_id)
        proxy = self.state.get_media(link.proxy_id)
        mapping = link.mapping(self.state.media)

        if side == "original":
            o_t = parse_timecode(timecode, original.fps)
            loc = mapping.locate("original", o_t)
            if not loc["ok"]:
                raise OutOfRangeError(loc["reason"])
            p_t = loc["mapped"]
        elif side == "proxy":
            p_t = parse_timecode(timecode, proxy.fps)
            loc = mapping.locate("proxy", p_t)
            if not loc["ok"]:
                raise OutOfRangeError(loc["reason"])
            o_t = loc["mapped"]
        else:
            raise CalibrationError(f"未知 side: {side}")

        # 再次确认剪辑点落在原片可靠区间内
        coverage = mapping.coverage()
        rel_lo, rel_hi = coverage["original"]["reliable_range"]
        reliable = rel_lo - 0.5 / max(original.fps, 1) <= o_t <= rel_hi + 0.5 / max(original.fps, 1)
        note = "" if reliable else "该点位于原片不可可靠定位区间，请人工复核"

        cp = CutPoint(
            id=_short_id("cut"),
            link_id=link.id,
            original_time=o_t,
            proxy_time=p_t,
            rate=mapping.rate,
            label=label,
            created_at=utc_now_iso(),
            reliable=reliable,
            note=note,
            source={
                "entered_from": side,
                "entered_timecode": str(timecode),
                "proxy_id": proxy.id,
                "proxy_filename": proxy.filename,
                "proxy_path": proxy.path,
                "proxy_time": p_t,
                "original_id": original.id,
                "original_filename": original.filename,
                "original_time": o_t,
                "anchor_original": mapping.anchor1.original,
                "anchor_proxy": mapping.anchor1.proxy,
                "rate": mapping.rate,
            },
        )
        self.state.cut_points.append(cp)
        self.save()
        return cp

    def remove_cut_point(self, cut_id):
        before = len(self.state.cut_points)
        self.state.cut_points = [c for c in self.state.cut_points if c.id != cut_id]
        if len(self.state.cut_points) == before:
            raise MediaNotFoundError(f"剪辑点不存在: {cut_id}")
        self.save()

    def list_cut_points(self, link_id=None):
        pts = self.state.cut_points
        if link_id:
            pts = [c for c in pts if c.link_id == link_id]
        return sorted(pts, key=lambda c: c.original_time)

    # ---- 播放头 -----------------------------------------------------

    def _require_session(self, link_id=None):
        if self.state.session is None:
            if link_id is None:
                raise LinkError("还没有播放会话，请先指定挂接并 seek")
            link = self._get_link(link_id)
            self.state.session = Session(link_id=link.id)
        if link_id and self.state.session.link_id != link_id:
            link = self._get_link(link_id)
            self.state.session = Session(link_id=link.id)
        return self.state.session

    def seek(self, link_id, timecode, side="original"):
        """定位播放头，自动换算另一端时间；越界即停止并给出原因。"""
        link = self._get_link(link_id)
        original = self.state.get_media(link.original_id)
        proxy = self.state.get_media(link.proxy_id)
        mapping = link.mapping(self.state.media)
        session = self._require_session(link.id)

        if side == "original":
            t = parse_timecode(timecode, original.fps)
            loc = mapping.locate("original", t)
            if not loc["ok"]:
                session.stopped = True
                session.stop_reason = loc["reason"]
                self.save()
                return self._session_view(session, mapping, original, proxy)
            session.original_time = snap_to_frame(t, original.fps) if original.fps else t
            session.proxy_time = loc["mapped"]
        else:
            t = parse_timecode(timecode, proxy.fps)
            loc = mapping.locate("proxy", t)
            if not loc["ok"]:
                session.stopped = True
                session.stop_reason = loc["reason"]
                self.save()
                return self._session_view(session, mapping, original, proxy)
            session.proxy_time = snap_to_frame(t, proxy.fps) if proxy.fps else t
            session.original_time = loc["mapped"]

        session.side = side
        session.stopped = False
        session.stop_reason = ""
        self.save()
        return self._session_view(session, mapping, original, proxy)

    def switch_side(self, link_id=None, clamp=False):
        """切换原片/代理，保持指向同一画面。

        默认越界直接停止；clamp=True 时夹到可用边界并标注原因。
        """
        session = self._require_session(link_id)
        link = self._get_link(session.link_id)
        original = self.state.get_media(link.original_id)
        proxy = self.state.get_media(link.proxy_id)
        mapping = link.mapping(self.state.media)

        target = "proxy" if session.side == "original" else "original"
        try:
            if target == "proxy":
                mapped = mapping.original_to_proxy(session.original_time, clamp=clamp)
                session.proxy_time = mapped
            else:
                mapped = mapping.proxy_to_original(session.proxy_time, clamp=clamp)
                session.original_time = mapped
            session.side = target
            session.stopped = False
            session.stop_reason = ""
        except OutOfRangeError as exc:
            session.stopped = True
            session.stop_reason = str(exc)
        self.save()
        return self._session_view(session, mapping, original, proxy)

    def tick(self, delta_seconds):
        """播放推进 delta 秒（负数为后退）。到达可用范围边界时明确停止。"""
        session = self._require_session()
        link = self._get_link(session.link_id)
        original = self.state.get_media(link.original_id)
        proxy = self.state.get_media(link.proxy_id)
        mapping = link.mapping(self.state.media)

        if session.stopped and delta_seconds > 0:
            return self._session_view(session, mapping, original, proxy)

        if session.side == "original":
            new_t = session.original_time + delta_seconds
            if new_t < 0:
                new_t = 0.0
            if new_t > original.duration:
                session.original_time = original.duration
                session.proxy_time = mapping.original_to_proxy(original.duration, clamp=True)
                session.stopped = True
                session.stop_reason = (
                    f"已到达原片末尾 {original.duration:.3f}s，播放停止"
                )
            else:
                loc = mapping.locate("original", new_t)
                if not loc["ok"]:
                    session.stopped = True
                    session.stop_reason = loc["reason"]
                else:
                    session.original_time = new_t
                    session.proxy_time = loc["mapped"]
                    session.stopped = False
                    session.stop_reason = ""
        else:
            new_t = session.proxy_time + delta_seconds
            if new_t < 0:
                new_t = 0.0
            if new_t > proxy.duration:
                session.proxy_time = proxy.duration
                session.original_time = mapping.proxy_to_original(proxy.duration, clamp=True)
                session.stopped = True
                session.stop_reason = (
                    f"代理素材在 {proxy.duration:.3f}s 结束，对应原片之后的画面缺失，播放停止"
                )
            else:
                loc = mapping.locate("proxy", new_t)
                if not loc["ok"]:
                    session.stopped = True
                    session.stop_reason = loc["reason"]
                else:
                    session.proxy_time = new_t
                    session.original_time = loc["mapped"]
                    session.stopped = False
                    session.stop_reason = ""

        self.save()
        return self._session_view(session, mapping, original, proxy)

    def stop(self):
        session = self._require_session()
        session.stopped = True
        session.stop_reason = "用户手动停止"
        self.save()

    def session_view(self):
        if self.state.session is None:
            return None
        session = self.state.session
        link = self._get_link(session.link_id)
        mapping = link.mapping(self.state.media)
        original = self.state.get_media(link.original_id)
        proxy = self.state.get_media(link.proxy_id)
        return self._session_view(session, mapping, original, proxy)

    def _session_view(self, session, mapping, original, proxy):
        coverage = mapping.coverage()
        return {
            "link_id": session.link_id,
            "side": session.side,
            "stopped": session.stopped,
            "stop_reason": session.stop_reason,
            "original": {
                "time": session.original_time,
                "timecode": format_smpte(session.original_time, original.fps),
                "duration": original.duration,
                "frame": round(session.original_time * original.fps) if original.fps else None,
            },
            "proxy": {
                "time": session.proxy_time,
                "timecode": format_smpte(session.proxy_time, proxy.fps),
                "duration": proxy.duration,
                "frame": round(session.proxy_time * proxy.fps) if proxy.fps else None,
            },
            "reliable_original_range": coverage["original"]["reliable_range"],
        }

    # ---- 重挂接 -----------------------------------------------------

    def find_relink_candidates(self, media_ref, search_dir):
        """按原文件名在新目录递归找候选，并逐个做特征比对。"""
        media = self._resolve_media(media_ref)
        expected = media.to_dict()
        results = []
        for cand in iter_candidate_paths(search_dir, media.filename):
            report = verify_candidate(cand, expected)
            report["path"] = cand
            results.append(report)
        return results

    def relink(self, media_ref, new_path, force=False):
        """把素材重新挂接到移动后的文件。特征不符默认拒绝。"""
        media = self._resolve_media(media_ref)
        expected = media.to_dict()
        report = verify_candidate(new_path, expected)
        if report["verdict"] != "match" and not force:
            failed = [c for c in report["checks"] if not c["ok"]]
            raise SignatureMismatchError(
                f"候选文件与原素材特征不符，已拒绝挂接: {new_path}",
                details=failed,
            )
        # 通过后重新探测并更新记录（保留 id 与登记时间）
        info = full_signature(new_path)
        refreshed = Media.from_probe(new_path, info)
        refreshed.id = media.id
        refreshed.registered_at = media.registered_at
        self.state.media[media.id] = refreshed
        self.save()
        return {"media": refreshed, "report": report, "forced": force and report["verdict"] != "match"}

    # ---- 导出 -------------------------------------------------------

    def export_cut_points(self, fmt="json", link_id=None):
        """导出原片时间位置的剪辑点清单，含每个点的代理换算溯源。"""
        points = self.list_cut_points(link_id)
        if fmt == "json":
            return json.dumps(
                {
                    "exported_at": utc_now_iso(),
                    "count": len(points),
                    "cut_points": [self._export_entry(c) for c in points],
                },
                ensure_ascii=False, indent=2,
            )
        if fmt == "csv":
            buf = io.StringIO()
            writer = csv.writer(buf)
            writer.writerow([
                "cut_id", "label", "original_filename", "original_time",
                "original_timecode", "proxy_filename", "proxy_time",
                "proxy_timecode", "rate", "reliable", "note",
            ])
            for c in points:
                original = self.state.get_media(c.source["original_id"])
                proxy = self.state.get_media(c.source["proxy_id"])
                writer.writerow([
                    c.id, c.label, original.filename,
                    f"{c.original_time:.3f}",
                    format_smpte(c.original_time, original.fps),
                    proxy.filename, f"{c.proxy_time:.3f}",
                    format_smpte(c.proxy_time, proxy.fps),
                    f"{c.rate:.6f}", c.reliable, c.note,
                ])
            return buf.getvalue()
        if fmt == "md":
            lines = [
                "# 剪辑点清单（原片时间位置）",
                "",
                f"导出时间：{utc_now_iso()}　共 {len(points)} 个点",
                "",
                "| ID | 标注 | 原片文件 | 原片时间码 | 来源代理 | 代理时间码 | 走时比 | 可靠 | 备注 |",
                "|----|------|----------|------------|----------|------------|--------|------|------|",
            ]
            for c in points:
                original = self.state.get_media(c.source["original_id"])
                proxy = self.state.get_media(c.source["proxy_id"])
                lines.append(
                    f"| {c.id} | {c.label or ''} | {original.filename} | "
                    f"{format_smpte(c.original_time, original.fps)} | "
                    f"{proxy.filename} | {format_smpte(c.proxy_time, proxy.fps)} | "
                    f"{c.rate:.6f} | {'是' if c.reliable else '否'} | {c.note} |"
                )
            lines.append("")
            lines.append("## 换算溯源")
            for c in points:
                s = c.source
                lines.append(
                    f"- `{c.id}`：由代理 **{s['proxy_filename']}** 的 "
                    f"{format_smpte(s['proxy_time'], self.state.get_media(s['proxy_id']).fps)}"
                    f"（{s['proxy_time']:.3f}s）经标定 "
                    f"(原片 {s['anchor_original']:.3f}s ↔ 代理 {s['anchor_proxy']:.3f}s, "
                    f"rate={s['rate']:.6f}) 换算为原片 **{s['original_filename']}** 的 "
                    f"{s['original_time']:.3f}s"
                )
            return "\n".join(lines) + "\n"
        raise ValueError(f"不支持的导出格式: {fmt}")

    def _export_entry(self, cut):
        original = self.state.get_media(cut.source["original_id"])
        proxy = self.state.get_media(cut.source["proxy_id"])
        return {
            "cut_id": cut.id,
            "label": cut.label,
            "reliable": cut.reliable,
            "note": cut.note,
            "original": {
                "filename": original.filename,
                "path": original.path,
                "time": cut.original_time,
                "timecode": format_smpte(cut.original_time, original.fps),
                "frame": round(cut.original_time * original.fps) if original.fps else None,
            },
            "derived_from": {
                "proxy_filename": proxy.filename,
                "proxy_path": proxy.path,
                "proxy_time": cut.proxy_time,
                "proxy_timecode": format_smpte(cut.proxy_time, proxy.fps),
                "proxy_frame": round(cut.proxy_time * proxy.fps) if proxy.fps else None,
                "calibration": {
                    "anchor_original": cut.source["anchor_original"],
                    "anchor_proxy": cut.source["anchor_proxy"],
                    "rate": cut.rate,
                },
                "entered_from": cut.source["entered_from"],
            },
        }
