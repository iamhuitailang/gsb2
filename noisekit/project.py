"""处理工程的保存与读取 (JSON)。

工程记录每个源文件的指纹、噪声样本区间、各文件参数与导出记录。
重新打开时会校验源文件 sha256, 文件被替换/移动会给出提示而不是静默继续。
"""

from __future__ import annotations

import json
import os
from typing import Any

from . import ALGO_VERSION, __version__

PROJECT_VERSION = 1


def build_project(
    files: list[dict[str, Any]],
    common_params: dict[str, Any],
    sample_regions: dict[str, dict[str, Any]],
    per_file_params: dict[str, dict[str, Any]],
    exports: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "format": "noisekit-project",
        "project_version": PROJECT_VERSION,
        "app_version": __version__,
        "algo_version": ALGO_VERSION,
        "common_params": common_params,
        "files": files,
        "sample_regions": sample_regions,
        "per_file_params": per_file_params,
        "exports": exports or [],
    }


def save_project(project: dict[str, Any], path: str) -> str:
    if os.path.splitext(path)[1].lower() != ".nkproj":
        path += ".nkproj"
    if os.path.exists(path):
        base, ext = os.path.splitext(path)
        n = 2
        while os.path.exists(f"{base}_{n}{ext}"):
            n += 1
        path = f"{base}_{n}{ext}"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(project, f, ensure_ascii=False, indent=2)
    return path


def load_project(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        project = json.load(f)
    if project.get("format") != "noisekit-project":
        raise ValueError("不是 noisekit 工程文件")
    if project.get("project_version") != PROJECT_VERSION:
        raise ValueError(
            f"工程版本 {project.get('project_version')} 与当前版本 {PROJECT_VERSION} 不兼容"
        )
    return project
