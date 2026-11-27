"""图像读写: 普通无损彩色图(PNG/TIFF), 统一为 float32 RGB [0,1]。"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

IMAGE_EXTS = {".png", ".tif", ".tiff", ".bmp"}


def load_image(path: str | Path) -> np.ndarray:
    im = Image.open(path)
    if im.mode in ("I;16", "I"):
        arr = np.asarray(im, dtype=np.float32) / 65535.0
        return np.stack([arr] * 3, axis=-1)
    if im.mode == "F":
        arr = np.asarray(im, dtype=np.float32)
        return np.stack([np.clip(arr, 0, 1)] * 3, axis=-1)
    arr = np.asarray(im.convert("RGB"), dtype=np.float32) / 255.0
    return arr


def save_image(arr: np.ndarray, path: str | Path) -> None:
    arr8 = (np.clip(arr, 0, 1) * 255.0 + 0.5).astype(np.uint8)
    Image.fromarray(arr8, "RGB").save(path)


def list_images(dirpath: str | Path) -> list[Path]:
    d = Path(dirpath)
    return sorted(p for p in d.iterdir() if p.suffix.lower() in IMAGE_EXTS)
