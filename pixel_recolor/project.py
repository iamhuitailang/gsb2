"""工程文件与批量任务的读写。"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from .core import Scheme

PROJECT_VERSION = 1


@dataclass
class ImageItem:
    """工程中的一张图片：路径 + 指定方案 + 可选排除蒙版。"""

    path: str
    scheme: str = ""  # 方案名；空串表示未指定
    mask: str = ""  # 可选排除蒙版 PNG（非透明区域被排除，相当于图层排除）

    def to_dict(self) -> dict:
        return {"path": self.path, "scheme": self.scheme, "mask": self.mask}

    @classmethod
    def from_dict(cls, d: dict) -> "ImageItem":
        return cls(
            path=d["path"], scheme=d.get("scheme", ""), mask=d.get("mask", "")
        )


@dataclass
class Project:
    schemes: list[Scheme] = field(default_factory=list)
    images: list[ImageItem] = field(default_factory=list)
    output_dir: str = "output"

    def scheme_by_name(self, name: str) -> Scheme | None:
        for s in self.schemes:
            if s.name == name:
                return s
        return None

    def to_dict(self) -> dict:
        return {
            "version": PROJECT_VERSION,
            "output_dir": self.output_dir,
            "schemes": [s.to_dict() for s in self.schemes],
            "images": [i.to_dict() for i in self.images],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Project":
        return cls(
            schemes=[Scheme.from_dict(s) for s in d.get("schemes", [])],
            images=[ImageItem.from_dict(i) for i in d.get("images", [])],
            output_dir=d.get("output_dir", "output"),
        )

    def save(self, path: str) -> None:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, ensure_ascii=False, indent=2)

    @classmethod
    def load(cls, path: str) -> "Project":
        with open(path, encoding="utf-8") as f:
            return cls.from_dict(json.load(f))
