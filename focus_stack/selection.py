"""局部源选择：哪个像素用哪张源，以及人工固定（pin）。

自动选择
--------
对清晰度栈 argmax 得到标签图（flat 区靠固定顺序的平局规则保持稳定），
再用“受约束的中值众数滤波”做空间平滑，让选择结果连片，避免碎斑。

人工固定
--------
Pin 把一块区域强制指定给某张源。pin 是矢量图形（矩形/椭圆/多边形），
重算配准后仍然有效；栅格化后的 pin 像素在平滑中受保护，修改其他选择时
已有 pin 一律保留（PinSet 按 id 增量管理）。

重影
----
相邻像素标签不同处形成接缝，在接缝带内计算“被选中源与其他源的颜色差异”，
差异大说明该交界附近存在重影风险，fusion/界面据此高亮。
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field

import cv2
import numpy as np

from .registration import STATUS_FAIL

INVALID_LABEL = -1


# --------------------------------------------------------------------------- #
# Pin 数据模型（矢量，可 JSON 序列化）
# --------------------------------------------------------------------------- #
@dataclass
class Pin:
    id: str
    source_index: int
    shape: str                       # "rect" | "ellipse" | "polygon"
    coords: list                     # rect: [x0,y0,x1,y1]；ellipse 同；polygon: [[x,y],...]
    name: str = ""

    @staticmethod
    def create(source_index: int, shape: str, coords: list,
               name: str = "") -> "Pin":
        return Pin(uuid.uuid4().hex[:12], source_index, shape,
                   [list(c) if isinstance(c, (list, tuple, np.ndarray)) else c
                    for c in coords], name)

    def rasterize(self, h: int, w: int) -> np.ndarray:
        mask = np.zeros((h, w), np.uint8)
        if self.shape in ("rect", "ellipse"):
            x0, y0, x1, y1 = (int(round(v)) for v in self.coords[:4])
            x0, x1 = max(0, min(x0, x1)), min(w, max(x0, x1))
            y0, y1 = max(0, min(y0, y1)), min(h, max(y0, y1))
            if self.shape == "rect":
                mask[y0:y1, x0:x1] = 1
            else:
                cv2.ellipse(mask, ((x0 + x1) // 2, (y0 + y1) // 2),
                            (max((x1 - x0) // 2, 1), max((y1 - y0) // 2, 1)),
                            0, 0, 360, 1, -1)
        elif self.shape == "polygon":
            pts = np.round(np.asarray(self.coords, dtype=np.float64)).astype(np.int32)
            cv2.fillPoly(mask, [pts], 1)
        else:
            raise ValueError(f"未知 pin 形状: {self.shape}")
        return mask

    def to_dict(self) -> dict:
        return {"id": self.id, "source_index": self.source_index,
                "shape": self.shape, "coords": self.coords, "name": self.name}

    @staticmethod
    def from_dict(d: dict) -> "Pin":
        return Pin(d["id"], int(d["source_index"]), d["shape"],
                   list(d["coords"]), d.get("name", ""))


@dataclass
class PinSet:
    """按 id 管理的 pin 集合；栅格化时后加入的 pin 覆盖先加入的。"""
    pins: list[Pin] = field(default_factory=list)

    def add(self, pin: Pin) -> None:
        self.pins.append(pin)

    def remove(self, pin_id: str) -> bool:
        n = len(self.pins)
        self.pins = [p for p in self.pins if p.id != pin_id]
        return len(self.pins) < n

    def update_source(self, pin_id: str, source_index: int) -> None:
        for p in self.pins:
            if p.id == pin_id:
                p.source_index = source_index
                return
        raise KeyError(pin_id)

    def get(self, pin_id: str) -> Pin | None:
        return next((p for p in self.pins if p.id == pin_id), None)

    def pin_at(self, x: int, y: int) -> Pin | None:
        """返回包含该点的最后加入的 pin（即视觉上最上层）。"""
        for p in reversed(self.pins):
            if p.rasterize_mask_at(x, y):
                return p
        return None

    def rasterize(self, h: int, w: int) -> tuple[np.ndarray, np.ndarray]:
        """返回 (pin_label[H,W] int32，无 pin 处 -1； pin_mask[H,W] uint8)。"""
        label = np.full((h, w), INVALID_LABEL, np.int32)
        mask = np.zeros((h, w), np.uint8)
        for p in self.pins:
            m = p.rasterize(h, w).astype(bool)
            label[m] = p.source_index
            mask[m] = 1
        return label, mask

    def to_list(self) -> list[dict]:
        return [p.to_dict() for p in self.pins]

    @staticmethod
    def from_list(items: list[dict]) -> "PinSet":
        return PinSet([Pin.from_dict(d) for d in items])


# Pin.rasterize 的点查询小辅助（避免每次全图栅格化）
def _rasterize_mask_at(self: Pin, x: int, y: int) -> bool:
    if self.shape == "rect":
        x0, y0, x1, y1 = self.coords[:4]
        return min(x0, x1) <= x <= max(x0, x1) and min(y0, y1) <= y <= max(y0, y1)
    if self.shape == "ellipse":
        x0, y0, x1, y1 = self.coords[:4]
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        rx, ry = max(abs(x1 - x0) / 2, 1e-6), max(abs(y1 - y0) / 2, 1e-6)
        return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0
    if self.shape == "polygon":
        return cv2.pointPolygonTest(
            np.asarray(self.coords, np.float32), (float(x), float(y)), False) >= 0
    return False


Pin.rasterize_mask_at = _rasterize_mask_at  # type: ignore[attr-defined]


# --------------------------------------------------------------------------- #
# 标签图计算
# --------------------------------------------------------------------------- #
@dataclass
class SelectionConfig:
    smooth_kernel: int = 11        # 多数投票滤波核（奇数）
    smooth_iterations: int = 5     # 迭代越多，纯色区标签越连片
    seam_band: int = 3             # 接缝外扩像素
    ghost_quantile: float = 0.9    # 接缝带重影汇总分位数


def argmax_labels(scores: np.ndarray, valid_mask: np.ndarray,
                  usable: list[int]) -> np.ndarray:
    """清晰度 argmax 标签。

    - 只在 usable 源里选（配准失败的源排除）
    - 平局时取下标较小者：np.argmax 天然取第一个最大值，配合稳定的源顺序，
      大面积纯色区（所有分数接近 0）的选取结果逐次运行完全一致
    - valid_mask 外标 INVALID_LABEL
    """
    n, h, w = scores.shape
    labels = np.full((h, w), INVALID_LABEL, np.int32)
    sub = scores[np.asarray(usable)]
    sub_labels = np.argmax(sub, axis=0).astype(np.int32)
    chosen = np.asarray(usable, np.int32)[sub_labels]
    labels[valid_mask > 0] = chosen[valid_mask > 0]
    return labels


def _mode_filter_bitplanar(labels: np.ndarray, k: int,
                           valid_mask: np.ndarray) -> np.ndarray:
    """对 ≤8 个离散标签做多数（众数）滤波，位平面计数实现，O(类数·n)。

    把标签编码成 4 位，对每个位平面用 boxFilter 统计“有效像素中”该位为 1
    的比例，逐位贪心解码；平局取 0，因此标签编号小的源在纯色区（全平局）
    稳定胜出。valid_mask 外的像素不参与投票也不产生结果。
    """
    h, w = labels.shape
    n_classes = max(int(labels[valid_mask > 0].max()) + 1, 2) if valid_mask.any() else 2
    n_bits = max(1, int(np.ceil(np.log2(max(n_classes, 2)))))
    encoded = np.clip(labels, 0, 15).astype(np.uint8)
    result = np.zeros((h, w), np.uint8)
    candidates = np.ones((h, w, n_classes), dtype=bool)
    count = cv2.boxFilter(valid_mask.astype(np.float32), cv2.CV_32F, (k, k),
                          normalize=False, borderType=cv2.BORDER_CONSTANT)
    count = np.maximum(count, 1.0)

    for bit in range(n_bits - 1, -1, -1):
        bit_plane = ((encoded >> bit) & 1).astype(np.float32) * valid_mask
        ones = cv2.boxFilter(bit_plane, cv2.CV_32F, (k, k), normalize=False,
                             borderType=cv2.BORDER_CONSTANT)
        frac = ones / count
        bit_val = (frac > 0.5).astype(np.uint8)  # 平局（=0.5）取 0
        result = result | (bit_val << bit)
        bit_of_class = (np.arange(n_classes, dtype=np.uint8) >> bit) & 1
        candidates &= (bit_of_class[None, None, :] == bit_val[..., None])

    chosen_here = result.astype(np.int32)
    valid_choice = np.take_along_axis(
        candidates, np.clip(chosen_here, 0, n_classes - 1)[..., None],
        axis=2).squeeze(-1)
    if not valid_choice.all():
        first_candidate = np.argmax(candidates, axis=2).astype(np.int32)
        chosen_here = np.where(valid_choice, chosen_here, first_candidate)
    return chosen_here


def _constrained_median_smooth(labels: np.ndarray, pin_mask: np.ndarray,
                               pin_label: np.ndarray,
                               cfg: SelectionConfig) -> np.ndarray:
    """多数投票平滑标签；pin 像素保持不动，无效区保持无效。"""
    out = labels.copy()
    k = cfg.smooth_kernel
    valid = (out != INVALID_LABEL).astype(np.uint8)
    for _ in range(cfg.smooth_iterations):
        voted = _mode_filter_bitplanar(np.where(valid > 0, out, 0), k, valid)
        out = np.where(valid > 0, voted, INVALID_LABEL).astype(np.int32)
        out[pin_mask > 0] = pin_label[pin_mask > 0]
    return out


def compute_labels(scores: np.ndarray, valid_mask: np.ndarray,
                   usable: list[int], pins: PinSet,
                   cfg: SelectionConfig | None = None) -> np.ndarray:
    """完整标签图：argmax → pin 覆盖 → 受约束平滑。"""
    cfg = cfg or SelectionConfig()
    h, w = scores.shape[1:]
    labels = argmax_labels(scores, valid_mask, usable)
    pin_label, pin_mask = pins.rasterize(h, w)
    # pin 只能指向可用源；指向失败源时忽略该 pin 的覆盖
    pin_ok = pin_mask > 0
    bad = pin_ok & ~np.isin(pin_label, np.asarray(usable, dtype=np.int32))
    pin_ok &= ~bad
    labels[pin_ok] = pin_label[pin_ok]
    labels = _constrained_median_smooth(labels, pin_ok.astype(np.uint8),
                                        pin_label, cfg)
    return labels


def soft_weights(scores: np.ndarray, labels: np.ndarray, usable: list[int],
                 temperature: float) -> np.ndarray:
    """柔和交界权重 (N,H,W)。

    以每个像素的 argmax 选择为中心，用 softmax(score/temperature) 在 usable
    源上分配权重；temperature→0 退化为硬选择。无效区权重为 0。
    """
    n = scores.shape[0]
    h, w = scores.shape[1:]
    weights = np.zeros((n, h, w), np.float32)
    sub = scores[np.asarray(usable)].astype(np.float32)
    t = max(float(temperature), 1e-6)
    z = sub / t
    z -= z.max(axis=0, keepdims=True)
    e = np.exp(z)
    w = e / e.sum(axis=0, keepdims=True)
    for k, idx in enumerate(usable):
        weights[idx] = w[k]
    weights[:, labels == INVALID_LABEL] = 0.0
    return weights


# --------------------------------------------------------------------------- #
# 接缝与重影
# --------------------------------------------------------------------------- #
def seam_map(labels: np.ndarray, band: int) -> np.ndarray:
    """接缝带掩码：相邻像素标签不同处外扩 band 像素。"""
    h, w = labels.shape
    seam = np.zeros((h, w), np.uint8)
    diff_x = (labels[:, 1:] != labels[:, :-1]) & (labels[:, 1:] != INVALID_LABEL) \
        & (labels[:, :-1] != INVALID_LABEL)
    diff_y = (labels[1:, :] != labels[:-1, :]) & (labels[1:, :] != INVALID_LABEL) \
        & (labels[:-1, :] != INVALID_LABEL)
    seam[:, 1:][diff_x] = 1
    seam[:, :-1][diff_x] = 1
    seam[1:, :][diff_y] = 1
    seam[:-1, :][diff_y] = 1
    if band > 0:
        kernel = np.ones((2 * band + 1, 2 * band + 1), np.uint8)
        seam = cv2.dilate(seam, kernel)
    return seam


def ghost_map(aligned_bgr: list[np.ndarray], labels: np.ndarray,
              usable: list[int], cfg: SelectionConfig | None = None) -> np.ndarray:
    """逐像素重影强度 (H,W) float32：接缝带内，被选中源与其他源的最大颜色差。

    非接缝带为 0；差值用 0~255 归一化。差异越大，柔和融合越可能出现重影。
    """
    cfg = cfg or SelectionConfig()
    h, w = labels.shape
    seam = seam_map(labels, cfg.seam_band).astype(bool)
    ghost = np.zeros((h, w), np.float32)
    if not seam.any():
        return ghost

    stack = np.stack([a.astype(np.float32) for a in aligned_bgr], axis=0)
    chosen = np.zeros((h, w, 3), np.float32)
    valid = labels != INVALID_LABEL
    for idx in usable:
        m = valid & (labels == idx)
        chosen[m] = stack[idx][m]

    max_diff = np.zeros((h, w), np.float32)
    for idx in usable:
        d = np.abs(stack[idx] - chosen).max(axis=2)
        max_diff = np.maximum(max_diff, d)
    ghost[seam] = max_diff[seam]
    return ghost


def ghost_summary(ghost: np.ndarray, labels: np.ndarray,
                  cfg: SelectionConfig | None = None) -> dict:
    """汇总接缝带重影统计，供界面提示。"""
    cfg = cfg or SelectionConfig()
    vals = ghost[ghost > 0]
    if vals.size == 0:
        return {"seam_pixels": 0, "mean": 0.0, "p90": 0.0, "max": 0.0}
    return {
        "seam_pixels": int(vals.size),
        "mean": float(vals.mean()),
        "p90": float(np.quantile(vals, cfg.ghost_quantile)),
        "max": float(vals.max()),
    }


def pin_ghost(pin: Pin, ghost: np.ndarray) -> dict:
    """单个 pin 周边的重影统计（pin 栅格与接缝带相交的区域）。"""
    h, w = ghost.shape
    m = pin.rasterize(h, w).astype(bool)
    vals = ghost[m]
    if vals.size == 0:
        return {"pin_id": pin.id, "pixels": 0, "mean": 0.0, "max": 0.0}
    return {"pin_id": pin.id, "pixels": int(vals.size),
            "mean": float(vals.mean()), "max": float(vals.max())}


def failed_sources(reg) -> list[int]:
    """配准失败的源下标（选择与融合时排除）。"""
    return [it.index for it in reg.items if it.status == STATUS_FAIL]
