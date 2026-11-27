"""单张图的处理流水线与项目持久化。"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

import cv2

from .detection import DetectionError, detect_lines
from .geometry import RotationInfo, deskew
from .grid import GridModel

STATUS_READY = "ready"          # 检测成功，可编辑/导出
STATUS_PENDING = "pending"      # 找不到表格，待人工处理
STATUS_EXPORTED = "exported"


@dataclass
class PageResult:
    name: str
    status: str
    model: GridModel | None = None
    rotation: RotationInfo | None = None
    error: str = ""

    def to_index(self) -> dict:
        return {"name": self.name, "status": self.status, "error": self.error}


def process_image(image_path: str | Path) -> PageResult:
    """拉正 + 检测 + 建网格。任何检测失败统一转 pending，不抛出。"""
    path = Path(image_path)
    image = cv2.imdecode(
        np_fromfile_safe(path), cv2.IMREAD_COLOR)  # 兼容中文路径
    if image is None:
        return PageResult(path.name, STATUS_PENDING, error="图片无法解码")
    try:
        deskewed, rot = deskew(image)
        det = detect_lines(deskewed)
        model = GridModel(det)
        return PageResult(path.name, STATUS_READY, model=model, rotation=rot)
    except DetectionError as exc:
        return PageResult(path.name, STATUS_PENDING, error=str(exc))
    except Exception as exc:  # noqa: BLE001
        return PageResult(path.name, STATUS_PENDING,
                          error=f"处理异常: {type(exc).__name__}: {exc}")


def np_fromfile_safe(path: Path):
    import numpy as np
    return np.fromfile(str(path), dtype=np.uint8)


class ProjectStore:
    """项目目录布局：
    project/
      originals/   原图副本
      deskewed/    拉正预览图
      pages.json   每页状态与模型快照
      exports/<图名>/  导出结果
    """

    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.originals = self.root / "originals"
        self.deskewed = self.root / "deskewed"
        for d in (self.root, self.originals, self.deskewed, self.root / "exports"):
            d.mkdir(parents=True, exist_ok=True)
        self.index_path = self.root / "pages.json"

    def list_pages(self) -> list[dict]:
        if not self.index_path.exists():
            return []
        return json.loads(self.index_path.read_text(encoding="utf-8"))["pages"]

    def save_index(self, pages: list[dict]) -> None:
        self.index_path.write_text(
            json.dumps({"updated_at": time.time(), "pages": pages},
                       ensure_ascii=False, indent=2),
            encoding="utf-8")

    def page_path(self, name: str) -> Path:
        safe = Path(name).stem
        return self.root / f"page_{safe}.json"

    def save_page(self, name: str, page: dict) -> None:
        self.page_path(name).write_text(
            json.dumps(page, ensure_ascii=False, indent=2), encoding="utf-8")

    def load_page(self, name: str) -> dict | None:
        p = self.page_path(name)
        if not p.exists():
            return None
        return json.loads(p.read_text(encoding="utf-8"))

    def save_deskewed(self, name: str, image) -> Path:
        out = self.deskewed / Path(name).name
        ok, buf = cv2.imencode(".png", image)
        if ok:
            buf.tofile(str(out))
        return out
