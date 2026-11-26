"""同比例对比视图：原图 / 结果 / 残差共用一套缩放与平移。

GUI 与无界面导出都走这里，保证"按同一比例看三张图"不是界面特有的行为。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw

from .image_io import luma


@dataclass
class ViewState:
    """屏幕坐标下的缩放/平移。图像坐标 -> 屏幕坐标：s = img * scale + offset。"""

    scale: float = 1.0
    off_x: float = 0.0
    off_y: float = 0.0
    min_scale: float = 0.05
    max_scale: float = 16.0

    def image_to_screen(self, x: float, y: float) -> tuple[float, float]:
        return x * self.scale + self.off_x, y * self.scale + self.off_y

    def screen_to_image(self, sx: float, sy: float) -> tuple[float, float]:
        return (sx - self.off_x) / self.scale, (sy - self.off_y) / self.scale

    def fit(self, img_w: int, img_h: int, view_w: int, view_h: int, pad: int = 8) -> None:
        sx = (view_w - 2 * pad) / max(1, img_w)
        sy = (view_h - 2 * pad) / max(1, img_h)
        self.scale = float(np.clip(min(sx, sy), self.min_scale, self.max_scale))
        self.off_x = (view_w - img_w * self.scale) / 2.0
        self.off_y = (view_h - img_h * self.scale) / 2.0

    def zoom_at(self, factor: float, sx: float, sy: float) -> None:
        ix, iy = self.screen_to_image(sx, sy)
        new_scale = float(np.clip(self.scale * factor, self.min_scale, self.max_scale))
        self.scale = new_scale
        self.off_x = sx - ix * new_scale
        self.off_y = sy - iy * new_scale

    def pan_by(self, dx: float, dy: float) -> None:
        self.off_x += dx
        self.off_y += dy

    def visible_rect(
        self, img_w: int, img_h: int, view_w: int, view_h: int
    ) -> tuple[int, int, int, int]:
        """当前视口在图像坐标中可见的矩形（已裁到图内）。"""
        x0, y0 = self.screen_to_image(0.0, 0.0)
        x1, y1 = self.screen_to_image(float(view_w), float(view_h))
        return (
            int(max(0, np.floor(x0))),
            int(max(0, np.floor(y0))),
            int(min(img_w, np.ceil(x1))),
            int(min(img_h, np.ceil(y1))),
        )


@dataclass
class PaneSpec:
    title: str
    image: np.ndarray
    gain: float = 8.0


def residual_to_gray(residual: np.ndarray, gain: float = 8.0) -> np.ndarray:
    r = np.asarray(residual, dtype=np.float32)
    if r.ndim == 3:
        r = r.mean(axis=2)
    return np.clip(0.5 + gain * r, 0.0, 1.0)


def _to_rgb8(img: np.ndarray) -> Image.Image:
    a = np.asarray(img, dtype=np.float32)
    if a.ndim == 2:
        a = np.repeat(a[..., None], 3, axis=2)
    elif a.shape[2] == 1:
        a = np.repeat(a, 3, axis=2)
    u8 = np.clip(np.rint(a[..., :3] * 255.0), 0, 255).astype(np.uint8)
    return Image.fromarray(u8, "RGB")


def _render_pane(
    img: np.ndarray,
    view: ViewState,
    size: tuple[int, int],
    rect: tuple[int, int, int, int] | None,
) -> Image.Image:
    """把图像按 view 渲染到 size 画布上，可画选区框。"""
    vw, vh = size
    src = _to_rgb8(img)
    iw, ih = src.size

    # 可见的图像区域（裁剪后再缩放，避免整图缩放的开销与失真）
    x0 = max(0.0, -view.off_x / view.scale)
    y0 = max(0.0, -view.off_y / view.scale)
    x1 = min(float(iw), (vw - view.off_x) / view.scale)
    y1 = min(float(ih), (vh - view.off_y) / view.scale)
    canvas = Image.new("RGB", (vw, vh), (24, 24, 28))
    if x1 <= x0 or y1 <= y0:
        return canvas

    crop_box = (int(np.floor(x0)), int(np.floor(y0)), int(np.ceil(x1)), int(np.ceil(y1)))
    crop = src.crop(crop_box)
    new_size = (
        max(1, int(round(crop.width * view.scale))),
        max(1, int(round(crop.height * view.scale))),
    )
    resample = Image.NEAREST if view.scale >= 3.0 else Image.BILINEAR
    scaled = crop.resize(new_size, resample)
    px = int(round(crop_box[0] * view.scale + view.off_x))
    py = int(round(crop_box[1] * view.scale + view.off_y))
    canvas.paste(scaled, (px, py))

    draw = ImageDraw.Draw(canvas)
    if rect is not None:
        rx0 = rect[0] * view.scale + view.off_x
        ry0 = rect[1] * view.scale + view.off_y
        rx1 = rect[2] * view.scale + view.off_x
        ry1 = rect[3] * view.scale + view.off_y
        draw.rectangle([rx0, ry0, rx1, ry1], outline=(255, 210, 60), width=2)
    return canvas


def render_triptych(
    original: np.ndarray,
    result: np.ndarray,
    residual: np.ndarray,
    view: ViewState | None = None,
    pane_size: tuple[int, int] = (420, 300),
    rect: tuple[int, int, int, int] | None = None,
    residual_gain: float = 8.0,
    labels: tuple[str, str, str] = ("原图", "结果", "残差 (原图-结果)"),
) -> tuple[Image.Image, ViewState]:
    """渲染三联图（无界面导出/GUI 共用），三格共用同一 ViewState。"""
    h, w = original.shape[:2]
    vw, vh = pane_size
    if view is None:
        view = ViewState()
        view.fit(w, h, vw, vh)

    panes = [
        _render_pane(original, view, pane_size, rect),
        _render_pane(result, view, pane_size, rect),
        _render_pane(residual_to_gray(residual, residual_gain), view, pane_size, rect),
    ]

    header = 22
    gap = 8
    total_w = vw * 3 + gap * 2
    total_h = vh + header
    out = Image.new("RGB", (total_w, total_h), (18, 18, 22))
    draw = ImageDraw.Draw(out)
    for i, (pane, label) in enumerate(zip(panes, labels)):
        x = i * (vw + gap)
        out.paste(pane, (x, header))
        draw.text((x + 6, 5), label, fill=(230, 230, 235))
    # 比例尺：同一 scale，三格一致
    bar_img_px = _nice_scale_bar(view.scale)
    bar_screen = bar_img_px * view.scale
    bx = 10
    by = total_h - 16
    draw.line([(bx, by), (bx + bar_screen, by)], fill=(255, 255, 255), width=2)
    draw.text((bx, by - 12), f"{bar_img_px:g} px  缩放 {view.scale:.2f}x", fill=(235, 235, 235))
    return out, view


def _nice_scale_bar(scale: float) -> float:
    """选一个在屏幕上约 60-140 px 的整齐图像长度。"""
    candidates = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000]
    target = 100.0 / max(1e-6, scale)
    best = min(candidates, key=lambda c: abs(c - target))
    return float(best)


def format_sweep_table(rows: list[dict]) -> str:
    if not rows:
        return "(无扫描结果)"
    headers = ["长度", "方向", "噪声上限", "实际增益", "梯度恢复", "残差RMS"]
    lines = ["  ".join(f"{h:<8}" for h in headers)]
    for r in rows:
        gr = r.get("gradient_recovery")
        gr_s = f"{gr:.3f}" if gr is not None and np.isfinite(gr) else "n/a"
        lines.append(
            "  ".join(
                [
                    f"{r['length_px']:<8.1f}",
                    f"{r['angle_deg']:<8.1f}",
                    f"{r['noise_gain']:<8.1f}",
                    f"{r['effective_noise_gain']:<8.2f}",
                    f"{gr_s:<8}",
                    f"{r['residual_rms']:<8.4f}",
                ]
            )
        )
    return "\n".join(lines)


def best_sweep_row(rows: list[dict], key: str = "gradient_recovery") -> dict | None:
    """按梯度恢复率取最好的参数行。"""
    vals = [r for r in rows if r.get(key) is not None and np.isfinite(r[key])]
    return max(vals, key=lambda r: r[key]) if vals else None


def flatness_of_residual(residual: np.ndarray) -> float:
    """残差的平坦度代理：无拖影区域残差应接近 0。返回平均绝对残差。"""
    r = np.asarray(residual, dtype=np.float32)
    if r.ndim == 3:
        r = luma(r)
    return float(np.mean(np.abs(r)))
