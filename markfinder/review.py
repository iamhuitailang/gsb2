"""人工复核状态：确认/误报、阈值重算保留决策、逐图隔离、修订日志。"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .candidates import Match
from .geometry import angle_diff


def image_identity(image_path: str | Path, image_shape: tuple[int, ...] | None = None) -> str:
    """生成图片身份键。

    键里包含绝对路径、尺寸与修改时间：两张不同的图即使文件名相同也不会串状态。
    若拿不到文件信息（合成图等），调用方可直接传入自定义前缀。
    """
    p = Path(image_path)
    try:
        st = p.stat()
        mtime_ns = st.st_mtime_ns
    except OSError:
        mtime_ns = 0
    shape_part = f"-{tuple(image_shape)}" if image_shape else ""
    return f"{p.resolve()}{shape_part}@{mtime_ns}"


@dataclass
class ImageState:
    """单张目标图的复核状态。"""

    image_key: str
    image_path: str
    matches: list[Match] = field(default_factory=list)
    decisions: dict[str, dict] = field(default_factory=dict)
    revisions: list[dict] = field(default_factory=list)
    last_params: dict = field(default_factory=dict)
    last_threshold: float = 0.0

    def log(self, action: str, detail: dict) -> None:
        self.revisions.append(
            {
                "time": time.strftime("%Y-%m-%d %H:%M:%S"),
                "action": action,
                **detail,
            }
        )

    def counts(self) -> dict:
        confirmed = sum(1 for m in self.matches if m.decision == "confirmed")
        false_pos = sum(1 for m in self.matches if m.decision == "false_positive")
        candidates = sum(1 for m in self.matches if m.decision == "candidate")
        return {
            "total": len(self.matches),
            "confirmed": confirmed,
            "false_positive": false_pos,
            "candidate": candidates,
        }


class ReviewStore:
    """管理多张图的复核状态，持久化到一个 JSON 文件。

    状态按 :func:`image_identity` 生成的键隔离，切换图片时只加载该图自己的
    决策；换阈值/重算时，已确认或已排除的结果按位置+朝向重新认回。
    """

    def __init__(self, state_path: str | Path | None = None):
        self.state_path = Path(state_path) if state_path else None
        self.images: dict[str, ImageState] = {}
        if self.state_path and self.state_path.exists():
            self.load()

    # ---------- 持久化 ----------
    def load(self) -> None:
        if not self.state_path or not self.state_path.exists():
            return
        with open(self.state_path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        self.images = {}
        for key, data in raw.get("images", {}).items():
            st = ImageState(
                image_key=key,
                image_path=data.get("image_path", ""),
                decisions=data.get("decisions", {}),
                revisions=data.get("revisions", []),
                last_params=data.get("last_params", {}),
                last_threshold=data.get("last_threshold", 0.0),
            )
            self.images[key] = st

    def save(self) -> None:
        if not self.state_path:
            return
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "images": {
                key: {
                    "image_path": st.image_path,
                    "decisions": st.decisions,
                    "revisions": st.revisions,
                    "last_params": st.last_params,
                    "last_threshold": st.last_threshold,
                }
                for key, st in self.images.items()
            },
        }
        tmp = self.state_path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        tmp.replace(self.state_path)

    # ---------- 图片切换（严格隔离） ----------
    def get_state(self, image_key: str, image_path: str = "") -> ImageState:
        st = self.images.get(image_key)
        if st is None:
            st = ImageState(image_key=image_key, image_path=image_path)
            self.images[image_key] = st
        elif image_path and not st.image_path:
            st.image_path = image_path
        return st

    def replace_matches(
        self,
        state: ImageState,
        new_matches: list[Match],
        params: dict,
        threshold: float,
        position_tol_px: float,
        angle_tol_deg: float = 15.0,
        scale_tol: float = 0.15,
    ) -> list[Match]:
        """用新一轮查找结果替换候选，同时把旧决策认回到新候选上。

        认回条件（同一物理标记）：
        中心距 < position_tol_px、翻面属性一致、角度差 < angle_tol_deg、
        缩放差 < scale_tol。多个旧决策争一个新候选时取最近的。
        没有被任何新候选认回的旧决策保留为“丢失”修订记录，不自动复活。
        """
        old_saved = [
            d for d in state.decisions.values() if d.get("decision") in ("confirmed", "false_positive")
        ]
        used: set[str] = set()
        carried = 0
        for m in new_matches:
            best_key = None
            best_dist = float("inf")
            for d in old_saved:
                if d["id"] in used or d.get("flipped") != m.flipped:
                    continue
                dist = float(np.hypot(d["x"] - m.x, d["y"] - m.y))
                if dist > position_tol_px:
                    continue
                if abs(angle_diff(float(d["angle"]), m.angle)) > angle_tol_deg:
                    continue
                if abs(float(d["scale"]) - m.scale) > scale_tol:
                    continue
                if dist < best_dist:
                    best_dist, best_key = dist, d["id"]
            if best_key is not None:
                old = next(d for d in old_saved if d["id"] == best_key)
                used.add(best_key)
                m.decision = old["decision"]
                m.note = old.get("note", "")
                carried += 1

        missing = [d for d in old_saved if d["id"] not in used]
        state.log(
            "rerun",
            {
                "threshold": threshold,
                "params": params,
                "new_candidates": len(new_matches),
                "decisions_carried": carried,
                "decisions_missing": len(missing),
                "missing": [
                    {"x": d["x"], "y": d["y"], "angle": d["angle"], "decision": d["decision"]}
                    for d in missing
                ],
            },
        )
        state.matches = new_matches
        state.last_params = params
        state.last_threshold = threshold
        # 决策表与当前候选保持同步（含位置刷新），丢失项作为修订记录留在日志里
        state.decisions = {
            m.id: {
                "id": m.id,
                "x": round(m.x, 3),
                "y": round(m.y, 3),
                "angle": round(m.angle, 2),
                "scale": round(m.scale, 4),
                "flipped": m.flipped,
                "decision": m.decision,
                "note": m.note,
            }
            for m in state.matches
        }
        return new_matches

    def set_decision(
        self, state: ImageState, match_id: str, decision: str, note: str | None = None
    ) -> None:
        """人工标记：confirmed（确实匹配）/ false_positive（误报）/ candidate（撤销）。"""
        if decision not in ("confirmed", "false_positive", "candidate"):
            raise ValueError(f"非法决策: {decision}")
        target = next((m for m in state.matches if m.id == match_id), None)
        if target is None:
            raise KeyError(f"找不到候选 {match_id}")
        before = target.decision
        target.decision = decision
        if note is not None:
            target.note = note
        state.decisions[match_id] = {
            "id": match_id,
            "x": round(target.x, 3),
            "y": round(target.y, 3),
            "angle": round(target.angle, 2),
            "scale": round(target.scale, 4),
            "flipped": target.flipped,
            "decision": decision,
            "note": target.note,
        }
        state.log(
            "decision",
            {
                "match_id": match_id,
                "from": before,
                "to": decision,
                "x": round(target.x, 2),
                "y": round(target.y, 2),
                "angle": round(target.angle, 2),
            },
        )

    def apply_threshold_filter(self, state: ImageState, threshold: float) -> None:
        """只调阈值不重算：低于阈值的候选隐藏，已确认项永远保留可见。

        隐藏候选的决策不删除；记录一条阈值修订日志。
        """
        for m in state.matches:
            m.hidden = m.score < threshold and m.decision != "confirmed"
        state.log("threshold_filter", {"threshold": threshold})
