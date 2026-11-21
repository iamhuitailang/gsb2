"""处理参数定义。

所有空间量（ROI、手绘区域）一律使用归一化坐标 (0~1)，与图像分辨率无关；
这样低分辨率预览与原尺寸导出走同一套参数、同一条处理链路，含义完全一致。
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Any, Literal

RegionMode = Literal["exclude", "adjust"]


@dataclass
class Region:
    """用户在检查视图里圈出的多边形区域（归一化坐标，相对 ROI 内部）。

    exclude: 该区域内不做任何自动处理（不校正、不去点），只保留原图亮度；
    adjust:  该区域内单独套用本区域的 gamma / 去点参数。
    """

    id: str
    points: list[tuple[float, float]]  # [(x, y), ...]，均在 0~1
    mode: RegionMode = "exclude"
    gamma: float = 1.0
    white_target: float = 245.0
    despeckle_size: int = 0  # 0 表示跟随全局参数
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        d = dataclasses.asdict(self)
        d["points"] = [list(p) for p in self.points]
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Region":
        return cls(
            id=str(d["id"]),
            points=[(float(x), float(y)) for x, y in d["points"]],
            mode=d.get("mode", "exclude"),
            gamma=float(d.get("gamma", 1.0)),
            white_target=float(d.get("white_target", 245.0)),
            despeckle_size=int(d.get("despeckle_size", 0)),
            note=str(d.get("note", "")),
        )


@dataclass
class ProcessParams:
    """全链路参数。默认值针对「铅笔草稿 + 手机拍照阴影」调过。"""

    # ---- 纸张框定：归一化 ROI [x0, y0, x1, y1]；None 表示整幅 ----
    roi: tuple[float, float, float, float] | None = None

    # ---- 背景（照明）估计 ----
    # 估计纸张背景场的平滑尺度，单位为「图像短边的比例」。
    # 越大越平滑，越能吃掉缓慢阴影；过小会把粗笔画也当成背景。
    background_scale: float = 0.08
    # 判定「纸」的相对阈值：亮度 >= 背景粗估的该比例视为纸。
    paper_quantile: float = 0.75
    # 大色块保护：大于该面积（短边比例的平方）的连通黑块视为实心内容，
    # 背景场直接从其周围绕过去，绝不让大实黑区被摊平或产生晕边。
    solid_block_size: float = 0.02

    # ---- 色调映射（校正后）----
    # 纸张背景最终拉到的灰度值；不做二值化，浅线保持连续灰阶。
    white_target: float = 245.0
    # gamma：>1 提亮浅铅笔线（把中间调往亮处推的反方向，见 pipeline 公式）。
    gamma: float = 1.15

    # ---- 小点去除（仅作用于连通小碎块，绝不切断线条）----
    despeckle: bool = True
    # 小于该像素数的暗连通块视为噪点（按运行分辨率等比缩放）。
    # 配合形状判据使用：又小又近圆才算点，细长浅铅笔线不受影响。
    despeckle_size: int = 10
    # 软融合 0~1：1 = 完全抹除，小值 = 仅淡化，避免浅线被误伤。
    despeckle_strength: float = 0.8

    # ---- 检查视图阈值 ----
    # 判定暗像素（线/墨）的灰度阈值，用于断裂与小点分析。
    # 默认 210 可以覆盖浅铅笔线（清理后通常在 190~210）。
    ink_threshold: int = 210
    # 两个碎块间距小于该距离（按短边比例）疑似断裂。
    break_distance: float = 0.012
    # 阴影残留：背景粗估在局部的极差超过该灰度值视为残留。
    shadow_residual: int = 12

    # ---- 局部区域 ----
    regions: list[Region] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d = dataclasses.asdict(self)
        d["roi"] = list(self.roi) if self.roi is not None else None
        d["regions"] = [r.to_dict() for r in self.regions]
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "ProcessParams":
        d = dict(d)
        if d.get("roi") is not None:
            d["roi"] = tuple(float(v) for v in d["roi"])
        d["regions"] = [Region.from_dict(r) for r in d.get("regions", [])]
        known = {f.name for f in dataclasses.fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in known})
