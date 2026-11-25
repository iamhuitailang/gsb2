"""CLI / GUI 共用的导出与安全检查逻辑。"""

from __future__ import annotations

import os

import numpy as np
from PIL import Image

from seamsqueeze.compare import build_comparison
from seamsqueeze.engine import SeamEngine
from seamsqueeze.project import Project, build_project, write_report
from seamsqueeze.viz import contact_sheet, draw_removed_on_source


def assert_not_source(out_path: str, source_path: str) -> None:
    """导出路径不得与源图同路径，杜绝覆盖源图。"""
    if os.path.exists(out_path) and os.path.samefile(out_path, source_path):
        raise ValueError(f"拒绝导出：{out_path} 与源图是同一文件")


def save_png(path: str, image: np.ndarray) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    Image.fromarray(np.asarray(image)).save(path)


def export_all(
    out_dir: str,
    source_path: str,
    source: np.ndarray,
    engine: SeamEngine,
    masks,
    order: str,
    prefix: str = "result",
) -> dict[str, str]:
    """导出结果图、缩减位置图、三联对照、项目文件与说明，返回路径表。"""
    os.makedirs(out_dir, exist_ok=True)
    target_w, target_h = engine.size

    result_path = os.path.join(out_dir, f"{prefix}_seam.png")
    removed_path = os.path.join(out_dir, f"{prefix}_removed.png")
    compare_path = os.path.join(out_dir, f"{prefix}_compare.png")
    project_path = os.path.join(out_dir, f"{prefix}_project.json")
    report_path = os.path.join(out_dir, f"{prefix}_report.md")
    for p in (result_path, removed_path, compare_path, project_path, report_path):
        assert_not_source(p, source_path)

    save_png(result_path, engine.image)

    removed_map = draw_removed_on_source(source, engine.removed_source_pixels())
    save_png(removed_path, removed_map)

    panels = build_comparison(source, engine.image, target_w, target_h)
    sheet = contact_sheet(
        [
            (f"seam carving {target_w}x{target_h}", panels["seam"]),
            (f"普通缩放 {target_w}x{target_h}", panels["scale"]),
            (f"直接裁边 {target_w}x{target_h}", panels["crop"]),
        ]
    )
    save_png(compare_path, sheet)

    project = build_project(source_path, masks, engine, order)
    project.save(project_path)
    write_report(report_path, project, engine)
    return {
        "result": result_path,
        "removed": removed_path,
        "compare": compare_path,
        "project": project_path,
        "report": report_path,
    }
