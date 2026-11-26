"""图像读写与颜色工具。

约定：
- 内存中的图像统一为 float32 RGB，范围 [0, 1]；
- 灰度图在读取时也扩成三通道，避免下游到处判断通道数。
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image

RGB_WEIGHTS = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def load_meta(path: str | Path) -> dict:
    """读取 JSON 元数据（样例真值、导出参数等）。"""
    return json.loads(Path(path).read_text(encoding="utf-8"))


def json_safe(obj):
    """递归把 NaN/Inf 转成 None，并转 numpy 标量；保证输出是严格合法 JSON。

    ``json.dumps`` 默认会写出 ``NaN``/``Infinity`` 这些非标准 token，很多
    下游解析器会拒绝。估计失败时置信区间常是 NaN，因此导出前必须清洗。
    """
    import math

    if isinstance(obj, dict):
        return {str(k): json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [json_safe(v) for v in obj]
    if isinstance(obj, np.ndarray):
        return json_safe(obj.tolist())
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        obj = float(obj)
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    if isinstance(obj, float):
        return None if not math.isfinite(obj) else obj
    return obj


def write_json(path: str | Path, payload) -> Path:
    """写严格合法 JSON（NaN -> null，numpy 标量转原生类型）。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(json_safe(payload), ensure_ascii=False, indent=2, allow_nan=False),
        encoding="utf-8",
    )
    return path


def load_image(path: str | Path) -> np.ndarray:
    """读取图片为 float32 RGB (H, W, 3)，范围 0..1。"""
    with Image.open(path) as im:
        im = im.convert("RGB")
        arr = np.asarray(im, dtype=np.float32) / 255.0
    return np.ascontiguousarray(arr)


def load_luma(path: str | Path) -> np.ndarray:
    return luma(load_image(path))


def to_uint8(arr: np.ndarray) -> np.ndarray:
    """float [0,1] -> uint8，四舍五入并截断。"""
    return np.clip(np.rint(np.asarray(arr, dtype=np.float64) * 255.0), 0, 255).astype(np.uint8)


def save_image(path: str | Path, arr: np.ndarray) -> None:
    """把 float RGB 或灰度图存成 8-bit PNG。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    a = np.asarray(arr)
    if a.ndim == 2:
        im = Image.fromarray(to_uint8(a), mode="L")
    elif a.ndim == 3:
        if a.shape[2] == 1:
            im = Image.fromarray(to_uint8(a[..., 0]), mode="L")
        elif a.shape[2] >= 3:
            im = Image.fromarray(to_uint8(a[..., :3]), mode="RGB")
        else:
            raise ValueError(f"不支持 {a.shape[2]} 通道的图像")
    else:
        raise ValueError(f"不支持 {a.ndim} 维数组")
    im.save(path)


def save_npy(path: str | Path, arr: np.ndarray) -> None:
    """保存 float32 无损结果，便于二次分析。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.save(path, np.asarray(arr, dtype=np.float32))


def luma(img: np.ndarray) -> np.ndarray:
    """RGB 或灰度 -> 灰度 float32。"""
    a = np.asarray(img, dtype=np.float32)
    if a.ndim == 2:
        return a
    if a.shape[2] == 1:
        return a[..., 0]
    return a[..., :3] @ RGB_WEIGHTS


def with_luma(img: np.ndarray, new_luma: np.ndarray) -> np.ndarray:
    """保留原图色度，只替换亮度。

    做法是给 RGB 三通道加上同一个标量修正量，因此像素间的色差完全不变。
    """
    a = np.asarray(img, dtype=np.float32)
    old = luma(a)
    corr = np.asarray(new_luma, dtype=np.float32) - old
    if a.ndim == 2:
        return old + corr
    return a + corr[..., None]


def crop_rect(img: np.ndarray, rect: tuple[int, int, int, int]) -> np.ndarray:
    x0, y0, x1, y1 = rect
    return img[y0:y1, x0:x1]


def clip01(img: np.ndarray) -> np.ndarray:
    return np.clip(img, 0.0, 1.0)


def image_size(img: np.ndarray) -> tuple[int, int]:
    """返回 (width, height)。"""
    return int(img.shape[1]), int(img.shape[0])
