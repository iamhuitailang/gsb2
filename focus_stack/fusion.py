"""融合输出：合成图、来源图、点击回看、覆盖区处理。

- hard_composite: 按标签图直接选像素，边界是硬切换（用于边缘检查对比）
- soft_composite: 按 softmax 权重混合，交界柔和
- source_map:     标签图着色成“来源图”，颜色与各源编号一一对应
- inspect_point:  点击合成图任一点，回看该点倾向用哪张源、各源清晰度差异
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .geometry import crop_to_mask
from .registration import EDGE_COLORS_BGR
from .selection import INVALID_LABEL
from .sharpness import relative_scores

# 来源图配色（BGR，尽量彼此区分度高）
SOURCE_COLORS_BGR = [
    (200, 90, 30),    # 蓝
    (30, 170, 30),    # 绿
    (30, 30, 220),    # 红
    (220, 30, 220),   # 品红
    (30, 200, 220),   # 黄
    (200, 200, 30),   # 青
    (120, 30, 180),   # 紫
    (60, 120, 60),    # 暗绿
]
INVALID_COLOR_BGR = (0, 0, 0)


@dataclass
class FusionResult:
    composite: np.ndarray           # BGR uint8
    source_map: np.ndarray          # BGR uint8，标签着色
    labels: np.ndarray              # int32 (H,W)，-1 为无效
    weights: np.ndarray             # float32 (N,H,W)
    mode: str                       # "hard" | "soft"
    valid_mask: np.ndarray          # uint8 0/255
    bbox: tuple | None = None       # 裁剪模式下记录 (x0,y0,x1,y1)


def hard_composite(aligned_bgr: list[np.ndarray], labels: np.ndarray,
                   valid_mask: np.ndarray) -> np.ndarray:
    n = len(aligned_bgr)
    h, w = labels.shape
    out = np.zeros((h, w, 3), np.uint8)
    for i in range(n):
        m = (labels == i)
        if m.any():
            out[m] = aligned_bgr[i][m]
    out[valid_mask == 0] = 0
    return out


def soft_composite(aligned_bgr: list[np.ndarray], weights: np.ndarray,
                   valid_mask: np.ndarray) -> np.ndarray:
    h, w = valid_mask.shape
    acc = np.zeros((h, w, 3), np.float32)
    for i, img in enumerate(aligned_bgr):
        wi = weights[i][..., None]
        acc += img.astype(np.float32) * wi
    out = np.clip(np.rint(acc), 0, 255).astype(np.uint8)
    out[valid_mask == 0] = 0
    return out


def source_map(labels: np.ndarray, n_sources: int,
               valid_mask: np.ndarray) -> np.ndarray:
    h, w = labels.shape
    out = np.zeros((h, w, 3), np.uint8)
    for i in range(n_sources):
        out[labels == i] = SOURCE_COLORS_BGR[i % len(SOURCE_COLORS_BGR)]
    out[valid_mask == 0] = INVALID_COLOR_BGR
    return out


def source_legend(n_sources: int) -> list[tuple[int, tuple[int, int, int]]]:
    return [(i, SOURCE_COLORS_BGR[i % len(SOURCE_COLORS_BGR)])
            for i in range(n_sources)]


def edge_regions(labels: np.ndarray, valid_mask: np.ndarray) -> np.ndarray:
    """硬边界图：标签变化处画白线，无效区画灰斜线底，供边缘检查页使用。"""
    h, w = labels.shape
    out = np.zeros((h, w, 3), np.uint8)
    diff = np.zeros((h, w), bool)
    diff[:, 1:] |= (labels[:, 1:] != labels[:, :-1]) & (labels[:, 1:] != INVALID_LABEL) \
        & (labels[:, :-1] != INVALID_LABEL)
    diff[1:, :] |= (labels[1:, :] != labels[:-1, :]) & (labels[1:, :] != INVALID_LABEL) \
        & (labels[:-1, :] != INVALID_LABEL)
    out[diff] = (255, 255, 255)
    out[valid_mask == 0] = (60, 60, 60)
    return out


def apply_coverage(result_images: list[np.ndarray], valid_mask: np.ndarray,
                   mode: str) -> tuple[list[np.ndarray], tuple | None]:
    """覆盖区处理。

    mode="crop":   裁到所有源共同覆盖的外接矩形
    mode="keep":   保留全帧，无效区保持 0（界面另用 coverage 叠加标明）
    """
    if mode == "keep":
        return result_images, None
    if mode != "crop":
        raise ValueError(f"未知覆盖模式: {mode}")
    cropped, _, bbox = crop_to_mask(result_images[0], valid_mask)
    out = [cropped]
    for img in result_images[1:]:
        out.append(img[bbox[1]:bbox[3], bbox[0]:bbox[2]].copy())
    return out, bbox


def fuse(aligned_bgr: list[np.ndarray], labels: np.ndarray,
         weights: np.ndarray, valid_mask: np.ndarray,
         mode: str = "soft", coverage: str = "keep") -> FusionResult:
    """一站式融合。mode: hard/soft；coverage: keep/crop。"""
    if mode == "hard":
        comp = hard_composite(aligned_bgr, labels, valid_mask)
    elif mode == "soft":
        comp = soft_composite(aligned_bgr, weights, valid_mask)
    else:
        raise ValueError(f"未知融合模式: {mode}")
    smap = source_map(labels, len(aligned_bgr), valid_mask)
    imgs, bbox = apply_coverage([comp, smap, labels[..., None],
                                 np.moveaxis(weights, 0, -1)],
                                valid_mask, coverage)
    comp, smap = imgs[0], imgs[1]
    lab = imgs[2][..., 0].astype(np.int32)
    wts = np.moveaxis(imgs[3], -1, 0).astype(np.float32)
    vm = valid_mask
    if bbox is not None:
        vm = valid_mask[bbox[1]:bbox[3], bbox[0]:bbox[2]]
    return FusionResult(comp, smap, lab, wts, mode, vm, bbox)


def inspect_point(x: int, y: int, labels: np.ndarray, scores: np.ndarray,
                  usable: list[int], aligned_bgr: list[np.ndarray],
                  reg) -> dict:
    """点击回看：该像素的倾向源、各源相对清晰度、配准状态。

    返回 dict：
      point, chosen, usable, per_source[{index, rel_sharpness, raw, status, cc}]
    坐标在裁剪模式下由调用方先加回 bbox 偏移。
    """
    h, w = labels.shape
    x = int(np.clip(x, 0, w - 1))
    y = int(np.clip(y, 0, h - 1))
    rel = relative_scores(scores)
    chosen = int(labels[y, x])
    per = []
    for i in range(scores.shape[0]):
        item = reg.items[i]
        per.append({
            "index": i,
            "chosen": i == chosen,
            "rel_sharpness": float(rel[i, y, x]),
            "raw": float(scores[i, y, x]),
            "status": item.status,
            "correlation": item.correlation,
            "usable": item.usable,
            "bgr": [int(v) for v in aligned_bgr[i][y, x]],
        })
    per.sort(key=lambda d: d["rel_sharpness"], reverse=True)
    return {"point": [x, y], "chosen": chosen,
            "usable": list(usable), "per_source": per}
