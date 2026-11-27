"""图像读写工具。

约定: 内部计算一律用 float64, 灰度图形状 (H, W), 彩色图形状 (H, W, C)。
支持 PNG/TIFF 等 PIL 可读格式以及 .npy。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

IMAGE_EXTS = {".png", ".tif", ".tiff", ".bmp", ".jpg", ".jpeg", ".npy"}


def load_image(path: str | Path) -> np.ndarray:
    """读取单张图片为 float64 数组(灰度 2D / 彩色 3D)。"""
    path = Path(path)
    if path.suffix.lower() == ".npy":
        arr = np.load(path)
    else:
        img = Image.open(path)
        arr = np.asarray(img)
    if arr.ndim not in (2, 3):
        raise ValueError(f"不支持的图像维度 {arr.ndim}: {path}")
    return arr.astype(np.float64)


def to_gray(arr: np.ndarray) -> np.ndarray:
    """转 2D 灰度图; 已是灰度则原样返回。"""
    if arr.ndim == 2:
        return arr
    if arr.ndim != 3:
        raise ValueError(f"无法把 ndim={arr.ndim} 的数组转成灰度")
    channels = arr.shape[2]
    if channels >= 3:  # RGB(A), ITU-R 601 亮度权
        weights = np.array([0.299, 0.587, 0.114] + [0.0] * (channels - 3))
    else:  # 单通道带平面维
        weights = np.ones(channels)
    weights = weights / weights.sum()
    return arr @ weights


def save_image(path: str | Path, arr: np.ndarray) -> None:
    """保存图片; <=255 存 uint8, 否则存 uint16, .npy 原样保存。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix.lower() == ".npy":
        np.save(path, arr)
        return
    clipped = np.clip(arr, 0.0, None)
    if np.nanmax(clipped) <= 255.0:
        out = np.rint(clipped).astype(np.uint8)
    else:
        out = np.clip(np.rint(clipped), 0.0, 65535.0).astype(np.uint16)
    Image.fromarray(out).save(path)


def list_image_files(folder: str | Path) -> list[Path]:
    """列出文件夹内所有支持的图像, 按文件名排序。"""
    folder = Path(folder)
    if not folder.is_dir():
        raise FileNotFoundError(f"输入目录不存在: {folder}")
    files = [
        p
        for p in sorted(folder.iterdir())
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS
    ]
    if not files:
        raise FileNotFoundError(f"目录 {folder} 下没有可读图像")
    return files


def load_frames(folder: str | Path) -> tuple[list[str], np.ndarray]:
    """读取一个批次的同尺寸图片, 返回 (文件名列表, 数组)。

    灰度批次数组形状 (N, H, W); 彩色为 (N, H, W, C)。
    尺寸不一致时抛出 ValueError 并指出是哪一张。
    """
    paths = list_image_files(folder)
    names: list[str] = []
    frames: list[np.ndarray] = []
    shape0 = None
    for p in paths:
        arr = load_image(p)
        if shape0 is None:
            shape0 = arr.shape
        elif arr.shape != shape0:
            raise ValueError(
                f"图片尺寸不一致: {paths[0].name} 为 {shape0}, "
                f"{p.name} 为 {arr.shape}; 同批次必须同规格"
            )
        names.append(p.name)
        frames.append(arr)
    return names, np.stack(frames, axis=0)
