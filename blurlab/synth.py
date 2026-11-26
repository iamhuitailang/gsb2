"""生成可复现的测试标牌图：小字、锐利边缘、细线、噪声和多种拖影。

产物
----
- ``board_clean.png``             干净参考图（无模糊、无噪声）
- ``board_blur_<θ>deg_L<L>.png``  全图按同一方向/长度拖影（含噪声）
- ``board_multi.png``             一张图两处不同方向拖影，中间有重叠带
- ``meta.json``                   真值：字线宽度、边缘位置/法向、拖影区域、噪声

版面按 900×600 设计，再等比缩放并居中到请求尺寸，因此任意尺寸下校准边的
法向都不变。条宽按同一比例缩放后取整，真值写入 meta。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from . import kernel
from .image_io import load_image, save_image, write_json

BASE_W, BASE_H = 900, 600

FONT_CANDIDATES = (
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/SFNS.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "C:/Windows/Fonts/arial.ttf",
)


def _font(size: int) -> ImageFont.ImageFont:
    size = max(6, int(round(size)))
    for path in FONT_CANDIDATES:
        try:
            if Path(path).exists():
                return ImageFont.truetype(path, size=size)
        except Exception:  # noqa: BLE001 - 字体不可用就继续找
            pass
    try:
        return ImageFont.load_default(size=size)  # Pillow >= 10.1
    except TypeError:
        return ImageFont.load_default()


@dataclass
class _Transform:
    """设计坐标 -> 目标画布坐标（等比缩放 + 居中）。"""

    scale: float
    ox: float
    oy: float

    @classmethod
    def for_size(cls, w: int, h: int) -> "_Transform":
        s = min(w / BASE_W, h / BASE_H)
        return cls(scale=s, ox=(w - BASE_W * s) / 2.0, oy=(h - BASE_H * s) / 2.0)

    def pt(self, x: float, y: float) -> tuple[float, float]:
        return self.ox + x * self.scale, self.oy + y * self.scale

    def box(self, x0: float, y0: float, x1: float, y1: float) -> list[float]:
        a = self.pt(x0, y0)
        b = self.pt(x1, y1)
        return [a[0], a[1], b[0], b[1]]

    def len(self, v: float) -> float:
        return v * self.scale


@dataclass
class EdgeDef:
    """一条用于校准的直边。

    ``p0``/``p1`` 是**沿边**的两个端点（描述边本身）；
    ``probe_segment()`` 给出跨过这条边的线段，才是估计器要的输入
    （沿法向 ±probe_half）。``probe_half`` 按设计版面留出余量，避免采样窗
    碰到相邻的其它边缘。
    """

    label: str
    p0: tuple[float, float]
    p1: tuple[float, float]
    normal_deg: float
    center: tuple[float, float] = (0.0, 0.0)
    probe_half: float = 16.0

    def probe_segment(self, half: float | None = None) -> tuple[tuple[float, float], tuple[float, float]]:
        """跨过这条边的线段（沿法向 ±half），也就是估计器要的输入。"""
        a = math.radians(self.normal_deg)
        nx, ny = math.cos(a), -math.sin(a)
        h = self.probe_half if half is None else float(half)
        cx, cy = self.center
        return (cx - h * nx, cy - h * ny), (cx + h * nx, cy + h * ny)

    def to_json(self) -> dict:
        p0, p1 = self.probe_segment()
        return {
            "label": self.label,
            "p0": [float(self.p0[0]), float(self.p0[1])],
            "p1": [float(self.p1[0]), float(self.p1[1])],
            "normal_deg": float(self.normal_deg),
            "center": [float(self.center[0]), float(self.center[1])],
            "probe": [[float(p0[0]), float(p0[1])], [float(p1[0]), float(p1[1])]],
            "probe_half_px": float(self.probe_half),
        }


@dataclass
class BlurSpec:
    """一个矩形选区上的拖影参数（真值）。"""

    label: str
    rect: tuple[int, int, int, int]
    length_px: float
    angle_deg: float
    feather_px: float = 12.0

    def to_json(self) -> dict:
        return {
            "label": self.label,
            "rect": [int(v) for v in self.rect],
            "length_px": float(self.length_px),
            "angle_deg": float(self.angle_deg),
            "feather_px": float(self.feather_px),
        }


@dataclass
class BoardMeta:
    width: int
    height: int
    seed: int
    noise_sigma: float = 0.0
    scale: float = 1.0
    bar_widths: list[float] = field(default_factory=list)
    bars: list[dict] = field(default_factory=list)
    edges: list[EdgeDef] = field(default_factory=list)
    no_blur_rect: tuple[int, int, int, int] | None = None
    blur_specs: list[BlurSpec] = field(default_factory=list)
    text_rects: list[tuple[int, int, int, int]] = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            "width": self.width,
            "height": self.height,
            "seed": self.seed,
            "noise_sigma": float(self.noise_sigma),
            "layout_scale": float(self.scale),
            "bar_widths": [float(v) for v in self.bar_widths],
            "bars": self.bars,
            "edges": [e.to_json() for e in self.edges],
            "no_blur_rect": list(self.no_blur_rect) if self.no_blur_rect else None,
            "blur_specs": [b.to_json() for b in self.blur_specs],
            "text_rects": [[int(v) for v in r] for r in self.text_rects],
            "angle_convention": "0=+x, 逆时针为正, 按 180° 取模; 数组 y 向下",
        }


def _background(w: int, h: int) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    base = 0.86 - 0.05 * (yy / max(1, h - 1)) + 0.015 * np.sin(xx / 61.0)
    img = np.repeat(base[..., None], 3, axis=2)
    img *= np.array([1.0, 0.995, 0.985], dtype=np.float32)
    return img


def _draw_bars(draw, meta: BoardMeta, t: _Transform) -> None:
    """条宽按版面比例缩放，真值记录缩放后的整数像素宽。"""
    x_design = 58.0
    gap_design = 10.0
    y0, y1 = t.pt(0, 332)[1], t.pt(0, 408)[1]
    x = t.pt(x_design, 0)[0]
    for i, bw_design in enumerate((2, 3, 4, 6, 8)):
        bw = max(1, int(round(bw_design * t.scale)))
        x0i = int(round(x))
        x1i = x0i + bw
        shade = 26 + 12 * (i % 3)
        draw.rectangle([x0i, y0, x1i - 1, y1], fill=(shade, shade, shade + 4))
        # 真值取自实际绘制的整数像素边界，而不是缩放前的设计值
        meta.bars.append(
            {
                "x0": x0i,
                "x1": x1i,
                "y0": int(round(y0)),
                "y1": int(round(y1)),
                "width_px": float(bw),
            }
        )
        meta.bar_widths.append(float(bw))
        x = x1i + t.len(gap_design)


def _draw_small_text(draw, meta: BoardMeta, t: _Transform) -> None:
    lines = [
        ("PLATFORM 3", 13, (25, 25, 30)),
        ("Departs 08:42  Gate B", 10, (45, 45, 50)),
        ("Zone 2 - East Concourse", 9, (55, 55, 60)),
        ("Please have ticket ready", 8, (70, 70, 75)),
        ("FLIGHT 16317  DELAYED", 11, (120, 20, 20)),
    ]
    y = 104.0
    for text, size, color in lines:
        f = _font(size * t.scale)
        px, py = t.pt(58, y)
        draw.text((px, py), text, font=f, fill=color)
        bbox = draw.textbbox((px, py), text, font=f)
        meta.text_rects.append(tuple(int(v) for v in bbox))
        y += size + 12


def _draw_edge_patches(draw, meta: BoardMeta, t: _Transform) -> None:
    dark = (30, 30, 34)
    light = (232, 232, 228)
    font = _font(11 * t.scale)

    # 竖边：x=530，法向 0°。patch 是 500..570，边两侧各留约 30 px，
    # probe_half 取 14 在设计尺度上（缩放后同步变小），采样窗不会碰到 patch 外沿。
    probe_half = 14.0 * t.scale
    draw.rectangle(t.box(500, 112, 529, 212), fill=dark)
    draw.rectangle(t.box(530, 112, 570, 212), fill=light)
    p0 = t.pt(530, 112)
    p1 = t.pt(530, 212)
    meta.edges.append(EdgeDef("edge_v", p0, p1, 0.0, t.pt(530, 162), probe_half))
    draw.text(t.pt(504, 216), "V", font=font, fill=(40, 40, 40))

    # 横边：y=140，法向 90°。上方 patch 到 112，下方到 180。
    draw.rectangle(t.box(600, 112, 700, 139), fill=dark)
    draw.rectangle(t.box(600, 140, 700, 180), fill=light)
    p0 = t.pt(600, 140)
    p1 = t.pt(700, 140)
    meta.edges.append(EdgeDef("edge_h", p0, p1, 90.0, t.pt(650, 140), probe_half))
    draw.text(t.pt(704, 146), "H", font=font, fill=(40, 40, 40))

    # 45° 斜边：暗三角 (500,255)-(500,365)-(610,365) 的斜边从 (500,255) 到
    # (610,365)。数组坐标下边的方向是 (110,110)，屏幕角 = atan2(-110,110) = -45°
    # ≡ 135°；因此**法向**为 45°（不是 135°——那是边的方向）。
    # 中心 (555,310) 在斜边上；到另外两条直角边(x=500,y=365)的垂距约 55，
    # probe_half 取 12 设计 px 不会碰到它们。
    draw.polygon([t.pt(500, 255), t.pt(500, 365), t.pt(610, 365)], fill=dark)
    draw.rectangle(t.box(610, 255, 660, 365), fill=light)
    p0 = t.pt(500, 255)
    p1 = t.pt(610, 365)
    meta.edges.append(EdgeDef("edge_45", p0, p1, 45.0, t.pt(555, 310), 12.0 * t.scale))
    draw.text(t.pt(614, 250), "45", font=font, fill=(40, 40, 40))


def _draw_fine_patterns(draw, t: _Transform) -> None:
    step = max(2, int(round(2 * t.scale)))
    for y in range(0, 110, step):
        for x in range(0, 160, step):
            if ((x // step) + (y // step)) % 2 == 0:
                bx = t.pt(690 + x, 255 + y)
                draw.rectangle([bx[0], bx[1], bx[0] + step, bx[1] + step], fill=(70, 72, 78))
    for x in range(60, 260, 6):
        draw.line([t.pt(x, 430), t.pt(x, 500)], fill=(120, 120, 126), width=1)
    for y in range(430, 501, 6):
        draw.line([t.pt(60, y), t.pt(260, y)], fill=(120, 120, 126), width=1)


def _draw_color_chips(draw, t: _Transform) -> None:
    colors = [(180, 40, 40), (40, 120, 60), (40, 70, 150), (200, 160, 30)]
    for i, c in enumerate(colors):
        draw.rectangle(t.box(620 + i * 26, 430, 642 + i * 26, 470), fill=c)


def generate_board(
    width: int = BASE_W, height: int = BASE_H, seed: int = 16317
) -> tuple[np.ndarray, BoardMeta]:
    """生成干净测试板，返回 float RGB 与真值。"""
    t = _Transform.for_size(width, height)
    meta = BoardMeta(width=width, height=height, seed=seed, scale=t.scale)

    base = _background(width, height)
    pil = Image.fromarray(np.clip(np.rint(base * 255), 0, 255).astype(np.uint8), "RGB")
    draw = ImageDraw.Draw(pil)

    draw.rectangle(t.box(0, 0, BASE_W, 76), fill=(28, 46, 74))
    draw.text(t.pt(44, 22), "STATION 12  /  DEPARTURES",
              font=_font(26 * t.scale), fill=(240, 242, 246))
    draw.text(t.pt(BASE_W - 210, 30), "CAPTURE TEST",
              font=_font(13 * t.scale), fill=(180, 196, 220))

    _draw_small_text(draw, meta, t)
    _draw_bars(draw, meta, t)
    _draw_edge_patches(draw, meta, t)
    _draw_fine_patterns(draw, t)
    _draw_color_chips(draw, t)

    draw.rectangle(t.box(620, 500, 860, 566), fill=(205, 205, 200))
    for x in range(630, 850, 11):
        draw.line([t.pt(x, 508), t.pt(x, 558)], fill=(185, 185, 182), width=1)
    rect = t.box(620, 500, 860, 566)
    meta.no_blur_rect = (
        int(round(rect[0])),
        int(round(rect[1])),
        int(round(rect[2])),
        int(round(rect[3])),
    )
    draw.text(t.pt(622, 570), "CLEAN REFERENCE AREA", font=_font(9 * t.scale), fill=(90, 90, 90))
    draw.text(t.pt(58, 516), "BARS: 2 3 4 6 8 px", font=_font(10 * t.scale), fill=(60, 60, 60))

    arr = np.asarray(pil, dtype=np.float32) / 255.0
    return arr, meta


def add_capture_noise(img: np.ndarray, sigma: float, seed: int = 0) -> np.ndarray:
    """叠加高斯读出噪声 + 少量色度噪声，模拟抓拍。"""
    a = np.asarray(img, dtype=np.float32)
    if sigma <= 0:
        return a.copy()
    rng = np.random.default_rng(seed)
    lum = rng.normal(0.0, sigma, size=a.shape[:2]).astype(np.float32)
    chroma = rng.normal(0.0, sigma * 0.35, size=a.shape).astype(np.float32)
    return np.clip(a + lum[..., None] + chroma, 0.0, 1.0)


def feather_mask(shape: tuple[int, int], rect: tuple[int, int, int, int], feather: float) -> np.ndarray:
    """矩形掩膜，边界向内做余弦羽化；返回 float32 [0,1]。"""
    h, w = shape
    x0, y0, x1, y1 = [int(v) for v in rect]
    x0, x1 = sorted((x0, x1))
    y0, y1 = sorted((y0, y1))
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(w, x1), min(h, y1)
    m = np.zeros((h, w), dtype=np.float32)
    if x1 <= x0 or y1 <= y0:
        return m
    fx = max(0.0, float(feather))
    xs = np.arange(x0, x1, dtype=np.float32)
    ys = np.arange(y0, y1, dtype=np.float32)
    wx = np.ones_like(xs)
    wy = np.ones_like(ys)
    if fx > 0:
        left = np.clip((xs - x0) / fx, 0, 1)
        right = np.clip((x1 - 1 - xs) / fx, 0, 1)
        wx = 0.5 - 0.5 * np.cos(np.pi * np.minimum(left, right))
        top = np.clip((ys - y0) / fx, 0, 1)
        bottom = np.clip((y1 - 1 - ys) / fx, 0, 1)
        wy = 0.5 - 0.5 * np.cos(np.pi * np.minimum(top, bottom))
    m[y0:y1, x0:x1] = wy[:, None] * wx[None, :]
    return m


def blur_regions(
    img: np.ndarray,
    specs: list[BlurSpec],
    sensor_sigma: float = 0.6,
) -> tuple[np.ndarray, np.ndarray]:
    """按各自参数分别模糊选区，再按羽化掩膜合成。返回 (图像, 累计掩膜)。"""
    a = np.asarray(img, dtype=np.float32)
    out = a.copy()
    coverage = np.zeros(a.shape[:2], dtype=np.float32)
    for spec in specs:
        blurred = kernel.blur_image(a, spec.length_px, spec.angle_deg, sigma=sensor_sigma)
        m = feather_mask(a.shape[:2], spec.rect, spec.feather_px)[..., None]
        out = out * (1.0 - m) + blurred * m
        coverage = np.maximum(coverage, m[..., 0])
    return out.astype(np.float32), coverage


def save_sample_suite(
    outdir: str | Path,
    width: int = BASE_W,
    height: int = BASE_H,
    seed: int = 16317,
    noise_sigma: float = 0.012,
    sensor_sigma: float = 0.6,
    variants: list[tuple[float, float]] | None = None,
) -> dict:
    """生成并保存整套样例，返回路径字典。"""
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    if variants is None:
        variants = [
            (30.0, 9.0),
            (60.0, 15.0),
            (90.0, 11.0),
            (120.0, 21.0),
            (0.0, 7.0),
            (135.0, 17.0),
        ]

    clean, meta = generate_board(width, height, seed)
    meta.noise_sigma = 0.0
    save_image(outdir / "board_clean.png", clean)

    paths: dict[str, object] = {
        "clean": str(outdir / "board_clean.png"),
        "variants": [],
        "multi": [],
    }

    for i, (angle, length) in enumerate(variants):
        blurred = kernel.blur_image(clean, length, angle, sigma=sensor_sigma)
        noisy = add_capture_noise(blurred, noise_sigma, seed=seed + 11 + i)
        name = f"board_blur_{int(round(angle))}deg_L{int(round(length))}.png"
        save_image(outdir / name, noisy)
        paths["variants"].append(
            {
                "path": str(outdir / name),
                "angle_deg": float(angle),
                "length_px": float(length),
                "noise_sigma": float(noise_sigma),
            }
        )

    # 两个区域，中心交叉重叠；A 先处理，B 后处理
    specs = [
        BlurSpec("A", (470, 238, 700, 408), 13.0, 30.0, 12.0),
        BlurSpec("B", (600, 296, 862, 486), 9.0, 120.0, 12.0),
    ]
    multi_blurred, coverage = blur_regions(clean, specs, sensor_sigma=sensor_sigma)
    multi = add_capture_noise(multi_blurred, noise_sigma, seed=seed + 101)
    save_image(outdir / "board_multi.png", multi)
    paths["multi"].append(str(outdir / "board_multi.png"))

    meta.blur_specs = specs
    meta.noise_sigma = float(noise_sigma)
    meta_json = meta.to_json()
    meta_json["variants"] = paths["variants"]
    meta_json["multi"] = {
        "path": str(outdir / "board_multi.png"),
        "blur_specs": [s.to_json() for s in specs],
        "overlap_rect": [600, 296, 700, 408],
        "noise_sigma": float(noise_sigma),
    }
    write_json(outdir / "meta.json", meta_json)
    paths["meta"] = str(outdir / "meta.json")
    return paths


def load_board(path: str | Path) -> np.ndarray:
    return load_image(path)
