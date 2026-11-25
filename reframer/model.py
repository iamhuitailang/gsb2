"""数据模型: 关注框轨迹与取景时间表共用的结构。"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Optional


@dataclass(frozen=True)
class Rect:
    """归一化坐标矩形, 全部为 0..1 (相对源画面宽/高)。"""

    x: float
    y: float
    w: float
    h: float

    @property
    def cx(self) -> float:
        return self.x + self.w / 2.0

    @property
    def cy(self) -> float:
        return self.y + self.h / 2.0

    def to_px(self, width: int, height: int) -> tuple[int, int, int, int]:
        return (
            int(round(self.x * width)),
            int(round(self.y * height)),
            int(round(self.w * width)),
            int(round(self.h * height)),
        )

    def validate(self) -> None:
        if not (0.0 <= self.x <= 1.0 and 0.0 <= self.y <= 1.0):
            raise ValueError(f"矩形原点越界: {self}")
        if self.w <= 0 or self.h <= 0:
            raise ValueError(f"矩形宽高必须为正: {self}")
        if self.x + self.w > 1.0 + 1e-9 or self.y + self.h > 1.0 + 1e-9:
            raise ValueError(f"矩形超出画面: {self}")

    def to_dict(self) -> dict[str, float]:
        return asdict(self)

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "Rect":
        return Rect(float(d["x"]), float(d["y"]), float(d["w"]), float(d["h"]))


@dataclass(frozen=True)
class KF:
    """关键帧: t 秒处该关注框为 rect, rect=None 表示此刻该框消失。"""

    t: float
    rect: Optional[Rect]

    def to_dict(self) -> dict[str, Any]:
        return {"t": self.t, "rect": None if self.rect is None else self.rect.to_dict()}

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "KF":
        r = d.get("rect")
        return KF(float(d["t"]), None if r is None else Rect.from_dict(r))


@dataclass
class Track:
    """一个可编号对象(人)随时间变化的关注框。"""

    id: str
    label: str
    required: bool = False          # 必须保留的对象
    keyframes: list[KF] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "required": self.required,
            "keyframes": [kf.to_dict() for kf in self.keyframes],
        }

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "Track":
        return Track(
            id=str(d["id"]),
            label=str(d.get("label", d["id"])),
            required=bool(d.get("required", False)),
            keyframes=[KF.from_dict(k) for k in d.get("keyframes", [])],
        )


@dataclass
class Shot:
    """镜头段: [start, end), cut 类型决定段间是硬切还是平滑移动。"""

    start: float
    end: float
    transition: str = "cut"         # "cut" | "smooth"

    def to_dict(self) -> dict[str, Any]:
        return {"start": self.start, "end": self.end, "transition": self.transition}

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "Shot":
        tr = str(d.get("transition", "cut"))
        if tr not in ("cut", "smooth"):
            raise ValueError(f"未知转场类型: {tr}")
        return Shot(float(d["start"]), float(d["end"]), tr)


@dataclass
class SafeZone:
    """不希望被裁掉的底线区域(归一化), 例如底部字幕带。"""

    rect: Rect
    name: str = "safe"

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "rect": self.rect.to_dict()}

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "SafeZone":
        return SafeZone(Rect.from_dict(d["rect"]), str(d.get("name", "safe")))


def even2(v: float) -> int:
    """取不小于 v 的偶数 (YUV420 要求 crop 宽高/坐标为偶数)。"""
    n = int(round(v))
    return n if n % 2 == 0 else n + 1
