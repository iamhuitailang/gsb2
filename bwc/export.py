"""导出干净图、面积清单, 以及回读校验。

导出物
------
* <name>_clean.png: 纯黑白图(只有 0 和 255), 不含编号标注,
  保证回读时像素数与当前版本完全一致。
* <name>_areas.csv: 每个连通块一行(标签、面积、质心、外接框),
  孔洞另列在同一份清单里(类型列区分)。
* <name>_meta.json(可选): 记录连通性、阈值、步骤和统计, 便于复核。

回读一致性: label_components 的标签按扫描顺序确定分配, 同一张
二值图在相同连通性下重标, 标签范围 1..N 与每块像素数必然复现。
"""

from __future__ import annotations

import csv
import json

import numpy as np
from PIL import Image

from . import morphology as morph
from .pipeline import Project, Version


def export_clean(version: Version, path: str) -> None:
    arr = np.where(version.mask, 0, 255).astype(np.uint8)
    Image.fromarray(arr, mode="L").save(path)


def export_area_list(version: Version, path: str) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["type", "label", "area_pixels",
                         "centroid_y", "centroid_x", "bbox_y0", "bbox_x0",
                         "bbox_y1", "bbox_x1"])
        for st in version.component_stats[1:]:
            y0, x0, y1, x1 = st["bbox"]
            writer.writerow(["component", st["label"], st["area"],
                             round(st["centroid"][0], 2),
                             round(st["centroid"][1], 2),
                             y0, x0, y1, x1])
        for st in version.hole_stats[1:]:
            writer.writerow(["hole", f"H{st['hole']}", st["area"],
                             round(st["centroid"][0], 2),
                             round(st["centroid"][1], 2), "", "", "", ""])


def export_meta(project: Project, path: str) -> None:
    v = project.current
    payload = {
        "threshold": project.threshold,
        "connectivity": project.connectivity,
        "steps": [s.to_dict() for s in project.steps],
        "n_components": v.n_components,
        "n_holes": v.n_holes,
        "ink_pixels": v.ink_pixels,
        "components": [
            {"label": st["label"], "area": st["area"]}
            for st in v.component_stats[1:]
        ],
        "holes": [
            {"hole": st["hole"], "area": st["area"]}
            for st in v.hole_stats[1:]
        ],
        "constraints": [c.to_dict() for c in project.constraints],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def export_all(project: Project, base_path: str) -> dict[str, str]:
    """一次导出三件套, base_path 不带后缀。"""
    paths = {
        "clean": f"{base_path}_clean.png",
        "areas": f"{base_path}_areas.csv",
        "meta": f"{base_path}_meta.json",
    }
    export_clean(project.current, paths["clean"])
    export_area_list(project.current, paths["areas"])
    export_meta(project, paths["meta"])
    return paths


def readback_clean(path: str, connectivity: int) -> dict:
    """回读导出的干净图并重新标记, 返回重算的统计用于核对。"""
    gray = np.asarray(Image.open(path).convert("L"), dtype=np.uint8)
    mask = gray <= 127
    labels, n = morph.label_components(mask, connectivity)
    stats = morph.component_stats(labels, n)
    hole_labels, n_holes, hole_stats = morph.find_holes(mask, connectivity)
    return {
        "mask": mask,
        "labels": labels,
        "n_components": n,
        "component_stats": stats,
        "n_holes": n_holes,
        "hole_stats": hole_stats,
        "ink_pixels": int(mask.sum()),
    }


def verify_roundtrip(project: Project, clean_path: str) -> dict:
    """要求 6 的校验: 回读图的标签范围、每块像素数、孔洞数与导出版本一致。"""
    v = project.current
    rb = readback_clean(clean_path, project.connectivity)
    mismatches: list[str] = []

    if rb["n_components"] != v.n_components:
        mismatches.append(
            f"连通块数量 {rb['n_components']} != 导出时 {v.n_components}")
    if rb["ink_pixels"] != v.ink_pixels:
        mismatches.append(
            f"墨迹像素数 {rb['ink_pixels']} != 导出时 {v.ink_pixels}")
    if rb["n_holes"] != v.n_holes:
        mismatches.append(
            f"孔洞数量 {rb['n_holes']} != 导出时 {v.n_holes}")

    for st in v.component_stats[1:]:
        lab = st["label"]
        if lab >= len(rb["component_stats"]) or rb["component_stats"][lab] is None:
            mismatches.append(f"回读缺少标签 {lab}")
            continue
        if rb["component_stats"][lab]["area"] != st["area"]:
            mismatches.append(
                f"标签 {lab} 面积 {rb['component_stats'][lab]['area']} "
                f"!= 导出时 {st['area']}")

    if not np.array_equal(rb["mask"], v.mask):
        mismatches.append("回读二值图与导出版本存在像素差异")

    return {
        "ok": not mismatches,
        "mismatches": mismatches,
        "readback": {k: val for k, val in rb.items()
                     if k not in ("mask", "labels")},
    }
