"""自带样例生成：纯 numpy/cv2 绘制，不依赖外部素材。

两组样例：
1. scene（默认）：3~5 张同场景不同对焦平面的图
   - 细纹区：密集条纹/点阵/网格，不同深度在不同张里清晰
   - 纯色区：大面积平涂色块（所有张清晰度都接近 0，检验选取稳定性）
   - 互相压住边缘：前后景形状互相遮挡（前景圆挡住后景条纹板）
   - 对焦呼吸：每张带小幅缩放+平移，检验配准与边缘对照
2. failure：在样例 1 的基础上加入明显移位/旋转的图，用于核对失败提示

深度模型：每个图元带 depth（0=最近 … 1=最远）。第 k 张的对焦深度
focus_k 均匀扫过 [0,1]，图元按 |depth-focus| 做高斯模糊，模拟离焦。
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


# --------------------------------------------------------------------------- #
# 纹理绘制
# --------------------------------------------------------------------------- #
def _fill_stripes(canvas: np.ndarray, x0, y0, x1, y1,
                  color, gap: int, orient: str, stripe: int = 2) -> None:
    sub = canvas[y0:y1, x0:x1]
    sub[:] = color
    bright = np.clip(np.asarray(color, np.int16) + 70, 0, 255).astype(np.uint8)
    if orient == "v":
        for x in range(0, sub.shape[1], gap):
            sub[:, x:x + stripe] = bright
    else:
        for y in range(0, sub.shape[0], gap):
            sub[y:y + stripe, :] = bright


def _fill_dot_grid(canvas, x0, y0, x1, y1, base_color,
                   dot_color, pitch: int, radius: int) -> None:
    sub = canvas[y0:y1, x0:x1]
    sub[:] = base_color
    for yy in range(pitch // 2, sub.shape[0], pitch):
        for xx in range(pitch // 2, sub.shape[1], pitch):
            cv2.circle(sub, (xx, yy), radius, dot_color, -1, cv2.LINE_AA)


def _fill_checker(canvas, x0, y0, x1, y1, c1, c2, cell: int) -> None:
    sub = canvas[y0:y1, x0:x1]
    h, w = sub.shape[:2]
    for yy in range(0, h, cell):
        for xx in range(0, w, cell):
            sub[yy:yy + cell, xx:xx + cell] = c1 if ((xx // cell + yy // cell) % 2) else c2


@dataclass
class Primitive:
    depth: float
    kind: str
    params: dict


def _draw_polygon_ordered(canvas: np.ndarray, prims: list[Primitive]) -> None:
    """按 depth 从远到近绘制（远的先画，近的后画盖住）。"""
    h, w = canvas.shape[:2]
    for p in sorted(prims, key=lambda q: -q.depth):
        q = p.params
        if p.kind == "rect":
            cv2.rectangle(canvas, q["p1"], q["p2"], q["color"], -1, cv2.LINE_AA)
        elif p.kind == "circle":
            cv2.circle(canvas, q["center"], q["r"], q["color"], -1, cv2.LINE_AA)
        elif p.kind == "ring":
            cv2.circle(canvas, q["center"], q["r"], q["color"], q.get("thickness", 4),
                       cv2.LINE_AA)
        elif p.kind == "polygon":
            cv2.fillPoly(canvas, [np.asarray(q["points"], np.int32)], q["color"],
                         cv2.LINE_AA)
        elif p.kind == "line":
            cv2.line(canvas, q["p1"], q["p2"], q["color"], q.get("thickness", 2),
                     cv2.LINE_AA)


def build_scene_prims(h: int, w: int) -> list[Primitive]:
    """构造演示场景：背景条纹板（远）、纯色块（中）、前景圆（近，互相遮挡）。"""
    prims: list[Primitive] = []

    # 远景：整面竖向细纹板
    bg = np.zeros((h, w, 3), np.uint8)
    _fill_stripes(bg, 0, 0, w, h, (150, 140, 130), gap=8, orient="v", stripe=2)
    # 把背景板转成多边形图元不好表达，直接用一个特殊 kind
    prims.append(Primitive(0.95, "wallpaper", {"image": bg}))

    # 远景右侧：点阵网格板
    grid = np.zeros((h, w, 3), np.uint8)
    _fill_dot_grid(grid, int(w * 0.62), int(h * 0.08), w - 20, int(h * 0.55),
                   (120, 110, 100), (210, 200, 190), pitch=14, radius=2)
    prims.append(Primitive(0.8, "wallpaper", {"image": grid,
                                              "roi": (int(w * 0.62), int(h * 0.08),
                                                      w - 20, int(h * 0.55))}))

    # 中景：棋盘格板（细纹，和前景圆互相压住边缘）
    chk = np.zeros((h, w, 3), np.uint8)
    x0, y0, x1, y1 = int(w * 0.08), int(h * 0.42), int(w * 0.55), int(h * 0.92)
    _fill_checker(chk, x0, y0, x1, y1, (60, 90, 140), (180, 170, 90), cell=16)
    prims.append(Primitive(0.55, "wallpaper", {"image": chk,
                                               "roi": (x0, y0, x1, y1)}))

    # 中景：大面积纯色块（无细节，检验稳定选取）
    prims.append(Primitive(0.5, "rect", {
        "p1": (int(w * 0.60), int(h * 0.60)),
        "p2": (int(w * 0.93), int(h * 0.90)),
        "color": (45, 130, 75)}))

    # 近景：两个圆，一个压住棋盘格边缘，一个互相重叠遮挡
    prims.append(Primitive(0.25, "circle", {
        "center": (int(w * 0.42), int(h * 0.40)), "r": int(min(h, w) * 0.13),
        "color": (30, 60, 200)}))
    prims.append(Primitive(0.12, "circle", {
        "center": (int(w * 0.52), int(h * 0.33)), "r": int(min(h, w) * 0.09),
        "color": (200, 120, 30)}))
    # 近景小圆环（细纹理）
    prims.append(Primitive(0.08, "ring", {
        "center": (int(w * 0.78), int(h * 0.25)), "r": int(min(h, w) * 0.07),
        "thickness": 5, "color": (200, 200, 220)}))
    return prims


def render_all_focus(canvas: np.ndarray, prims: list[Primitive],
                     focus: float, sigma_scale: float = 18.0) -> np.ndarray:
    """按对焦深度渲染一帧：每个图元按 |depth-focus| 独立模糊后合成。

    每层先在独立图层上画清楚的图元，再按离焦量高斯模糊，最后从远到近盖上去，
    这样遮挡边缘的虚化也符合物理（前景虚化不会渗到后景背后）。
    """
    h, w = canvas.shape[:2]
    frame = canvas.copy()
    for p in sorted(prims, key=lambda q: -q.depth):
        layer = np.zeros((h, w, 4), np.uint8)
        q = p.params
        if p.kind == "wallpaper":
            img = q["image"]
            if "roi" in q:
                x0, y0, x1, y1 = q["roi"]
                layer[y0:y1, x0:x1, :3] = img[y0:y1, x0:x1]
                layer[y0:y1, x0:x1, 3] = 255
            else:
                layer[:, :, :3] = img
                layer[:, :, 3] = 255
        else:
            solid = np.zeros((h, w, 3), np.uint8)
            _draw_polygon_ordered(solid, [p])
            mask = solid.sum(axis=2) > 0
            layer[:, :, :3] = solid
            layer[:, :, 3] = mask.astype(np.uint8) * 255

        sigma = abs(p.depth - focus) * sigma_scale
        if sigma > 0.6:
            ksize = int(np.ceil(sigma * 3) * 2 + 1)
            layer = cv2.GaussianBlur(layer, (ksize, ksize), sigma)

        alpha = layer[:, :, 3:4].astype(np.float32) / 255.0
        frame = (frame.astype(np.float32) * (1 - alpha)
                 + layer[:, :, :3].astype(np.float32) * alpha)
        frame = np.clip(frame, 0, 255).astype(np.uint8)
    return frame


def _breathe_matrix(index: int, n: int, h: int, w: int,
                    strength: float = 1.0) -> np.ndarray:
    """对焦呼吸：每张相对参考帧有小幅缩放（±3%）和平移（短边 ±2%）。"""
    t = index / max(n - 1, 1)
    scale = 1.0 + 0.03 * np.sin(t * np.pi) * strength
    dx = 0.02 * min(h, w) * (t - 0.5) * strength
    dy = -0.015 * min(h, w) * np.cos(t * np.pi) * strength
    m = np.array([[scale, 0, dx], [0, scale, dy]], np.float64)
    # 以画面中心为缩放原点
    cx, cy = w / 2.0, h / 2.0
    m[0, 2] += cx - scale * cx
    m[1, 2] += cy - scale * cy
    return m


def _failure_matrix(index: int, h: int, w: int) -> np.ndarray:
    """失败样例：15% 缩放 + 12° 旋转 + 大平移，明显超出配准合理范围。"""
    angle = np.radians(12 * (1 if index % 2 else -1))
    scale = 1.15
    cx, cy = w / 2.0, h / 2.0
    ca, sa = np.cos(angle), np.sin(angle)
    a, b = scale * ca, -scale * sa
    c, d = scale * sa, scale * ca
    return np.array([
        [a, b, cx - a * cx - b * cy + 0.12 * w],
        [c, d, cy - c * cx - d * cy + 0.10 * h],
    ], np.float64)


def generate_focus_stack(out_dir: str | Path, n: int = 4,
                         size: tuple[int, int] = (480, 640),
                         failure: bool = False,
                         seed: int = 15686) -> list[str]:
    """生成一组样例并写成 PNG，返回按焦点顺序的文件路径。"""
    rng = np.random.default_rng(seed)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    h, w = size
    canvas = np.full((h, w, 3), (28, 24, 22), np.uint8)
    prims = build_scene_prims(h, w)

    paths: list[str] = []
    for k in range(n):
        focus = k / max(n - 1, 1)
        sharp = render_all_focus(canvas, prims, focus)
        # 轻微传感器噪声，避免平涂区完全死寂
        noise = rng.normal(0, 2.0, sharp.shape)
        sharp = np.clip(sharp.astype(np.float32) + noise, 0, 255).astype(np.uint8)

        if failure and k == n - 1:
            m = _failure_matrix(k, h, w)
        else:
            m = _breathe_matrix(k, n, h, w)
        warped = cv2.warpAffine(sharp, m.astype(np.float32), (w, h),
                                flags=cv2.INTER_LINEAR,
                                borderMode=cv2.BORDER_CONSTANT,
                                borderValue=(28, 24, 22))
        name = f"{'fail' if failure else 'sample'}_{k:02d}.png"
        p = out_dir / name
        cv2.imwrite(str(p), warped)
        paths.append(str(p))
    return paths


SAMPLE_SETS = {
    "scene": {"failure": False, "n": 4, "description": "细纹/纯色/遮挡场景，含对焦呼吸"},
    "failure": {"failure": True, "n": 4,
                "description": "最后一张明显移位旋转，用于核对配准失败提示"},
}
