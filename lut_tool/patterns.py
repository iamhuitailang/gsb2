"""程序生成的测试短片。

一帧的版面（默认 640×360）::

    +--------------------------------------------------+
    | 顶部色条：边界高饱和原色/补色 + 黑白            |
    +--------------------------------------------------+
    | 中性灰阶（11 级，覆盖 0..1） | 平滑水平渐变     |
    |                              | （R/G/B 三条）   |
    +------------------------------+-------------------+
    | 肤色带（深->浅多档肤色）     | 运动球 + 扫掠条  |
    +--------------------------------------------------+

所有值都是 float64 RGB、归一化 [0,1]；运动元素让逐帧同步问题肉眼可见。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# 版面分区（比例坐标，便于按尺寸缩放）。
REGIONS = {
    "top_bars": (0.00, 0.00, 1.00, 0.16),
    "gray_ramp": (0.00, 0.16, 0.55, 0.62),
    "smooth_gradient": (0.55, 0.16, 1.00, 0.62),
    "skin_band": (0.00, 0.62, 0.55, 1.00),
    "motion": (0.55, 0.62, 1.00, 1.00),
}

# 一组贴近 sRGB 常见肤色的参考色（深 -> 浅），故意覆盖表容易偏色的区间。
SKIN_TONES = np.array(
    [
        [0.36, 0.22, 0.16],
        [0.48, 0.31, 0.24],
        [0.60, 0.42, 0.33],
        [0.71, 0.53, 0.42],
        [0.82, 0.65, 0.53],
        [0.92, 0.79, 0.68],
    ],
    dtype=np.float64,
)

# 边界高饱和色（纯通道取满/取零）+ 中性黑白。
SATURATED_SWATCHES = np.array(
    [
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 1.0, 0.0],
        [0.0, 1.0, 1.0],
        [1.0, 0.0, 1.0],
        [1.0, 1.0, 1.0],
        [0.0, 0.0, 0.0],
    ],
    dtype=np.float64,
)


@dataclass
class TestClipSpec:
    width: int = 640
    height: int = 360
    fps: float = 30.0
    frames: int = 48  # 1.6 秒，足够观察播放同步

    @property
    def duration(self) -> float:
        return self.frames / self.fps


def _region_bounds(spec: TestClipSpec, name: str) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = REGIONS[name]
    return (
        int(round(x0 * spec.width)),
        int(round(y0 * spec.height)),
        int(round(x1 * spec.width)),
        int(round(y1 * spec.height)),
    )


def _fill(frame: np.ndarray, bounds: tuple[int, int, int, int], color: np.ndarray) -> None:
    x0, y0, x1, y1 = bounds
    frame[y0:y1, x0:x1] = color


def render_frame(spec: TestClipSpec, index: int) -> np.ndarray:
    """渲染第 ``index`` 帧（0 起始），返回 float64 RGB 数组。"""
    h, w = spec.height, spec.width
    frame = np.zeros((h, w, 3), dtype=np.float64)
    phase = index / max(spec.frames - 1, 1)

    # ---- 顶部高饱和色条 ------------------------------------------------
    bx0, by0, bx1, by1 = _region_bounds(spec, "top_bars")
    bw = bx1 - bx0
    for i, color in enumerate(SATURATED_SWATCHES):
        x0 = bx0 + int(round(i * bw / len(SATURATED_SWATCHES)))
        x1 = bx0 + int(round((i + 1) * bw / len(SATURATED_SWATCHES)))
        frame[by0:by1, x0:x1] = color

    # ---- 中性灰阶：11 级离散色块 --------------------------------------
    gx0, gy0, gx1, gy1 = _region_bounds(spec, "gray_ramp")
    levels = 11
    gw = gx1 - gx0
    for i in range(levels):
        v = i / (levels - 1)
        x0 = gx0 + int(round(i * gw / levels))
        x1 = gx0 + int(round((i + 1) * gw / levels))
        frame[gy0:gy1, x0:x1] = v

    # ---- 平滑渐变：R/G/B 各自独立的水平斜坡 ---------------------------
    sx0, sy0, sx1, sy1 = _region_bounds(spec, "smooth_gradient")
    sw, sh = sx1 - sx0, sy1 - sy0
    ramp = np.linspace(0.0, 1.0, sw, dtype=np.float64)
    band_h = max(sh // 3, 1)
    for c in range(3):
        y0 = sy0 + c * band_h
        y1 = sy0 + sh if c == 2 else y0 + band_h
        frame[y0:y1, sx0:sx1, c] = ramp[None, :]
        # 另两个通道保持 0，保证纯通道斜坡可用于通道串换检查。

    # ---- 肤色带 --------------------------------------------------------
    kx0, ky0, kx1, ky1 = _region_bounds(spec, "skin_band")
    kw = kx1 - kx0
    for i, tone in enumerate(SKIN_TONES):
        x0 = kx0 + int(round(i * kw / len(SKIN_TONES)))
        x1 = kx0 + int(round((i + 1) * kw / len(SKIN_TONES)))
        frame[ky0:ky1, x0:x1] = tone

    # ---- 运动区：来回移动的球 + 横向扫掠条 ----------------------------
    mx0, my0, mx1, my1 = _region_bounds(spec, "motion")
    _fill(frame, (mx0, my0, mx1, my1), np.array([0.06, 0.06, 0.06]))
    mw, mh = mx1 - mx0, my1 - my0

    radius = max(min(mh, mw) // 8, 3)
    cx = mx0 + int(radius + (mw - 2 * radius) * (0.5 + 0.5 * np.sin(2 * np.pi * phase)))
    cy = my0 + mh // 2
    yy, xx = np.ogrid[:h, :w]
    disk = (xx - cx) ** 2 + (yy - cy) ** 2 <= radius ** 2
    frame[disk] = np.array([0.95, 0.85, 0.4])

    sweep_x = mx0 + int(phase * (mw - 1))
    frame[my0:my1, sweep_x : min(sweep_x + 2, mx1)] = np.array([0.4, 0.8, 1.0])

    return frame


def render_clip(spec: TestClipSpec | None = None) -> np.ndarray:
    """渲染整部测试片，返回形状 ``(F, H, W, 3)`` 的 float64 数组。"""
    spec = spec or TestClipSpec()
    return np.stack([render_frame(spec, i) for i in range(spec.frames)])


def region_of_interest(spec: TestClipSpec, name: str) -> tuple[int, int, int, int]:
    """对外暴露分区边界（分析模块按区取样用）。"""
    return _region_bounds(spec, name)
