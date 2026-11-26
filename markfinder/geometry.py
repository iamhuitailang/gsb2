"""几何工具：角度约定与旋转缩放矩阵。

角度约定（与数学一致，输出里也按此解释）：
- 单位：度，逆时针为正；0 表示模板原始朝向。
- 例如 90 表示模板相对原图逆时针转了 90 度。
"""

from __future__ import annotations

import math

import cv2
import numpy as np


def angle_diff(a: float, b: float) -> float:
    """两个角度之差，归一化到 (-180, 180]。"""
    d = (a - b + 180.0) % 360.0 - 180.0
    if d == -180.0:
        return 180.0
    return d


def make_rotation_scale_matrix(
    center: tuple[float, float],
    angle_deg: float,
    scale: float,
    flip: bool = False,
) -> np.ndarray:
    """生成 2x3 仿射矩阵：先（可选）水平翻面，再绕 center 旋转缩放。

    矩阵把 *模板坐标系* 下的点映射到 *目标图坐标系* 下的点。
    """
    cx, cy = center
    rot = cv2.getRotationMatrix2D((float(cx), float(cy)), float(angle_deg), float(scale))
    if flip:
        # 绕竖直中线水平翻转，再做旋转缩放，等价于先在模板空间翻面。
        flip_mat = np.array([[-1.0, 0.0, 2.0 * cx], [0.0, 1.0, 0.0]], dtype=np.float64)
        rot = rot @ np.vstack([flip_mat, [0.0, 0.0, 1.0]])
    return rot


def template_corners(template_w: int, template_h: int) -> np.ndarray:
    """模板四角（模板坐标系），形状 (4,2)。"""
    return np.array(
        [
            [0.0, 0.0],
            [template_w, 0.0],
            [template_w, template_h],
            [0.0, template_h],
        ],
        dtype=np.float64,
    )


def warp_corners(matrix: np.ndarray, corners: np.ndarray) -> np.ndarray:
    """用 2x3 仿射矩阵映射一组点，返回 (N,2) 坐标。"""
    n = corners.shape[0]
    homog = np.hstack([corners, np.ones((n, 1), dtype=np.float64)])
    return (homog @ matrix.T)[:, :2]
