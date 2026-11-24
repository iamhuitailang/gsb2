"""合成测试图:细格线纸面 + 多方向/多尺度周期干扰。

默认尺寸为奇数 (513x517),验证边缘与奇数尺寸处理。
"""
from __future__ import annotations

import numpy as np


def make_stripes(shape, period_px, angle_deg, amplitude, phase=0.0):
    """正弦条纹。angle 为波矢方向(条纹法向),单位度。"""
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    th = np.radians(angle_deg)
    k = 2 * np.pi / period_px
    return (amplitude * np.sin(k * (xx * np.cos(th) + yy * np.sin(th)) + phase)).astype(np.float32)


def make_grid(shape, spacing=8, line_width=1, angle_deg=0.0, darkness=0.55):
    """细方格线(模拟坐标纸)。返回 [0,1] 的格线掩膜,1=线。"""
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    th = np.radians(angle_deg)
    u = xx * np.cos(th) + yy * np.sin(th)
    v = -xx * np.sin(th) + yy * np.cos(th)
    grid = np.zeros(shape, dtype=np.float32)
    for coord in (u, v):
        d = np.abs((coord % spacing) - spacing / 2)
        grid = np.maximum(grid, (d > (spacing - line_width) / 2).astype(np.float32))
    return grid * darkness


def make_paper(shape, seed=0):
    """纸面底:缓变亮度 + 轻微噪声。"""
    rng = np.random.default_rng(seed)
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    base = 0.86 + 0.05 * np.sin(yy / h * np.pi) * np.cos(xx / w * np.pi)
    base += rng.normal(0, 0.012, shape).astype(np.float32)
    return base.astype(np.float32)


def synth_scene(shape=(513, 517), color=False, seed=0):
    """返回 dict: clean / corrupted / interference / grid_mask / peaks(真值)。

    干扰成分:
      A: 斜网纹主干扰   周期 6.0px, 方向 32°
      B/C: 两条频率挨得很近的条纹  周期 5.0px 与 5.35px, 方向 -18° (会产生拍频)
      D: 大尺度缓变网纹  周期 23px, 方向 75°
    彩色版干扰带色度分量(各通道相位不同),用于观察是否引入颜色条纹。
    """
    h, w = shape
    grid = make_grid(shape, spacing=8, line_width=1, darkness=0.5)
    clean = make_paper(shape, seed) - grid

    comps = [
        dict(period=6.0,  angle=32.0,  amp=0.16, phase=0.0),
        dict(period=5.0,  angle=-18.0, amp=0.10, phase=0.7),
        dict(period=5.35, angle=-18.0, amp=0.10, phase=2.1),
        dict(period=23.0, angle=75.0,  amp=0.07, phase=1.0),
    ]
    interf = np.zeros(shape, dtype=np.float32)
    for c in comps:
        interf += make_stripes(shape, c["period"], c["angle"], c["amp"], c["phase"])

    truth_peaks = [dict(fy=np.sin(np.radians(c["angle"])) / c["period"],
                        fx=np.cos(np.radians(c["angle"])) / c["period"])
                   for c in comps]

    if not color:
        return dict(clean=np.clip(clean, 0, 1),
                    corrupted=np.clip(clean + interf, 0, 1),
                    interference=interf, grid_mask=grid, truth_peaks=truth_peaks)

    # 彩色:纸面带一点暖色,干扰各通道相位错开(模拟扫描仪色彩串扰)
    clean_c = np.stack([clean * 1.00, clean * 0.985, clean * 0.955], axis=-1)
    interf_c = np.stack([
        interf,
        np.roll(interf, 1, axis=1) * 0.9,
        np.roll(interf, 2, axis=1) * 0.8,
    ], axis=-1).astype(np.float32)
    return dict(clean=np.clip(clean_c, 0, 1),
                corrupted=np.clip(clean_c + interf_c, 0, 1),
                interference=interf_c, grid_mask=grid, truth_peaks=truth_peaks)
