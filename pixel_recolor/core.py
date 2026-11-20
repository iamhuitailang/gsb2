"""换色核心引擎。

设计要点：
- 只处理 alpha > 0 的像素，完全透明区域不参与换色；
- 抗锯齿边缘：匹配按 RGB 距离计算权重 w（0~1），
  新颜色 = 原色 与 "目标色 + (原色 - 源色)" 按 w 插值，
  因此半透明/过渡像素按颜色比例平滑过渡，不会留下色边；
- alpha 通道全程保持不变，边缘的透明度渐变被完整保留；
- 支持保护色（颜色组排除）与排除蒙版（图层式排除）。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from PIL import Image


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    """'#rrggbb' 或 'rrggbb' -> (r, g, b)。"""
    s = value.strip().lstrip("#")
    if len(s) != 6:
        raise ValueError(f"无效颜色: {value!r}")
    return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)


def rgb_to_hex(rgb: tuple[int, int, int]) -> str:
    return "#{:02x}{:02x}{:02x}".format(*[max(0, min(255, int(c))) for c in rgb])


@dataclass
class ColorMapping:
    """一条换色规则：把 src 附近（tolerance 内）的颜色替换为 dst。"""

    src: str  # '#rrggbb'
    dst: str  # '#rrggbb'
    tolerance: int = 0  # 0 = 精确匹配；>0 按 RGB 欧氏距离渐变匹配
    enabled: bool = True

    def to_dict(self) -> dict:
        return {
            "src": self.src,
            "dst": self.dst,
            "tolerance": self.tolerance,
            "enabled": self.enabled,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "ColorMapping":
        return cls(
            src=d["src"],
            dst=d["dst"],
            tolerance=int(d.get("tolerance", 0)),
            enabled=bool(d.get("enabled", True)),
        )


@dataclass
class Scheme:
    """一套调色方案：多条换色规则 + 保护色（颜色组排除）。"""

    name: str
    mappings: list[ColorMapping] = field(default_factory=list)
    protected: list[str] = field(default_factory=list)  # '#rrggbb' 精确匹配，永不改动

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "mappings": [m.to_dict() for m in self.mappings],
            "protected": list(self.protected),
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Scheme":
        return cls(
            name=d["name"],
            mappings=[ColorMapping.from_dict(m) for m in d.get("mappings", [])],
            protected=list(d.get("protected", [])),
        )


def load_rgba(path: str) -> np.ndarray:
    """读取图片为 HxWx4 uint8 数组（统一转 RGBA）。"""
    with Image.open(path) as im:
        return np.asarray(im.convert("RGBA"), dtype=np.uint8)


def save_rgba(arr: np.ndarray, path: str) -> None:
    Image.fromarray(arr.astype(np.uint8), "RGBA").save(path)


def _match_weights(
    rgb: np.ndarray, mapping: ColorMapping
) -> tuple[np.ndarray, np.ndarray]:
    """返回 (weight, shifted)：

    weight: HxW float32，0~1，像素受该规则影响的程度；
    shifted: HxWx3 float32，按 "目标色 + (原色 - 源色)" 平移后的颜色。
    """
    src = np.array(hex_to_rgb(mapping.src), dtype=np.float32)
    dst = np.array(hex_to_rgb(mapping.dst), dtype=np.float32)
    rgbf = rgb.astype(np.float32)
    dist = np.sqrt(((rgbf - src) ** 2).sum(axis=-1))
    tol = float(max(0, mapping.tolerance))
    if tol <= 0:
        weight = (dist == 0).astype(np.float32)
    else:
        weight = np.clip(1.0 - dist / tol, 0.0, 1.0).astype(np.float32)
    shifted = rgbf + (dst - src)
    return weight, shifted


def apply_scheme(
    arr: np.ndarray,
    scheme: Scheme,
    exclude_mask: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """对 RGBA 数组应用一套方案。

    参数:
        arr: HxWx4 uint8。
        exclude_mask: 可选 HxW bool，True 表示该像素被排除（图层式排除）。
    返回:
        (结果数组, changed) —— changed 为 HxW bool，标记实际被改动的像素，
        用于预览"哪些像素会被改动"。
    """
    out = arr.astype(np.float32).copy()
    h, w = out.shape[:2]
    alpha = arr[..., 3]
    opaque = alpha > 0  # 透明区域不参与换色

    blocked = np.zeros((h, w), dtype=bool)
    if exclude_mask is not None:
        if exclude_mask.shape != (h, w):
            raise ValueError(
                f"排除蒙版尺寸 {exclude_mask.shape} 与图片 {(h, w)} 不一致"
            )
        blocked |= exclude_mask
    if scheme.protected:
        protected_rgb = np.array(
            [hex_to_rgb(c) for c in scheme.protected], dtype=np.uint8
        )
        rgb8 = arr[..., :3]
        for c in protected_rgb:
            blocked |= (rgb8 == c).all(axis=-1)

    free = opaque & ~blocked
    changed = np.zeros((h, w), dtype=bool)

    for mapping in scheme.mappings:
        if not mapping.enabled:
            continue
        weight, shifted = _match_weights(out[..., :3], mapping)
        weight = np.where(free, weight, 0.0)
        w3 = weight[..., None]
        out[..., :3] = out[..., :3] * (1.0 - w3) + shifted * w3
        changed |= weight > 0

    out[..., 3] = alpha  # alpha 通道保持不变，保留半透明边缘
    return np.clip(out, 0, 255).round().astype(np.uint8), changed


def extract_palette(arr: np.ndarray, max_colors: int = 64) -> list[tuple[str, int]]:
    """提取不透明像素的颜色调色板，返回 [('#rrggbb', 像素数)] 按频次降序。"""
    rgb = arr[..., :3][arr[..., 3] > 0]
    if rgb.size == 0:
        return []
    colors, counts = np.unique(rgb.reshape(-1, 3), axis=0, return_counts=True)
    order = np.argsort(-counts)[:max_colors]
    return [
        (rgb_to_hex(tuple(int(v) for v in colors[i])), int(counts[i])) for i in order
    ]


def highlight_preview(arr: np.ndarray, changed: np.ndarray) -> np.ndarray:
    """生成"改动区域高亮"预览：原图变暗，将被改动的像素以亮品红标记。"""
    out = arr.astype(np.float32)
    out[..., :3] *= 0.35
    mask = changed & (arr[..., 3] > 0)
    out[mask, 0] = 255
    out[mask, 1] = 0
    out[mask, 2] = 255
    out[mask, 3] = 255
    return out.astype(np.uint8)
