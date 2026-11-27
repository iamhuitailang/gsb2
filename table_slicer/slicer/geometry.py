"""几何与旋转工具。

所有切格工作在"拉正图"坐标系中进行；UI 需要在原图坐标系中联动显示，
因此这里统一维护两套坐标之间的仿射变换。

拉正流程：原图先按角度 angle 旋转（正角度表示逆时针，与 cv2 约定一致，
内部会做取负处理），再裁掉旋转产生的白边，得到拉正图。
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np


@dataclass(frozen=True)
class RotationInfo:
    """记录一次拉正的全部参数，供坐标反算使用。"""

    angle: float          # 拉正时实际施加的 OpenCV 旋转角（度）
    original_shape: tuple[int, int]   # (高, 宽)
    rotated_shape: tuple[int, int]    # 旋转后未裁白边的图 (高, 宽)
    crop_x: int           # 拉正图左上角在旋转后图中的 x
    crop_y: int
    width: int            # 拉正图宽高
    height: int

    def to_dict(self) -> dict:
        return {
            "angle": self.angle,
            "original_shape": list(self.original_shape),
            "rotated_shape": list(self.rotated_shape),
            "crop_x": self.crop_x,
            "crop_y": self.crop_y,
            "width": self.width,
            "height": self.height,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "RotationInfo":
        return cls(
            angle=float(d["angle"]),
            original_shape=tuple(d["original_shape"]),
            rotated_shape=tuple(d["rotated_shape"]),
            crop_x=int(d["crop_x"]),
            crop_y=int(d["crop_y"]),
            width=int(d["width"]),
            height=int(d["height"]),
        )


def _content_bbox(binary: np.ndarray) -> tuple[int, int, int, int] | None:
    """在二值图（内容为 0、背景为 255）上找非白内容的包围盒。"""
    mask = binary < 200
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def deskew(image: np.ndarray, max_angle: float = 5.0) -> tuple[np.ndarray, RotationInfo]:
    """把轻微旋转的扫描件拉正。

    返回拉正后的图和 :class:`RotationInfo`。找不到可靠角度时按 0 度处理。
    """
    h, w = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image.copy()
    # 自适应阈值，浅框线也能保留
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 31, 15
    )

    angle = _estimate_angle(binary, max_angle)

    center = (w / 2.0, h / 2.0)
    # 实测：OpenCV 正角在图像坐标（y 向下）中为视觉顺时针，
    # 横线方向角 alpha 经 +alpha 旋转后归零
    matrix = cv2.getRotationMatrix2D(center, angle, 1.0)
    cos = abs(matrix[0, 0])
    sin = abs(matrix[0, 1])
    rot_w = int(round(h * sin + w * cos))
    rot_h = int(round(h * cos + w * sin))
    matrix[0, 2] += (rot_w - w) / 2.0
    matrix[1, 2] += (rot_h - h) / 2.0

    border = (255, 255, 255) if image.ndim == 3 else (255,)
    rotated = cv2.warpAffine(
        image, matrix, (rot_w, rot_h),
        flags=cv2.INTER_CUBIC, borderValue=border,
    )
    rot_gray = cv2.cvtColor(rotated, cv2.COLOR_BGR2GRAY) if rotated.ndim == 3 else rotated
    _, rot_bin = cv2.threshold(rot_gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    bbox = _content_bbox(255 - rot_bin)
    if bbox is None:
        crop_x = crop_y = 0
        out_w, out_h = rot_w, rot_h
    else:
        x0, y0, x1, y1 = bbox
        pad = 8
        crop_x = max(0, x0 - pad)
        crop_y = max(0, y0 - pad)
        x1 = min(rot_w, x1 + pad)
        y1 = min(rot_h, y1 + pad)
        out_w, out_h = x1 - crop_x, y1 - crop_y
    deskewed = rotated[crop_y:crop_y + out_h, crop_x:crop_x + out_w].copy()

    info = RotationInfo(
        angle=angle,
        original_shape=(h, w),
        rotated_shape=(rot_h, rot_w),
        crop_x=crop_x,
        crop_y=crop_y,
        width=out_w,
        height=out_h,
    )
    return deskewed, info


def _estimate_angle(binary_inv: np.ndarray, max_angle: float) -> float:
    """用霍夫直线估计整体倾斜角；线太少时退化为 0。"""
    edges = cv2.Canny(binary_inv, 50, 150, apertureSize=3)
    lines = cv2.HoughLinesP(
        edges, rho=1, theta=np.pi / 180,
        threshold=80, minLineLength=max(40, min(binary_inv.shape) // 6),
        maxLineGap=12,
    )
    if lines is None or len(lines) < 4:
        return 0.0
    lines = lines.reshape(-1, 4)
    h_angles: list[float] = []
    v_angles: list[float] = []
    for x1, y1, x2, y2 in lines:
        dx, dy = x2 - x1, y2 - y1
        length = math.hypot(dx, dy)
        if length < 1e-6:
            continue
        a = math.degrees(math.atan2(dy, dx))
        # 归一化到 [-90, 90)
        a = ((a + 90) % 180) - 90
        if abs(a) <= max_angle:
            h_angles.append(a)          # 近水平：角度即横线倾角
        elif abs(abs(a) - 90) <= max_angle:
            v_angles.append(a + 90.0)   # 近竖直：折算成同口径的横线倾角
    candidates = h_angles + v_angles
    if not candidates:
        return 0.0
    return float(np.median(candidates))


def _rotation_matrix(info: RotationInfo) -> np.ndarray:
    h, w = info.original_shape
    center = (w / 2.0, h / 2.0)
    m = cv2.getRotationMatrix2D(center, info.angle, 1.0)
    rot_h, rot_w = info.rotated_shape
    m[0, 2] += (rot_w - w) / 2.0
    m[1, 2] += (rot_h - h) / 2.0
    return m


def rectified_to_original(pts: np.ndarray, info: RotationInfo) -> np.ndarray:
    """拉正图坐标 (x, y) -> 原图坐标。"""
    pts = np.asarray(pts, dtype=np.float64)
    if pts.size == 0:
        return pts.reshape(-1, 2)
    pts = pts.reshape(-1, 2).copy()
    pts[:, 0] += info.crop_x
    pts[:, 1] += info.crop_y
    m = _rotation_matrix(info)
    # 逆变换：旋转矩阵是 2x3，求逆仿射
    inv = cv2.invertAffineTransform(m)
    ones = np.ones((pts.shape[0], 1), dtype=np.float64)
    homo = np.hstack([pts, ones])
    return homo @ inv.T


def original_to_rectified(pts: np.ndarray, info: RotationInfo) -> np.ndarray:
    """原图坐标 (x, y) -> 拉正图坐标。"""
    pts = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
    if pts.size == 0:
        return pts.reshape(-1, 2)
    m = _rotation_matrix(info)
    ones = np.ones((pts.shape[0], 1), dtype=np.float64)
    homo = np.hstack([pts, ones])
    out = homo @ m.T
    out[:, 0] -= info.crop_x
    out[:, 1] -= info.crop_y
    return out
