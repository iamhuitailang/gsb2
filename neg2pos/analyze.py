"""分析: 通道截断警示、剩余层次估计、近片底/过深区域标记与预览叠加。"""
from __future__ import annotations

import numpy as np

from .core import RollCalib

CLIP_LO = 1.0 / 255.0
CLIP_HI = 254.0 / 255.0


def clipping_report(img: np.ndarray, roll: RollCalib) -> dict:
    """每通道: 高/低端截断像素占比、片底到截断点之间还剩多少码值和档数。"""
    base = np.asarray(roll.base_rgb, dtype=np.float64)
    channels = []
    for c, name in enumerate("RGB"):
        ch = img[..., c].astype(np.float64)
        hi_frac = float((ch >= CLIP_HI).mean())
        lo_frac = float((ch <= CLIP_LO).mean())
        # 剩余层次: 8bit 码值下, 片底与黑场之间仍可分辨的级数
        levels = max(int(round(base[c] * 255)) - 1, 0)
        # 密度余量: 从片底到最低未截断值还能表达几档
        headroom = float(-np.log2(max(CLIP_LO, 1e-6) / max(base[c], 1e-6)))
        channels.append({
            "channel": name,
            "clip_high_frac": round(hi_frac, 5),
            "clip_low_frac": round(lo_frac, 5),
            "remaining_levels_8bit": levels,
            "density_headroom_stops": round(headroom, 2),
        })
    warn = any(c["clip_high_frac"] > 0.001 or c["clip_low_frac"] > 0.001 for c in channels)
    return {"channels": channels, "clipping_warning": warn}


def region_masks(img: np.ndarray, roll: RollCalib,
                 base_tol: float = 0.02, dark_level: float = 2.0 / 255.0) -> dict[str, np.ndarray]:
    """近片底(正片将死黑)与过深(扫描接近0, 正片高光溢出)区域掩码。"""
    base = np.asarray(roll.base_rgb, dtype=np.float32)
    near_base = (np.abs(img - base).max(axis=-1) < base_tol)
    too_dark = img.max(axis=-1) < dark_level
    clip_hi = (img >= CLIP_HI).any(axis=-1)
    clip_lo = (img <= CLIP_LO).any(axis=-1)
    return {"near_base": near_base, "too_dark": too_dark,
            "clip_high": clip_hi, "clip_low": clip_lo}


def overlay_preview(positive: np.ndarray, masks: dict[str, np.ndarray],
                    alpha: float = 0.55) -> np.ndarray:
    """在正片预览上叠加标记: 蓝=近片底, 红=过深, 品红=通道截断。"""
    out = positive.copy()
    colors = {"near_base": (0.2, 0.4, 1.0), "too_dark": (1.0, 0.15, 0.1),
              "clip_high": (1.0, 0.0, 1.0), "clip_low": (1.0, 0.0, 1.0)}
    for name, color in colors.items():
        m = masks[name]
        if m.any():
            out[m] = (1 - alpha) * out[m] + alpha * np.asarray(color, dtype=np.float32)
    return out


def mask_summary(masks: dict[str, np.ndarray]) -> dict:
    return {name: round(float(m.mean()), 5) for name, m in masks.items()}


def format_report(rep: dict) -> str:
    lines = ["通道  高端截断%  低端截断%  剩余层次(8bit码值)  密度余量(档)"]
    for c in rep["channels"]:
        lines.append(f"  {c['channel']}   {c['clip_high_frac']*100:8.3f}  "
                     f"{c['clip_low_frac']*100:8.3f}  {c['remaining_levels_8bit']:16d}  "
                     f"{c['density_headroom_stops']:10.2f}")
    if rep["clipping_warning"]:
        lines.append("!! 警示: 存在通道截断, 上述区域层次已丢失, 可查看剩余层次评估影响")
    return "\n".join(lines)
