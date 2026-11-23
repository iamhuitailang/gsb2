"""工程文件保存/读取。

工程目录结构：
    <project>/
        project.json     原图引用（相对路径）、配准矩阵、pin、参数
        cache.npz        清晰度栈、标签、权重、合成结果缓存（可重算）
        sources/         打开外部图片时复制一份，保证工程可迁移
        composite.png    合成图输出
        source_map.png   来源图输出

project.json 里只存矢量 pin 与 2x3 矩阵，重算配准后 pin 依旧有效；
修改一块选择（增删 pin）后重新融合时，PinSet 中其他 pin 原样保留。
"""
from __future__ import annotations

import json
import shutil
from dataclasses import asdict
from pathlib import Path

import numpy as np

from .geometry import identity
from .registration import (
    ImageRegistration,
    Registration,
    RegistrationConfig,
)
from .selection import Pin, PinSet, SelectionConfig
from .sharpness import SharpnessConfig

PROJECT_FILE = "project.json"
CACHE_FILE = "cache.npz"
SOURCE_DIR = "sources"
COMPOSITE_FILE = "composite.png"
SOURCE_MAP_FILE = "source_map.png"


def _cfg_to_dict(cfg) -> dict:
    return asdict(cfg)


def save_project(root: str | Path,
                 source_paths: list[str],
                 reg: Registration,
                 pins: PinSet,
                 sharp_cfg: SharpnessConfig,
                 sel_cfg: SelectionConfig,
                 temperature: float,
                 fusion_mode: str,
                 coverage_mode: str,
                 cache: dict | None = None) -> Path:
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    (root / SOURCE_DIR).mkdir(exist_ok=True)

    # 复制源图到工程内，保存相对引用
    rel_paths: list[str] = []
    for i, src in enumerate(source_paths):
        src_p = Path(src)
        dst = root / SOURCE_DIR / f"source_{i:02d}{src_p.suffix.lower() or '.png'}"
        if src_p.resolve() != dst.resolve():
            shutil.copy2(src_p, dst)
        rel_paths.append(str(Path(SOURCE_DIR) / dst.name))

    payload = {
        "version": 1,
        "source_order": rel_paths,
        "ref_index": reg.ref_index,
        "ref_shape": list(reg.ref_shape),
        "registration_config": _cfg_to_dict(reg.config),
        "registration": [
            {"index": it.index,
             "matrix": np.asarray(it.matrix).tolist(),
             "correlation": it.correlation,
             "status": it.status,
             "message": it.message}
            for it in reg.items
        ],
        "pins": pins.to_list(),
        "sharpness_config": _cfg_to_dict(sharp_cfg),
        "selection_config": _cfg_to_dict(sel_cfg),
        "temperature": temperature,
        "fusion_mode": fusion_mode,
        "coverage_mode": coverage_mode,
    }
    with open(root / PROJECT_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    if cache:
        np.savez_compressed(root / CACHE_FILE, **cache)
    return root / PROJECT_FILE


def load_project(root: str | Path) -> dict:
    """读取工程描述。返回 dict，图像与缓存由调用方按需加载。"""
    root = Path(root)
    with open(root / PROJECT_FILE, encoding="utf-8") as f:
        payload = json.load(f)

    reg_cfg = RegistrationConfig(**payload["registration_config"])
    ref_shape = tuple(payload["ref_shape"])
    items = []
    for d in payload["registration"]:
        cov_path = None  # 覆盖掩码可由矩阵重算，不进 JSON
        items.append(ImageRegistration(
            d["index"], np.asarray(d["matrix"], dtype=np.float64),
            d["correlation"], d["status"], d["message"], None))
    reg = Registration(payload["ref_index"], items, ref_shape, reg_cfg, None)

    sharp_cfg = SharpnessConfig(**payload["sharpness_config"])
    sel_cfg = SelectionConfig(**payload["selection_config"])
    pins = PinSet.from_list(payload["pins"])
    source_paths = [str(root / p) for p in payload["source_order"]]

    cache_path = root / CACHE_FILE
    cache = dict(np.load(cache_path)) if cache_path.exists() else None
    return {
        "root": str(root),
        "source_paths": source_paths,
        "registration": reg,
        "pins": pins,
        "sharpness_config": sharp_cfg,
        "selection_config": sel_cfg,
        "temperature": payload["temperature"],
        "fusion_mode": payload["fusion_mode"],
        "coverage_mode": payload["coverage_mode"],
        "cache": cache,
    }


def save_outputs(root: str | Path, composite: np.ndarray,
                 source_map_img: np.ndarray) -> tuple[Path, Path]:
    import cv2
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    c_path = root / COMPOSITE_FILE
    s_path = root / SOURCE_MAP_FILE
    cv2.imwrite(str(c_path), composite)
    cv2.imwrite(str(s_path), source_map_img)
    return c_path, s_path


def export_png(path: str | Path, image: np.ndarray) -> Path:
    import cv2
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(p), image)
    return p
