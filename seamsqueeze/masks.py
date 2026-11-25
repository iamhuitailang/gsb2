"""保护区域 / 优先缩减留白的数据结构与几何映射。

矩形坐标始终以「源图坐标系」记录，引擎当前帧上的活动蒙版由
:class:`~seamsqueeze.engine.SeamEngine` 通过源像素映射反算得到，
因此撤销（恢复历史快照）后蒙版位置不会串。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass(frozen=True)
class Rect:
    """源图坐标系下的矩形，边界均为闭区间，像素单位。"""

    x0: int
    y0: int
    x1: int  # 含
    y1: int  # 含
    name: str = ""

    def __post_init__(self) -> None:
        if self.x1 < self.x0 or self.y1 < self.y0:
            raise ValueError(f"非法矩形 {self!r}：x1/y1 不得小于 x0/y0")

    @property
    def width(self) -> int:
        return self.x1 - self.x0 + 1

    @property
    def height(self) -> int:
        return self.y1 - self.y0 + 1

    def to_dict(self) -> dict:
        return {
            "x0": int(self.x0),
            "y0": int(self.y0),
            "x1": int(self.x1),
            "y1": int(self.y1),
            "name": self.name,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Rect":
        return cls(
            x0=int(d["x0"]),
            y0=int(d["y0"]),
            x1=int(d["x1"]),
            y1=int(d["y1"]),
            name=str(d.get("name", "")),
        )


@dataclass
class MaskSet:
    """一组保护区与优先缩减留白（源图坐标系）。"""

    protect: list[Rect] = field(default_factory=list)
    shrink: list[Rect] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "protect": [r.to_dict() for r in self.protect],
            "shrink": [r.to_dict() for r in self.shrink],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "MaskSet":
        return cls(
            protect=[Rect.from_dict(x) for x in d.get("protect", [])],
            shrink=[Rect.from_dict(x) for x in d.get("shrink", [])],
        )

    # ------------------------------------------------------------------
    def _rasterize(
        self, rects: list[Rect], src_h: int, src_w: int
    ) -> np.ndarray:
        mask = np.zeros((src_h, src_w), dtype=bool)
        for r in rects:
            x0 = max(0, r.x0)
            y0 = max(0, r.y0)
            x1 = min(src_w - 1, r.x1)
            y1 = min(src_h - 1, r.y1)
            if x0 <= x1 and y0 <= y1:
                mask[y0 : y1 + 1, x0 : x1 + 1] = True
        return mask

    def source_masks(self, src_h: int, src_w: int) -> tuple[np.ndarray, np.ndarray]:
        """在源图分辨率上栅格化两类蒙版。"""
        return (
            self._rasterize(self.protect, src_h, src_w),
            self._rasterize(self.shrink, src_h, src_w),
        )

    def validate(self, src_h: int, src_w: int) -> None:
        """矩形必须整体落在源图范围内，且两类区域不得相交。"""
        for r in self.protect + self.shrink:
            if not (0 <= r.x0 and r.x1 < src_w and 0 <= r.y0 and r.y1 < src_h):
                raise ValueError(f"矩形越界（源图 {src_w}x{src_h}）：{r!r}")
        p = self._rasterize(self.protect, src_h, src_w)
        s = self._rasterize(self.shrink, src_h, src_w)
        if np.any(p & s):
            raise ValueError("保护区域与优先缩减留白存在相交像素")
