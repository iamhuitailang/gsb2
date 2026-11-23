"""单个零件区域的毫米级测量。

所有读数都同时给出“是否含孔”的口径说明：

- 外宽/外高：沿横尺(u)、纵尺(v)方向的外接尺寸，永远是含孔的外轮廓口径；
- 外轮廓面积：轮廓包围面积，含孔；
- 实际填充面积：黑色像素换算，不含孔；
- 孔面积：该零件所有封闭孔的面积之和；
- 投影尺寸：指定方向上轮廓点投影的跨度（外轮廓口径，含孔）。

若轮廓点超出标尺张成的有效平行四边形，对应读数带 out_of_valid_region 提醒；
断到图边上的区域，其尺寸是“被截断后的可见尺寸”，一律标记不可靠。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict

import cv2
import numpy as np

from .geometry import Calibration
from .segmentation import Segmentation, Component, HOLE, BORDER

# 默认投影方向（相对图片 x 轴的角度，度）。0/90 为图边方向，
# 45/135 为两个斜向；另自动加入标尺 u/v 轴方向。
DEFAULT_PROJECTION_ANGLES = (0, 45, 90, 135)

PENDING = "pending"      # 待确认
CONFIRMED = "confirmed"  # 已确认


@dataclass
class Projection:
    label: str
    angle_deg: float
    size_mm: float
    span_px: float


@dataclass
class Measurement:
    comp_id: int
    kind: str
    # 外轮廓口径（含孔）
    outer_width_mm: float        # 沿横尺 u 方向
    outer_height_mm: float       # 沿纵尺 v 方向
    outer_area_mm2: float        # 轮廓包围面积，含孔
    # 填充口径（不含孔）
    filled_area_mm2: float       # 实际黑色像素
    hole_area_mm2: float         # 封闭孔面积之和
    net_area_mm2: float          # = filled_area_mm2，语义化别名
    hole_count: int
    holes: list[dict]
    projections: list[Projection]
    # 可靠性
    inside_fraction: float
    outside_points_px: list[list[float]]
    touches_border: bool
    border_sides: list[str]
    warnings: list[str]
    status: str = CONFIRMED      # confirmed / pending
    note: str = ""

    def to_dict(self) -> dict:
        d = asdict(self)
        return d


def _mm2_per_px2(calib: Calibration) -> float:
    """1 个像素对应多少平方毫米。

    basis 的列是 1mm 的像素位移，det(basis) 是 1mm² 对应的像素数，
    取逆即为 1px² 的 mm² 数；斜标尺（非正交）下同样成立。
    """
    det = abs(float(np.linalg.det(calib.basis)))
    if det < 1e-15:
        det = abs(float(np.linalg.det(calib.pixel_to_mm))) ** -1
    return 1.0 / det


def _projection_along(contour_pts: np.ndarray, unit_dir: np.ndarray,
                      calib: Calibration) -> tuple[float, float]:
    """轮廓点在 unit_dir（像素空间单位向量）上的投影跨度，返回 (mm, px)。"""
    proj = contour_pts @ unit_dir
    span_px = float(proj.max() - proj.min())
    # 该方向上每像素对应的毫米数（pixel_to_mm 是 mm/px 的线性映射）
    mm_per_px = float(np.linalg.norm(calib.pixel_to_mm @ unit_dir))
    return span_px * mm_per_px, span_px


def measure_component(comp: Component, seg: Segmentation,
                      calib: Calibration,
                      projection_angles: tuple[float, ...] = DEFAULT_PROJECTION_ANGLES,
                      outside_sample_limit: int = 200) -> Measurement:
    pts = comp.contour.reshape(-1, 2).astype(float)
    uv = calib.to_mm_xy(pts)
    u_min, u_max = uv[:, 0].min(), uv[:, 0].max()
    v_min, v_max = uv[:, 1].min(), uv[:, 1].max()

    outer_w = float(u_max - u_min)
    outer_h = float(v_max - v_min)
    px_per_mm2 = _mm2_per_px2(calib)   # 1 px² 等于多少 mm²
    outer_area_mm2 = comp.outer_area_px * px_per_mm2
    filled_mm2 = comp.filled_area_px * px_per_mm2

    # ---- 孔 ----
    holes_info = []
    hole_area_px_total = 0
    for hid in comp.child_ids:
        hc = seg.components[hid]
        hole_area_px_total += hc.hole_area_px
        huv = calib.to_mm_xy(hc.contour.reshape(-1, 2).astype(float))
        holes_info.append({
            "hole_id": hid,
            "area_mm2": hc.hole_area_px * px_per_mm2,
            "width_mm": float(huv[:, 0].max() - huv[:, 0].min()),
            "height_mm": float(huv[:, 1].max() - huv[:, 1].min()),
            "centroid_px": _centroid(hc),
        })
    hole_mm2 = hole_area_px_total * px_per_mm2

    # ---- 投影：图边方向 + 斜向 + 标尺轴向 ----
    projections: list[Projection] = []
    seen_angles: set[float] = set()

    def add_projection(angle_deg: float, label: str) -> None:
        key = round(angle_deg % 180.0, 2)
        if key in seen_angles:
            return
        seen_angles.add(key)
        rad = math.radians(angle_deg)
        unit = np.array([math.cos(rad), math.sin(rad)])
        size_mm, span_px = _projection_along(pts, unit, calib)
        projections.append(Projection(
            label=label, angle_deg=round(angle_deg, 2),
            size_mm=float(size_mm), span_px=float(span_px),
        ))

    for ang in projection_angles:
        add_projection(ang, f"图轴 {ang:g}°")
    # 标尺 u/v 轴方向（横尺、纵尺本身的朝向）
    u_dir = calib.basis[:, 0]
    v_dir = calib.basis[:, 1]
    add_projection(math.degrees(math.atan2(u_dir[1], u_dir[0])), "横尺方向")
    add_projection(math.degrees(math.atan2(v_dir[1], v_dir[0])), "纵尺方向")
    projections.sort(key=lambda p: p.angle_deg)

    # ---- 超界与可靠性 ----
    inside_frac = calib.points_inside_fraction(pts)
    outside = calib.polygon_outside_parts(pts)
    if len(outside) > outside_sample_limit:
        idx = np.linspace(0, len(outside) - 1, outside_sample_limit).astype(int)
        outside_sample = outside[idx]
    else:
        outside_sample = outside
    warnings = []
    if inside_frac < 0.999:
        warnings.append(
            f"{(1 - inside_frac) * 100:.1f}% 的轮廓点超出标尺有效测量区域，"
            "相关毫米读数外推、仅供参考"
        )
    if comp.kind == BORDER:
        warnings.append(
            "零件区域与图片边界相接（" + "、".join(comp.border_sides) +
            "），外宽/外高/投影只是被截断后的可见尺寸，不能代表完整零件"
        )

    return Measurement(
        comp_id=comp.comp_id,
        kind=comp.kind,
        outer_width_mm=outer_w,
        outer_height_mm=outer_h,
        outer_area_mm2=outer_area_mm2,
        filled_area_mm2=filled_mm2,
        hole_area_mm2=hole_mm2,
        net_area_mm2=filled_mm2,
        hole_count=len(comp.child_ids),
        holes=holes_info,
        projections=projections,
        inside_fraction=inside_frac,
        outside_points_px=outside_sample.astype(float).tolist(),
        touches_border=comp.touches_border,
        border_sides=comp.border_sides,
        warnings=warnings,
    )


def _centroid(comp: Component) -> list[float]:
    m = cv2.moments(comp.contour)
    if abs(m["m00"]) < 1e-9:
        x, y, w, h = comp.bbox
        return [x + w / 2, y + h / 2]
    return [float(m["m10"] / m["m00"]), float(m["m01"] / m["m00"])]


def measure_all(seg: Segmentation, calib: Calibration,
                projection_angles: tuple[float, ...] = DEFAULT_PROJECTION_ANGLES,
                include_border: bool = True
                ) -> dict[int, Measurement]:
    """测量全部零件。

    默认包含断到图边的区域（其读数带“被截断、不可靠”提醒）；
    include_border=False 时只返回完整外轮廓的零件，
    可用于把探出图边的标尺框排除在常规测量之外。
    """
    outers = [c for c in seg.outers()
              if include_border or c.kind != BORDER]
    return {
        c.comp_id: measure_component(c, seg, calib, projection_angles)
        for c in outers
    }
