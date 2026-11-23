"""两次标定/阈值结果的叠加比较。

用途：调整标尺或阈值后，说明每个孔发生了什么。
孔的命运分三类（对照需求 4 的说法）：

- ``still_hole``       仍作为单独的孔：两版里都是封闭背景连通域；
- ``to_background``    被识别成背景：孔位置在新版里变成零件内部的背景，
  但仍与外部隔绝（典型于阈值变化让孔壁被识别成背景、孔扩大），
  或原孔区域与外部背景之间出现连通 —— 即“跟外部连通”；
- ``to_part``          被识别成零件：原孔位置在新版里被黑色像素填实，
  不再存在背景连通域。

实现上以“背景连通域 + 轮廓点包含”为事实来源，不依赖两版 id 稳定。
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict

import cv2
import numpy as np

from .segmentation import Segmentation, HOLE

STILL_HOLE = "still_hole"
TO_BACKGROUND = "to_background"   # 含“跟外部连通”
TO_PART = "to_part"
NEW_HOLE = "new_hole"

FATE_LABELS = {
    STILL_HOLE: "仍作为单独的孔",
    TO_BACKGROUND: "被识别成背景（含与外部连通）",
    TO_PART: "被识别成零件（孔被填实）",
    NEW_HOLE: "新版新出现的孔",
}


@dataclass
class HoleFate:
    old_hole_id: int | None
    new_hole_id: int | None
    fate: str
    label: str
    centroid_px: list[float]
    old_area_px: int
    new_area_px: int
    connected_to_exterior: bool
    detail: str


@dataclass
class ComponentDiff:
    old_id: int | None
    new_id: int | None
    centroid_px: list[float]
    hole_fates: list[HoleFate] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


@dataclass
class SnapshotDiff:
    matched: list[ComponentDiff] = field(default_factory=list)
    only_in_old: list[dict] = field(default_factory=list)
    only_in_new: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        def conv(o):
            if hasattr(o, "__dataclass_fields__"):
                return asdict(o)
            return o
        return {
            "matched": [conv(c) for c in self.matched],
            "only_in_old": self.only_in_old,
            "only_in_new": self.only_in_new,
            "fate_labels": FATE_LABELS,
        }


def _component_mask(seg: Segmentation, comp_id: int) -> np.ndarray:
    h, w = seg.image_shape
    mask = np.zeros((h, w), dtype=np.uint8)
    cv2.drawContours(mask, [seg.components[comp_id].contour], -1, 1,
                     thickness=cv2.FILLED)
    return mask


def _match_outers(old: Segmentation, new: Segmentation) -> list[tuple[int, int]]:
    """按轮廓重叠（IoU）贪心匹配两版的外层零件。"""
    old_outers = [c.comp_id for c in old.outers()]
    new_outers = [c.comp_id for c in new.outers()]
    if not old_outers or not new_outers:
        return []
    old_masks = {i: _component_mask(old, i) for i in old_outers}
    new_masks = {j: _component_mask(new, j) for j in new_outers}
    pairs = []
    for i in old_outers:
        for j in new_outers:
            inter = int(np.logical_and(old_masks[i], new_masks[j]).sum())
            union = int(np.logical_or(old_masks[i], new_masks[j]).sum())
            iou = inter / union if union else 0.0
            pairs.append((iou, i, j))
    pairs.sort(reverse=True)
    used_old, used_new, matches = set(), set(), []
    for iou, i, j in pairs:
        if iou < 0.2 or i in used_old or j in used_new:
            continue
        used_old.add(i)
        used_new.add(j)
        matches.append((i, j))
    return matches


def _hole_centroid(seg: Segmentation, hole_id: int) -> np.ndarray:
    comp = seg.components[hole_id]
    m = cv2.moments(comp.contour)
    if abs(m["m00"]) < 1e-9:
        x, y, w, h = comp.bbox
        return np.array([x + w / 2, y + h / 2], dtype=float)
    return np.array([m["m10"] / m["m00"], m["m01"] / m["m00"]], dtype=float)


def _classify_old_hole(old_seg: Segmentation, new_seg: Segmentation,
                       old_hole_id: int, new_parent_id: int) -> HoleFate:
    """判断旧版的一个孔在新版里的命运。"""
    old_hc = old_seg.components[old_hole_id]
    centroid = _hole_centroid(old_seg, old_hole_id)
    cx, cy = int(round(centroid[0])), int(round(centroid[1]))
    h, w = new_seg.image_shape
    cx = min(max(cx, 0), w - 1)
    cy = min(max(cy, 0), h - 1)

    new_binary = new_seg.binary  # 0=零件 255=背景
    label_at = new_seg  # noqa: F841（保留可读性）

    # 新版父零件轮廓是否仍包含该孔心
    parent_mask = _component_mask(new_seg, new_parent_id)
    inside_new_parent = bool(parent_mask[cy, cx])

    if new_binary[cy, cx] == 0:
        # 孔心位置现在是零件像素 => 孔被填实
        return HoleFate(
            old_hole_id=old_hole_id, new_hole_id=None, fate=TO_PART,
            label=FATE_LABELS[TO_PART], centroid_px=centroid.tolist(),
            old_area_px=old_hc.hole_area_px, new_area_px=0,
            connected_to_exterior=False,
            detail="孔心在新版中被判为零件像素，原封闭孔消失",
        )

    # 孔心仍是背景：看它属于新版哪个背景连通域
    # 重新算 labels（segment 里没有直接保存 label 图，这里局部重建）
    n_labels, labels = cv2.connectedComponents(new_binary, connectivity=4)
    lab = int(labels[cy, cx])
    bg = new_seg.bg_components.get(lab)
    new_area = int(bg["area_px"]) if bg else 0
    exterior = bool(bg and bg["touches_border"]) if bg else False

    # 是否仍是新版某个被识别出的孔
    new_hole_id = None
    for nh in new_seg.holes_of(new_parent_id):
        if nh.bg_label == lab:
            new_hole_id = nh.comp_id
            break

    if new_hole_id is not None and not exterior:
        fate = STILL_HOLE
        detail = "两版中均为封闭背景连通域，孔保持独立"
    elif exterior:
        fate = TO_BACKGROUND
        detail = "孔与外部背景连通（开口/缺口），不再是封闭孔"
    else:
        fate = TO_BACKGROUND
        detail = "孔区域被判为背景但未被登记为独立孔（通常因轮廓层级变化）"

    return HoleFate(
        old_hole_id=old_hole_id, new_hole_id=new_hole_id, fate=fate,
        label=FATE_LABELS[fate], centroid_px=centroid.tolist(),
        old_area_px=old_hc.hole_area_px, new_area_px=new_area,
        connected_to_exterior=exterior, detail=detail,
    )


def compare_segmentations(old: Segmentation, new: Segmentation) -> SnapshotDiff:
    """比较两版分割结果，输出每个零件下孔的命运。"""
    diff = SnapshotDiff()
    matches = dict(_match_outers(old, new))
    matched_old, matched_new = set(matches.keys()), set(matches.values())

    for old_id, new_id in matches.items():
        cd = ComponentDiff(
            old_id=old_id, new_id=new_id,
            centroid_px=_hole_centroid(old, old_id).tolist()
            if old.components[old_id].child_ids
            else _centroid_safe(old, old_id),
        )
        # 旧孔逐个判定
        for old_hid in old.components[old_id].child_ids:
            cd.hole_fates.append(
                _classify_old_hole(old, new, old_hid, new_id)
            )
        # 新版多出的孔
        old_hole_centroids = [
            _hole_centroid(old, hid) for hid in old.components[old_id].child_ids
        ]
        for new_hid in new.components[new_id].child_ids:
            nc = _hole_centroid(new, new_hid)
            # 已被某个旧孔匹配为 still_hole 的跳过
            if any(hf.new_hole_id == new_hid for hf in cd.hole_fates):
                continue
            nearest = min(
                (float(np.linalg.norm(c - nc)) for c in old_hole_centroids),
                default=1e18,
            )
            new_hc = new.components[new_hid]
            cd.hole_fates.append(HoleFate(
                old_hole_id=None, new_hole_id=new_hid, fate=NEW_HOLE,
                label=FATE_LABELS[NEW_HOLE], centroid_px=nc.tolist(),
                old_area_px=0, new_area_px=new_hc.hole_area_px,
                connected_to_exterior=False,
                detail=("新版新出现的封闭孔" if nearest > 5
                        else "新版中重新被识别为独立孔"),
            ))
        if not cd.hole_fates:
            cd.notes.append("两版均未识别到孔")
        diff.matched.append(cd)

    for cid in [c.comp_id for c in old.outers() if c.comp_id not in matched_old]:
        diff.only_in_old.append({
            "comp_id": cid, "kind": old.components[cid].kind,
            "centroid_px": _centroid_safe(old, cid),
        })
    for cid in [c.comp_id for c in new.outers() if c.comp_id not in matched_new]:
        diff.only_in_new.append({
            "comp_id": cid, "kind": new.components[cid].kind,
            "centroid_px": _centroid_safe(new, cid),
        })
    return diff


def _centroid_safe(seg: Segmentation, comp_id: int) -> list[float]:
    comp = seg.components[comp_id]
    x, y, w, h = comp.bbox
    return [float(x + w / 2), float(y + h / 2)]
