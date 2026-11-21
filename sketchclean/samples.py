"""程序生成两张带典型「手机拍照问题」的草稿样图（确定性、可复现）。

sample 1 —— 缓慢照明阴影 + 大量细浅铅笔线 + 大块实黑 + 小噪点 + 一处断线；
sample 2 —— 明显纸纹颗粒 + 折线（尖角）+ 轻微暗角 + 小噪点 + 一处断线。

运行：python -m sketchclean.samples [输出目录]
"""

from __future__ import annotations

import os
import sys

import cv2
import numpy as np

W, H = 1600, 1200


def _base_paper(rng: np.random.Generator, base: int, grain: float) -> np.ndarray:
    img = np.full((H, W), float(base), np.float32)
    img += rng.normal(0, grain, (H, W))  # 传感器/纸面颗粒
    return img


def _smooth_shadow(kind: str) -> np.ndarray:
    """返回乘性照明场，取值约 0.65~1.0，全部是低频平滑分量。"""
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    xn, yn = xx / W, yy / H
    if kind == "radial":
        # 左下角一大片缓慢变暗的阴影
        d = np.sqrt((xn - 0.05) ** 2 + (yn - 1.05) ** 2)
        field = 1.0 - 0.38 * np.clip(1.0 - d / 1.15, 0, 1) ** 2
        field *= 0.92 + 0.08 * xn  # 再叠加一个极缓的线性渐变
    else:
        # 轻微暗角
        d = np.sqrt((xn - 0.5) ** 2 + (yn - 0.5) ** 2)
        field = 1.0 - 0.18 * np.clip((d - 0.25) / 0.5, 0, 1) ** 2
    return field.astype(np.float32)


def _paper_texture(rng: np.random.Generator) -> np.ndarray:
    """明显纸纹：高频颗粒 + 细长纤维。"""
    grain = rng.normal(0, 7.0, (H, W)).astype(np.float32)
    fibers = np.zeros((H, W), np.float32)
    for _ in range(260):
        y = int(rng.integers(0, H))
        x0 = int(rng.integers(0, W))
        length = int(rng.integers(40, 320))
        shade = float(rng.uniform(-9, 5))
        x1 = min(W, x0 + length)
        dy = int(rng.integers(-2, 3))
        cv2.line(fibers, (x0, y), (x1, min(H - 1, max(0, y + dy))),
                 shade, 1, cv2.LINE_AA)
    return grain + fibers


def _line(img: np.ndarray, p0, p1, value: int, width: int, alpha: float = 1.0) -> None:
    layer = img.copy()
    cv2.line(layer, p0, p1, float(value), max(1, width), cv2.LINE_AA)
    img[:] = cv2.addWeighted(img, 1 - alpha, layer, alpha, 0)


def _poly(img, pts, value, width, alpha=1.0, closed=False) -> None:
    for a, b in zip(pts, pts[1:]):
        _line(img, a, b, value, width, alpha)
    if closed and len(pts) > 2:
        _line(img, pts[-1], pts[0], value, width, alpha)


def _rect_fill(img, x0, y0, x1, y1, value) -> None:
    cv2.rectangle(img, (x0, y0), (x1, y1), float(value), thickness=-1)


def _dots(rng, img, n, dark=(60, 160), rmax=2) -> None:
    for _ in range(n):
        x, y = int(rng.integers(40, W - 40)), int(rng.integers(40, H - 40))
        r = int(rng.integers(1, rmax + 1))
        v = float(rng.uniform(*dark))
        cv2.circle(img, (x, y), r, v, -1, cv2.LINE_AA)


def _faint_sketch(img) -> None:
    """细浅铅笔线画的小房子场景，灰度只比纸面暗一点点。"""
    faint, width = 198, 2
    # 房子主体
    _poly(img, [(360, 760), (360, 560), (560, 430), (760, 560), (760, 760)],
          faint, width, alpha=0.8, closed=True)
    _line(img, (360, 560), (560, 430), faint, width, 0.8)
    _line(img, (560, 430), (760, 560), faint, width, 0.8)
    # 门、窗（浅）
    _poly(img, [(520, 760), (520, 650), (610, 650), (610, 760)],
          faint + 8, 1, 0.7, closed=True)
    _poly(img, [(400, 640), (400, 590), (460, 590), (460, 640)],
          faint + 8, 1, 0.7, closed=True)
    # 地平线与小草
    _line(img, (180, 780), (1000, 780), faint + 12, 1, 0.6)
    for x in range(200, 980, 28):
        _line(img, (x, 780), (x + 6, 766), faint + 15, 1, 0.5)
    # 太阳（浅圆圈）
    cv2.circle(img, (1180, 240), 70, faint + 6, 1, cv2.LINE_AA)
    # 故意留一处断线：两段线之间空 8px
    _line(img, (1050, 420), (1180, 420), faint, 2, 0.8)
    _line(img, (1188, 420), (1330, 420), faint, 2, 0.8)


def sample_shadow(rng: np.random.Generator) -> np.ndarray:
    img = _base_paper(rng, 242, 2.2)
    _faint_sketch(img)
    # 大块实黑区域（测试实黑保护）
    _rect_fill(img, 1120, 820, 1360, 1000, 28)
    _poly(img, [(1120, 800), (1240, 720), (1360, 800)], 40, 4, closed=False)
    _dots(rng, img, 46, dark=(70, 150), rmax=2)
    img *= _smooth_shadow("radial")  # 缓慢阴影最后乘上，覆盖全图
    img += rng.normal(0, 2.0, img.shape)
    return np.clip(img, 0, 255).astype(np.uint8)


def sample_texture(rng: np.random.Generator) -> np.ndarray:
    img = _base_paper(rng, 238, 1.5)
    # 明显纸纹
    img += _paper_texture(rng)
    # 折线（尖角 zigzag），墨色较深
    zig = [(180, 980), (360, 720), (520, 900), (700, 600),
           (880, 860), (1080, 560), (1300, 780)]
    _poly(img, zig, 55, 3)
    # 节点处画实心圆点
    for pt in zig:
        cv2.circle(img, pt, 6, 45, -1, cv2.LINE_AA)
    # 另一条浅一点的折线 + 坐标轴感
    _poly(img, [(200, 300), (420, 380), (640, 260), (860, 420), (1100, 320)],
          175, 2, alpha=0.8)
    _line(img, (160, 1060), (160, 200), 90, 2)
    _line(img, (160, 1060), (1450, 1060), 90, 2)
    # 故意断线
    _line(img, (980, 220), (1120, 220), 80, 2)
    _line(img, (1129, 220), (1280, 220), 80, 2)
    _dots(rng, img, 60, dark=(80, 170), rmax=2)
    img *= _smooth_shadow("vignette")
    img += rng.normal(0, 1.8, img.shape)
    return np.clip(img, 0, 255).astype(np.uint8)


def generate(outdir: str) -> list[str]:
    os.makedirs(outdir, exist_ok=True)
    paths = []
    for name, fn, seed in [
        ("sketch_shadow.png", sample_shadow, 14758),
        ("sketch_paper_texture.png", sample_texture, 24751),
    ]:
        rng = np.random.default_rng(seed)
        img = fn(rng)
        path = os.path.join(outdir, name)
        cv2.imwrite(path, img)
        paths.append(path)
    return paths


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "samples")
    for p in generate(out):
        print(p)
