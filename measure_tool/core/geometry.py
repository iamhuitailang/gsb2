"""像素坐标 <-> 标尺毫米坐标的几何换算。

两张标尺（横尺、纵尺）可以不互相垂直，也可以不与图片边平行。
标定用 4 个点描述：

- 横尺：p1 -> p2 两个像素点，对应毫米长度 length_mm（两点之间的真实距离）；
- 纵尺：p3 -> p4 两个像素点，对应毫米长度 length_mm。

约定横尺方向为标定坐标系的 u 轴、纵尺方向为 v 轴，
两尺交点（或各自延长线交点）为坐标原点 O。
任意像素点 p 的标尺坐标 (u, v) 按斜坐标仿射基求解，
因此非正交、有透视式倾斜时仍能给出自洽的毫米读数。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np


@dataclass
class Ruler:
    """一根标尺：像素端点 a -> b，对应 length_mm 毫米。"""

    a: tuple[float, float]
    b: tuple[float, float]
    length_mm: float
    name: str = ""

    def vector(self) -> np.ndarray:
        return np.array(self.b, dtype=float) - np.array(self.a, dtype=float)

    def pixel_length(self) -> float:
        return float(np.linalg.norm(self.vector()))

    def mm_per_pixel(self) -> float:
        """该标尺方向上 1 像素对应的毫米数。"""
        return self.length_mm / self.pixel_length()

    def pixels_per_mm(self) -> float:
        """该标尺方向上 1 毫米对应的像素数。"""
        return self.pixel_length() / self.length_mm


@dataclass
class Calibration:
    """横纵两根标尺建立的像素->毫米标定。"""

    horizontal: Ruler
    vertical: Ruler
    image_shape: tuple[int, int]  # (高, 宽)

    # 缓存项（__post_init__ 后填充）
    origin: np.ndarray = field(init=False)
    basis: np.ndarray = field(init=False)          # 列向量 = 每 1 mm 的像素位移，2x2
    pixel_to_mm: np.ndarray = field(init=False)    # 2x2
    valid_polygon: np.ndarray = field(init=False)  # 有效区域四边形顶点（像素）
    quality: dict = field(init=False)

    def __post_init__(self) -> None:
        h = self.horizontal
        v = self.vertical
        eh = h.vector() / h.pixel_length()          # 每像素方向单位向量
        ev = v.vector() / v.pixel_length()

        # 两尺直线交点作为斜坐标原点 O
        self.origin = _line_intersection(
            np.array(h.a, dtype=float), eh,
            np.array(v.a, dtype=float), ev,
        )

        # 每 1 mm 在像素空间中的位移（基向量，单位 px/mm）
        bu = eh * h.pixels_per_mm()
        bv = ev * v.pixels_per_mm()
        self.basis = np.column_stack([bu, bv])
        # 两尺近乎平行时 basis 奇异，退化为最小二乘逆，保证流程不崩
        if abs(np.linalg.det(self.basis)) < 1e-12:
            self.pixel_to_mm = np.linalg.pinv(self.basis)
        else:
            self.pixel_to_mm = np.linalg.inv(self.basis)

        self.valid_polygon = self._build_valid_polygon()
        self.quality = self._quality(eh, ev, h, v)

    # ------------------------------------------------------------------ #
    # 坐标换算
    # ------------------------------------------------------------------ #
    def to_mm_xy(self, points: np.ndarray) -> np.ndarray:
        """像素点 (x, y) 数组 -> 标尺坐标 (u_mm, v_mm) 数组。"""
        pts = np.asarray(points, dtype=float)
        rel = pts - self.origin
        return rel @ self.pixel_to_mm.T

    def to_pixel(self, uv: np.ndarray) -> np.ndarray:
        """标尺坐标 (u_mm, v_mm) -> 像素 (x, y)。"""
        uv = np.asarray(uv, dtype=float)
        return self.origin + uv @ self.basis.T

    def distance_mm(self, p: tuple[float, float], q: tuple[float, float]) -> float:
        """两点沿直线的欧氏毫米距离（用该方向上的毫米/像素均值换算）。"""
        p = np.array(p, dtype=float)
        q = np.array(q, dtype=float)
        d_px = q - p
        px_len = float(np.linalg.norm(d_px))
        if px_len < 1e-9:
            return 0.0
        direction = d_px / px_len
        # 该像素方向上每像素对应多少毫米：对两个基向量的逆变换做范数
        mm_step = float(np.linalg.norm(self.pixel_to_mm @ direction))
        return px_len * mm_step

    # ------------------------------------------------------------------ #
    # 有效测量区域
    # ------------------------------------------------------------------ #
    def _build_valid_polygon(self) -> np.ndarray:
        """有效区域 = 由横尺、纵尺张成的平行四边形。

        取两尺 4 个端点在斜坐标 (u, v) 下的 min/max，
        围成的平行四边形即标尺实际覆盖的范围；
        区域外的读数不可靠，需要给出提醒。
        """
        h, v = self.horizontal, self.vertical
        ends = np.array([h.a, h.b, v.a, v.b], dtype=float)
        uv = self.to_mm_xy(ends)
        u0, u1 = uv[:, 0].min(), uv[:, 0].max()
        v0, v1 = uv[:, 1].min(), uv[:, 1].max()
        corners_uv = np.array([
            [u0, v0], [u1, v0], [u1, v1], [u0, v1],
        ], dtype=float)
        return self.to_pixel(corners_uv)

    def points_inside_fraction(self, points: np.ndarray) -> float:
        """轮廓点落在有效区域内的比例（0~1）。"""
        pts = np.asarray(points, dtype=float)
        if len(pts) == 0:
            return 0.0
        uv = self.to_mm_xy(pts)
        poly_uv = self.to_mm_xy(self.valid_polygon)
        u0, u1 = poly_uv[:, 0].min(), poly_uv[:, 0].max()
        v0, v1 = poly_uv[:, 1].min(), poly_uv[:, 1].max()
        inside = (
            (uv[:, 0] >= u0) & (uv[:, 0] <= u1)
            & (uv[:, 1] >= v0) & (uv[:, 1] <= v1)
        )
        return float(inside.mean())

    def polygon_outside_parts(self, points: np.ndarray) -> np.ndarray:
        """返回落在有效区域外的点（像素坐标），用于界面高亮提醒。"""
        pts = np.asarray(points, dtype=float)
        if len(pts) == 0:
            return pts
        uv = self.to_mm_xy(pts)
        poly_uv = self.to_mm_xy(self.valid_polygon)
        u0, u1 = poly_uv[:, 0].min(), poly_uv[:, 0].max()
        v0, v1 = poly_uv[:, 1].min(), poly_uv[:, 1].max()
        outside = ~(
            (uv[:, 0] >= u0) & (uv[:, 0] <= u1)
            & (uv[:, 1] >= v0) & (uv[:, 1] <= v1)
        )
        return pts[outside]

    # ------------------------------------------------------------------ #
    def _quality(self, eh: np.ndarray, ev: np.ndarray,
                 h: Ruler, v: Ruler) -> dict:
        """标定质量信息：相对图边的倾斜、正交性、两尺 mm/px、原点位置。"""
        cos_angle = float(np.clip(np.dot(eh, ev), -1.0, 1.0))
        angle_deg = math.degrees(math.acos(cos_angle))
        # 横尺相对图片 x 轴的倾斜角（带符号，取主值 -90~90）
        tilt_h = math.degrees(math.atan2(eh[1], eh[0]))
        tilt_v = math.degrees(math.atan2(ev[1], ev[0]))
        height, width = self.image_shape[:2]
        ox, oy = self.origin
        return {
            "horizontal_mm_per_pixel": h.mm_per_pixel(),
            "vertical_mm_per_pixel": v.mm_per_pixel(),
            "ruler_angle_deg": angle_deg,
            "ruler_angle_from_orthogonal_deg": angle_deg - 90.0,
            "horizontal_tilt_deg": tilt_h,
            "vertical_tilt_deg": tilt_v,
            "origin_in_image": bool(0 <= ox <= width and 0 <= oy <= height),
            "origin_px": [float(ox), float(oy)],
            "scale_mismatch_percent": abs(h.mm_per_pixel() - v.mm_per_pixel())
            / max(h.mm_per_pixel(), 1e-12) * 100.0,
        }

    def to_dict(self) -> dict:
        return {
            "horizontal": {
                "a": list(self.horizontal.a),
                "b": list(self.horizontal.b),
                "length_mm": self.horizontal.length_mm,
                "name": self.horizontal.name,
            },
            "vertical": {
                "a": list(self.vertical.a),
                "b": list(self.vertical.b),
                "length_mm": self.vertical.length_mm,
                "name": self.vertical.name,
            },
            "image_shape": list(self.image_shape),
            "origin_px": self.origin.tolist(),
            "valid_polygon_px": self.valid_polygon.tolist(),
            "quality": self.quality,
        }


def _line_intersection(p1: np.ndarray, d1: np.ndarray,
                       p2: np.ndarray, d2: np.ndarray) -> np.ndarray:
    """两条直线 p1+t*d1、p2+s*d2 的交点；近似平行时退化为两点中点。"""
    a_mat = np.column_stack([d1, -d2])
    det = np.linalg.det(a_mat)
    if abs(det) < 1e-9:
        return (p1 + p2) / 2.0
    t, _s = np.linalg.solve(a_mat, p2 - p1)
    return p1 + t * d1


def calibration_from_dict(data: dict, image_shape: tuple[int, int] | None = None) -> Calibration:
    shape = tuple(image_shape or data["image_shape"])
    h = data["horizontal"]
    v = data["vertical"]
    return Calibration(
        horizontal=Ruler(tuple(h["a"]), tuple(h["b"]), h["length_mm"], h.get("name", "横尺")),
        vertical=Ruler(tuple(v["a"]), tuple(v["b"]), v["length_mm"], v.get("name", "纵尺")),
        image_shape=shape,
    )
