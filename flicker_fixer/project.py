"""工程文件保存 / 加载（JSON）。

工程记录输入目录与全部处理参数，不内嵌图片，重新打开时按目录重新加载序列。
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

PROJECT_VERSION = 1
PROJECT_EXT = ".ffproj.json"


@dataclass
class Project:
    input_dir: str = ""
    selection: list[int | None] = field(default_factory=lambda: [None, None])
    strength: float = 0.8
    smooth_window: int = 9
    spike_threshold: float = 6.0
    cut_threshold: float = 25.0
    version: int = PROJECT_VERSION


def save_project(project: Project, path: str | Path) -> None:
    path = Path(path)
    with path.open("w", encoding="utf-8") as f:
        json.dump(asdict(project), f, ensure_ascii=False, indent=2)


def load_project(path: str | Path) -> Project:
    with Path(path).open("r", encoding="utf-8") as f:
        data = json.load(f)
    project = Project()
    for key in ("input_dir", "selection", "strength", "smooth_window",
                "spike_threshold", "cut_threshold"):
        if key in data:
            setattr(project, key, data[key])
    return project
