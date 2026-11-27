"""单格裁切与导出。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from .grid import GridModel

CROP_MARGIN = 3          # 向格内收的像素，避免把邻格框线带进小图
BLANK_INK_RATIO = 0.006  # 格内墨迹占比低于此值判为空白


@dataclass
class ExportResult:
    output_dir: Path
    n_cells: int
    n_blank: int
    manifest_path: Path


def _ink_ratio(gray: np.ndarray) -> float:
    _, binary = cv2.threshold(gray, 0, 255,
                              cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    # 去掉最外圈（可能残留框线）
    if binary.shape[0] > 8 and binary.shape[1] > 8:
        binary = binary[4:-4, 4:-4]
    return float((binary > 0).sum()) / max(binary.size, 1)


def cell_pixel_rect(model: GridModel, cell) -> tuple[int, int, int, int]:
    """格子在拉正图上的像素矩形 (x0, y0, x1, y1)。"""
    xs, ys = model.det.xs, model.det.ys
    x0 = int(round(xs[cell.c0])) + CROP_MARGIN
    y0 = int(round(ys[cell.r0])) + CROP_MARGIN
    x1 = int(round(xs[cell.c1 + 1])) - CROP_MARGIN
    y1 = int(round(ys[cell.r1 + 1])) - CROP_MARGIN
    return x0, y0, max(x0 + 1, x1), max(y0 + 1, y1)


def export_cells(deskewed: np.ndarray, model: GridModel, output_dir: str | Path,
                 image_name: str) -> ExportResult:
    """导出每格小图 + manifest.json。空白格照常导出但打标记，不影响编号。"""
    out = Path(output_dir)
    img_dir = out / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    gray = cv2.cvtColor(deskewed, cv2.COLOR_BGR2GRAY) if deskewed.ndim == 3 else deskewed

    entries = []
    n_blank = 0
    for seq, cell in enumerate(model.cells, start=1):
        x0, y0, x1, y1 = cell_pixel_rect(model, cell)
        crop = deskewed[y0:y1, x0:x1]
        if crop.size == 0:
            # 缺图/异常矩形：占位记录，不导出坏图，编号不跳过
            entries.append({
                "seq": seq, "cell_id": cell.cell_id, "code": cell.code,
                "anchor": list(cell.anchor), "span": list(cell.span),
                "status": "missing", "file": None,
                "rect_rectified": [x0, y0, x1, y1],
                "confidence": cell.confidence, "notes": cell.notes,
            })
            continue
        is_blank = _ink_ratio(gray[y0:y1, x0:x1]) < BLANK_INK_RATIO
        if is_blank:
            n_blank += 1
            if "空白格" not in " ".join(cell.notes):
                cell.notes.append("空白格（墨迹低于阈值）")
        fname = f"{seq:03d}_{cell.code}.png"
        cv2.imwrite(str(img_dir / fname), crop)
        entries.append({
            "seq": seq,
            "cell_id": cell.cell_id,
            "code": cell.code,
            "anchor": list(cell.anchor),
            "span": list(cell.span),
            "status": "blank" if is_blank else "ok",
            "file": f"images/{fname}",
            "rect_rectified": [x0, y0, x1, y1],
            "size_px": [x1 - x0, y1 - y0],
            "confidence": cell.confidence,
            "notes": cell.notes,
        })

    manifest = {
        "source_image": image_name,
        "n_rows": model.n_rows,
        "n_cols": model.n_cols,
        "n_cells": len(model.cells),
        "n_blank": n_blank,
        "cells": entries,
    }
    manifest_path = out / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return ExportResult(out, len(model.cells), n_blank, manifest_path)
