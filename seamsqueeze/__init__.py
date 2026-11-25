"""SeamSqueeze — 面向展签场景的本地内容感知缩图工具。

核心是 seam carving（接缝雕刻）：优先从留白处抽走一条 8 连通接缝，
保护物件（rectangle mask）永远不被接缝穿过，支持逐步预览、撤销、
可复现项目保存，以及与普通缩放 / 直接裁边的同尺寸对照。
"""

from .engine import (
    SeamEngine,
    StepRecord,
    EngineError,
    ProtectionBlockedError,
    TargetTooSmallError,
)
from .masks import MaskSet, Rect

__all__ = [
    "SeamEngine",
    "StepRecord",
    "EngineError",
    "ProtectionBlockedError",
    "TargetTooSmallError",
    "MaskSet",
    "Rect",
]
