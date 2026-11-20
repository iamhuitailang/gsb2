"""批量处理与导出。

单张图片失败不影响其余图片：每张图独立 try/except，
结果（含失败原因）全部记录在 BatchResult 中，可随时查看。
"""

from __future__ import annotations

import csv
import json
import os
import time
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

from .core import apply_scheme, load_rgba, save_rgba
from .project import Project


@dataclass
class ImageResult:
    path: str
    scheme: str = ""
    ok: bool = False
    output: str = ""  # 导出文件路径（仅导出时）
    error: str = ""
    changed_pixels: int = 0
    data: np.ndarray | None = field(default=None, repr=False)  # 换色结果（内存中）


@dataclass
class BatchResult:
    results: list[ImageResult] = field(default_factory=list)

    @property
    def succeeded(self) -> list[ImageResult]:
        return [r for r in self.results if r.ok]

    @property
    def failed(self) -> list[ImageResult]:
        return [r for r in self.results if not r.ok]


def _load_mask(mask_path: str, shape: tuple[int, int]) -> np.ndarray:
    with Image.open(mask_path) as im:
        mask = np.asarray(im.convert("RGBA"), dtype=np.uint8)
    if mask.shape[:2] != shape:
        raise ValueError(
            f"蒙版尺寸 {mask.shape[:2]} 与图片 {shape} 不一致"
        )
    return mask[..., 3] > 0


def run_batch(project: Project, keep_data: bool = True) -> BatchResult:
    """对工程内所有图片应用各自指定的方案，结果保存在内存中（不导出）。"""
    batch = BatchResult()
    for item in project.images:
        res = ImageResult(path=item.path, scheme=item.scheme)
        batch.results.append(res)
        try:
            scheme = project.scheme_by_name(item.scheme)
            if scheme is None:
                raise ValueError(f"未找到方案: {item.scheme!r}")
            arr = load_rgba(item.path)
            mask = _load_mask(item.mask, arr.shape[:2]) if item.mask else None
            out, changed = apply_scheme(arr, scheme, mask)
            res.ok = True
            res.changed_pixels = int(changed.sum())
            if keep_data:
                res.data = out
        except Exception as exc:  # 单张失败不影响其余
            res.error = str(exc)
    return batch


def export_batch(
    project: Project, output_dir: str | None = None
) -> tuple[BatchResult, str, str]:
    """批量换色并导出 PNG + 导出清单（manifest.json / manifest.csv）。

    原图不会被修改；清单记录每张图使用了哪套配色方案。
    返回 (BatchResult, manifest_json_path, manifest_csv_path)。
    """
    out_dir = output_dir or project.output_dir
    os.makedirs(out_dir, exist_ok=True)
    batch = run_batch(project, keep_data=True)

    used_names: set[str] = set()
    for res in batch.results:
        if not res.ok or res.data is None:
            continue
        base = os.path.splitext(os.path.basename(res.path))[0]
        name = base
        i = 1
        while name in used_names:  # 同名文件去重
            i += 1
            name = f"{base}_{i}"
        used_names.add(name)
        res.output = os.path.join(out_dir, f"{name}.png")
        try:
            save_rgba(res.data, res.output)
        except Exception as exc:
            res.ok = False
            res.error = f"写入失败: {exc}"
            res.output = ""

    records = [
        {
            "source": r.path,
            "output": r.output,
            "scheme": r.scheme,
            "ok": r.ok,
            "changed_pixels": r.changed_pixels,
            "error": r.error,
        }
        for r in batch.results
    ]
    manifest = {
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "output_dir": os.path.abspath(out_dir),
        "total": len(batch.results),
        "succeeded": len(batch.succeeded),
        "failed": len(batch.failed),
        "images": records,
    }
    json_path = os.path.join(out_dir, "manifest.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    csv_path = os.path.join(out_dir, "manifest.csv")
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=["source", "output", "scheme", "ok", "changed_pixels", "error"],
        )
        writer.writeheader()
        writer.writerows(records)

    return batch, json_path, csv_path
