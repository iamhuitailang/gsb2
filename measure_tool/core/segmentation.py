"""二值化与轮廓分割。

扫描图约定：浅色背景、深色零件（dark-on-light）。
用灰度阈值把图分成 零件(黑,0) / 背景(白,255)，
再用 RETR_CCOMP 拿到两层结构：

- 外层轮廓 = 零件（一个连通黑块算一件）；
- 内层轮廓 = 被零件完全围住的背景，即孔；
- 与图片边界接触的外层轮廓单独标记为“断到图边上的区域”。

同时对背景做连通域分析：碰到图边的背景 = 外部，
碰不到图边的背景 = 封闭孔。这是后面比较
“孔被识别成背景 / 与外部连通 / 仍是单独孔”的依据。
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict

import cv2
import numpy as np

# 轮廓类别
OUTER = "outer"          # 完整外轮廓（未碰图边）
HOLE = "hole"            # 被零件围住的孔
BORDER = "border"        # 断到图边上的零件区域


@dataclass
class SegmentParams:
    """分割参数。阈值调高 => 更多偏灰的像素被判成零件。"""

    threshold: int = 128          # 0~255，灰度 < threshold 判为零件
    min_speck_area_px: int = 3000 # 小于该面积的黑块视为小黑点/标尺刻度等噪点
    morph_open: int = 0           # 形态学开运算核尺寸（去毛刺），0 关闭
    invert: bool = False          # 深底浅零件时置 True

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Component:
    """一个分割出来的区域（零件、孔或碰边区域）。"""

    comp_id: int
    kind: str                      # outer / hole / border
    contour: np.ndarray            # Nx1x2 像素坐标
    parent_id: int | None          # 孔所属零件的 id
    child_ids: list[int]          # 零件包含的孔 id
    bbox: tuple[int, int, int, int]   # x, y, w, h
    outer_area_px: float           # 外轮廓包围的面积（含孔）
    filled_area_px: int            # 实际黑色像素数（不含孔）
    touches_border: bool
    border_sides: list[str]        # 碰到的边：top/bottom/left/right
    # 孔专用：所属背景连通域 id，以及该孔像素面积
    bg_label: int | None = None
    hole_area_px: int = 0

    def preview_contour(self, epsilon_px: float = 1.0) -> list[list[float]]:
        """抽稀后的轮廓点，供前端画布绘制。"""
        eps = epsilon_px or 1.0
        approx = cv2.approxPolyDP(self.contour, eps, True)
        return approx.reshape(-1, 2).astype(float).tolist()


@dataclass
class Segmentation:
    params: SegmentParams
    image_shape: tuple[int, int]            # (高, 宽)
    components: dict[int, Component] = field(default_factory=dict)
    # 背景连通域：label -> {"area_px", "touches_border", "is_hole", "centroid"}
    bg_components: dict[int, dict] = field(default_factory=dict)
    binary: np.ndarray | None = None        # 0=零件 255=背景
    kept_speck_count: int = 0
    dropped_speck_count: int = 0

    def outers(self) -> list[Component]:
        return [c for c in self.components.values() if c.kind in (OUTER, BORDER)]

    def holes_of(self, comp_id: int) -> list[Component]:
        c = self.components.get(comp_id)
        if not c:
            return []
        return [self.components[i] for i in c.child_ids]


def load_gray(image_path: str) -> np.ndarray:
    img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise FileNotFoundError(f"无法读取图片: {image_path}")
    return img


def binarize(gray: np.ndarray, params: SegmentParams) -> np.ndarray:
    """返回 0=零件、255=背景 的二值图。"""
    if params.invert:
        # 深底浅零件：亮于阈值的是零件，先翻转回“零件为暗”的约定
        gray = 255 - gray
    _, binary = cv2.threshold(
        gray, params.threshold, 255, cv2.THRESH_BINARY
    )
    if params.morph_open and params.morph_open > 0:
        k = params.morph_open
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
        # 开运算去掉零件里的细小毛刺/桥接
        binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)
    return binary


def _border_sides(contour: np.ndarray, h: int, w: int,
                  tol: int = 1) -> list[str]:
    x, y, cw, ch = cv2.boundingRect(contour)
    sides = []
    if y <= tol:
        sides.append("top")
    if y + ch >= h - tol:
        sides.append("bottom")
    if x <= tol:
        sides.append("left")
    if x + cw >= w - tol:
        sides.append("right")
    return sides


def segment(gray: np.ndarray, params: SegmentParams) -> Segmentation:
    """主分割流程。"""
    h, w = gray.shape[:2]
    binary = binarize(gray, params)
    seg = Segmentation(params=params, image_shape=(h, w), binary=binary)

    # ---- 背景连通域：区分外部背景与封闭孔 ----
    n_labels, labels = cv2.connectedComponents(binary, connectivity=4)
    border_labels: set[int] = set()
    border_labels.update(np.unique(labels[0, :]).tolist())
    border_labels.update(np.unique(labels[h - 1, :]).tolist())
    border_labels.update(np.unique(labels[:, 0]).tolist())
    border_labels.update(np.unique(labels[:, w - 1]).tolist())

    for lab in range(1, n_labels):  # 0 是零件像素，跳过
        mask = labels == lab
        area = int(mask.sum())
        ys, xs = np.nonzero(mask)
        seg.bg_components[lab] = {
            "label": lab,
            "area_px": area,
            "touches_border": lab in border_labels,
            "is_hole": lab not in border_labels,
            "centroid": [float(xs.mean()), float(ys.mean())],
        }

    # ---- 轮廓层级（RETR_CCOMP：外层零件 / 内层孔 两层）----
    contours, hierarchy = cv2.findContours(
        255 - binary, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE
    )
    if hierarchy is None:
        return seg

    hierarchy = hierarchy[0]
    # 第一遍：建立外层零件（含小黑点过滤）
    outer_id_by_index: dict[int, int] = {}
    next_id = 0
    black_filled_total: dict[int, int] = {}

    for idx, contour in enumerate(contours):
        parent = hierarchy[idx][3]
        if parent != -1:
            continue  # 内层孔第二遍处理
        area_outer = float(cv2.contourArea(contour))
        touches = bool(_border_sides(contour, h, w))
        # 小黑点：面积小于阈值且没有包住任何孔 => 噪点
        has_child = hierarchy[idx][2] != -1
        if area_outer < params.min_speck_area_px and not has_child and not touches:
            seg.dropped_speck_count += 1
            continue
        seg.kept_speck_count += 1 if area_outer < params.min_speck_area_px else 0

        cid = next_id
        next_id += 1
        x, y, cw, ch = cv2.boundingRect(contour)
        comp = Component(
            comp_id=cid,
            kind=BORDER if touches else OUTER,
            contour=contour,
            parent_id=None,
            child_ids=[],
            bbox=(int(x), int(y), int(cw), int(ch)),
            outer_area_px=area_outer,
            filled_area_px=0,  # 下面统一填
            touches_border=touches,
            border_sides=_border_sides(contour, h, w),
        )
        seg.components[cid] = comp
        outer_id_by_index[idx] = cid
        black_filled_total[cid] = 0

    # 第二遍：孔，挂到父零件上
    for idx, contour in enumerate(contours):
        parent_idx = hierarchy[idx][3]
        if parent_idx == -1 or parent_idx not in outer_id_by_index:
            continue
        parent_id = outer_id_by_index[parent_idx]
        hid = next_id
        next_id += 1
        x, y, cw, ch = cv2.boundingRect(contour)

        # 用轮廓内的背景连通域拿真实孔像素面积与 label
        hole_mask = np.zeros((h, w), dtype=np.uint8)
        cv2.drawContours(hole_mask, [contour], -1, 255, thickness=cv2.FILLED)
        inner_labels = np.unique(labels[hole_mask > 0])
        inner_labels = inner_labels[inner_labels != 0]
        bg_label = int(inner_labels[0]) if len(inner_labels) else None
        hole_area = 0
        if bg_label is not None and bg_label in seg.bg_components:
            hole_area = int(seg.bg_components[bg_label]["area_px"])
        else:
            hole_area = int((hole_mask > 0).sum())

        hcomp = Component(
            comp_id=hid,
            kind=HOLE,
            contour=contour,
            parent_id=parent_id,
            child_ids=[],
            bbox=(int(x), int(y), int(cw), int(ch)),
            outer_area_px=float(cv2.contourArea(contour)),
            filled_area_px=0,
            touches_border=False,
            border_sides=[],
            bg_label=bg_label,
            hole_area_px=hole_area,
        )
        seg.components[hid] = hcomp
        seg.components[parent_id].child_ids.append(hid)

    # ---- 每个零件的实际填充像素数（黑像素，不含孔）----
    part_mask = (binary == 0).astype(np.uint8)
    n_black, black_labels = cv2.connectedComponents(part_mask, connectivity=8)
    black_area_by_label: dict[int, int] = {}
    for lab in range(1, n_black):
        black_area_by_label[lab] = int((black_labels == lab).sum())

    for c in seg.outers():
        # 取轮廓内出现最多的黑连通域标签，兼容抽稀/贴边情况
        cm = np.zeros((h, w), dtype=np.uint8)
        cv2.drawContours(cm, [c.contour], -1, 1, thickness=cv2.FILLED)
        labs, counts = np.unique(black_labels[cm > 0], return_counts=True)
        labs = labs[labs != 0]
        if len(labs):
            # 轮廓内所有黑连通域像素之和 = 实际填充面积
            c.filled_area_px = int(sum(black_area_by_label.get(int(l), 0)
                                       for l in labs))
        else:
            c.filled_area_px = 0

    return seg


# ---------------------------------------------------------------------- #
# 可视化
# ---------------------------------------------------------------------- #
COLORS = {
    OUTER: (60, 170, 60),     # 绿：完整外轮廓
    HOLE: (50, 70, 230),      # 红：孔
    BORDER: (0, 200, 230),    # 黄：断到图边的区域
}
FILL_ALPHA = 70


def render_overlay(gray: np.ndarray, seg: Segmentation) -> np.ndarray:
    """在灰度底图上叠一层彩色轮廓预览，返回 BGR 图。"""
    base = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    overlay = base.copy()
    for comp in seg.components.values():
        color = COLORS[comp.kind]
        cv2.drawContours(overlay, [comp.contour], -1, color,
                         thickness=cv2.FILLED)
    out = cv2.addWeighted(overlay, FILL_ALPHA / 255.0, base,
                          1 - FILL_ALPHA / 255.0, 0)
    for comp in seg.components.values():
        color = COLORS[comp.kind]
        cv2.drawContours(out, [comp.contour], -1, color, thickness=2)
    return out


def encode_png(image_bgr: np.ndarray, max_side: int = 1600) -> tuple[bytes, float]:
    """编码 PNG，必要时等比缩小。返回 (字节, 显示相对原图的缩放比)。"""
    h, w = image_bgr.shape[:2]
    scale = 1.0
    if max(h, w) > max_side:
        scale = max_side / max(h, w)
        image_bgr = cv2.resize(image_bgr, (int(w * scale), int(h * scale)),
                               interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".png", image_bgr)
    if not ok:
        raise RuntimeError("PNG 编码失败")
    return buf.tobytes(), scale
