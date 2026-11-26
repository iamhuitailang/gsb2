"""模板：从图片里圈出样例，并生成掩膜（可圈掉一部分背景）。

模板保存为带 alpha 的 PNG：
- RGB：样例外观；
- alpha=0 的像素为“背景/忽略区”，匹配时不参与打分。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass
class Template:
    """一个查找模板。

    Attributes:
        image: BGR 图像 (H,W,3) uint8。
        mask:  uint8，255=参与匹配，0=背景/忽略。
        source_path: 模板来源图片路径（仅记录用）。
    """

    image: np.ndarray
    mask: np.ndarray
    source_path: str | None = None

    def __post_init__(self) -> None:
        if self.image.ndim != 3 or self.image.shape[2] != 3:
            raise ValueError("模板图像必须是 BGR 三通道")
        if self.mask.shape != self.image.shape[:2]:
            raise ValueError("掩膜尺寸必须与模板图像一致")
        if self.mask.dtype != np.uint8:
            self.mask = self.mask.astype(np.uint8)

    @property
    def width(self) -> int:
        return int(self.image.shape[1])

    @property
    def height(self) -> int:
        return int(self.image.shape[0])

    def cropped(self) -> "Template":
        """裁掉掩膜四周的全忽略边，缩小后续匹配开销。"""
        ys, xs = np.where(self.mask > 0)
        if len(ys) == 0:
            raise ValueError("掩膜为空：模板里没有任何参与匹配的像素")
        y0, y1 = int(ys.min()), int(ys.max()) + 1
        x0, x1 = int(xs.min()), int(xs.max()) + 1
        return Template(
            image=self.image[y0:y1, x0:x1].copy(),
            mask=self.mask[y0:y1, x0:x1].copy(),
            source_path=self.source_path,
        )


def extract_rect_template(
    image: np.ndarray,
    rect: tuple[int, int, int, int],
    mode: str = "rect",
    bg_tolerance: int = 24,
) -> Template:
    """从 image 的矩形区域 (x, y, w, h) 提取模板。

    Args:
        image: BGR 图。
        rect:  圈选矩形 (x, y, w, h)，允许圈进一部分背景。
        mode:
            - ``rect``：整块矩形都参与匹配；
            - ``flood``：以矩形四角颜色为背景种子做 floodFill，
              连通背景被圈掉（掩膜置 0），适合背景比较干净的样例；
            - ``center``：以矩形中心为前景种子取连通前景，其余圈掉。
        bg_tolerance: flood/center 模式下的颜色容差。
    """
    x, y, w, h = [int(v) for v in rect]
    if w <= 2 or h <= 2:
        raise ValueError("圈选区域太小")
    x0 = max(0, x)
    y0 = max(0, y)
    x1 = min(image.shape[1], x + w)
    y1 = min(image.shape[0], y + h)
    patch = image[y0:y1, x0:x1].copy()
    ph, pw = patch.shape[:2]
    mask = np.full((ph, pw), 255, np.uint8)

    if mode == "rect":
        pass
    elif mode == "flood":
        # floodFill 的掩膜要比图大两圈；从四角灌入，把连通背景标 1。
        ff_mask = np.zeros((ph + 2, pw + 2), np.uint8)
        seeds = [(0, 0), (pw - 1, 0), (0, ph - 1), (pw - 1, ph - 1)]
        lo = (bg_tolerance,) * 3
        for sx, sy in seeds:
            cv2.floodFill(
                patch.copy(),
                ff_mask,
                (sx, sy),
                0,
                lo,
                lo,
                cv2.FLOODFILL_MASK_ONLY,
            )
        bg = ff_mask[1:-1, 1:-1] > 0
        mask[bg] = 0
    elif mode == "center":
        ff_mask = np.zeros((ph + 2, pw + 2), np.uint8)
        cv2.floodFill(
            patch.copy(),
            ff_mask,
            (pw // 2, ph // 2),
            0,
            (bg_tolerance,) * 3,
            (bg_tolerance,) * 3,
            cv2.FLOODFILL_MASK_ONLY,
        )
        fg = ff_mask[1:-1, 1:-1] > 0
        mask = np.where(fg, 255, 0).astype(np.uint8)
    else:
        raise ValueError(f"未知提取模式: {mode}")

    if int((mask > 0).sum()) < 16:
        raise ValueError("掩膜有效像素过少，请换用 rect 模式或调大容差")
    return Template(image=patch, mask=mask)


def make_polygon_mask(shape_hw: tuple[int, int], polygon: np.ndarray) -> np.ndarray:
    """按多边形顶点（相对模板坐标）生成掩膜，多边形内为 255。"""
    h, w = shape_hw
    mask = np.zeros((h, w), np.uint8)
    pts = np.asarray(polygon, dtype=np.int32).reshape(-1, 1, 2)
    cv2.fillPoly(mask, [pts], 255)
    return mask


def save_template(template: Template, path: str | Path) -> None:
    """保存为带 alpha 的 PNG（alpha 即掩膜）。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    rgba = cv2.cvtColor(template.image, cv2.COLOR_BGR2BGRA)
    rgba[:, :, 3] = template.mask
    cv2.imwrite(str(path), rgba)


def load_template(path: str | Path) -> Template:
    """读取带 alpha 的 PNG 模板；没有 alpha 通道时整块有效。"""
    path = Path(path)
    raw = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if raw is None:
        raise FileNotFoundError(f"读不到模板文件: {path}")
    if raw.ndim == 2:
        image = cv2.cvtColor(raw, cv2.COLOR_GRAY2BGR)
        mask = np.full(raw.shape, 255, np.uint8)
    elif raw.shape[2] == 4:
        image = cv2.cvtColor(raw[:, :, :4], cv2.COLOR_BGRA2BGR)
        mask = raw[:, :, 3]
        mask[mask > 0] = 255
    else:
        image = raw
        mask = np.full(raw.shape[:2], 255, np.uint8)
    return Template(image=image, mask=mask, source_path=str(path))


def load_image(path: str | Path) -> np.ndarray:
    """读图（BGR），失败抛异常。"""
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None:
        raise FileNotFoundError(f"读不到图片: {path}")
    return img
