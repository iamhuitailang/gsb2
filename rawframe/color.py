"""BT.601 YUV→RGB 转换（numpy 向量化），支持 limited/full 两种范围。"""
from __future__ import annotations

import numpy as np

# 标准 BT.601 矩阵（浮点），与主流播放器一致
_KR, _KB = 0.299, 0.114
_KG = 1.0 - _KR - _KB


def _coeffs(color_range: str) -> dict:
    if color_range == "limited":
        # Y: 16..235, C: 16..240（中心 128）
        return {
            "y_scale": 255.0 / 219.0,
            "c_scale": 255.0 / 240.0,
            "y_shift": 16.0, "c_shift": 128.0,
            "vr": 2.0 * (1.0 - _KR),
            "ug": -2.0 * (1.0 - _KB) * _KB / _KG,
            "vg": -2.0 * (1.0 - _KR) * _KR / _KG,
            "ub": 2.0 * (1.0 - _KB),
        }
    # full/JPEG range：Y、C 均为 0..255
    return {
        "y_scale": 1.0, "c_scale": 1.0,
        "y_shift": 0.0, "c_shift": 128.0,
        "vr": 2.0 * (1.0 - _KR),
        "ug": -2.0 * (1.0 - _KB) * _KB / _KG,
        "vg": -2.0 * (1.0 - _KR) * _KR / _KG,
        "ub": 2.0 * (1.0 - _KB),
    }


def yuv_to_rgb(y: np.ndarray, u: np.ndarray, v: np.ndarray,
               color_range: str = "limited") -> np.ndarray:
    """y/u/v 形状一致（已上采样），返回 HxWx3 uint8 RGB。"""
    c = _coeffs(color_range)
    yy = (y.astype(np.float64) - c["y_shift"]) * c["y_scale"]
    uu = (u.astype(np.float64) - c["c_shift"]) * c["c_scale"]
    vv = (v.astype(np.float64) - c["c_shift"]) * c["c_scale"]

    r = yy + c["vr"] * vv
    g = yy + c["ug"] * uu + c["vg"] * vv
    b = yy + c["ub"] * uu
    rgb = np.stack([r, g, b], axis=-1)
    return np.clip(np.rint(rgb), 0, 255).astype(np.uint8)


def rgb_to_yuv_limited(r: int, g: int, b: int) -> tuple[int, int, int]:
    """RGB(0-255) → BT.601 limited YUV，用于生成已知答案的测试样例。"""
    rf, gf, bf = r / 255.0, g / 255.0, b / 255.0
    y = 16 + 219 * (_KR * rf + _KG * gf + _KB * bf)
    # 标准 BT.601 反变换（Cb/Cr，量化范围 16..240）
    u = 128 + 224 * ((-_KR / (2 * (1 - _KB))) * rf
                     + (-_KG / (2 * (1 - _KB))) * gf + 0.5 * bf)
    v = 128 + 224 * (0.5 * rf + (-_KG / (2 * (1 - _KR))) * gf
                     + (-_KB / (2 * (1 - _KR))) * bf)
    return (int(round(y)),
            int(np.clip(round(u), 0, 255)),
            int(np.clip(round(v), 0, 255)))
