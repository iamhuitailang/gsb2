"""几何工具：仿射变换的组合、求逆、warp 与公共覆盖区。

坐标约定：所有 warp 矩阵 M 都是 2x3 仿射矩阵，满足
    x_ref = M @ [x_src, y_src, 1]^T
即把“源图坐标”映射到“参考帧坐标”。warp_image 把源图重采样到参考帧。
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


IDENTITY_2x3 = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], dtype=np.float64)


def identity() -> np.ndarray:
    return IDENTITY_2x3.copy()


def invert_affine(m: np.ndarray) -> np.ndarray:
    """返回 2x3 仿射矩阵的逆（精确求逆，不用 cv2.invert 的近似）。"""
    m = np.asarray(m, dtype=np.float64)
    a = m[:2, :2]
    t = m[:2, 2]
    a_inv = np.linalg.inv(a)
    out = np.zeros((2, 3), dtype=np.float64)
    out[:2, :2] = a_inv
    out[:2, 2] = -a_inv @ t
    return out


def compose(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """组合两个 2x3 仿射：先 b 后 a，即返回 a∘b。"""
    a3 = np.eye(3, dtype=np.float64)
    b3 = np.eye(3, dtype=np.float64)
    a3[:2, :] = a
    b3[:2, :] = b
    c = a3 @ b3
    return c[:2, :].astype(np.float64)


def warp_image(image: np.ndarray, m: np.ndarray, shape: tuple[int, int],
               border_value: int | float | tuple = 0) -> np.ndarray:
    """按 m（源坐标 -> 参考帧坐标）把 image 重采样到 (H, W) 的参考帧。

    输出与输入同 dtype；越界像素填 border_value。
    """
    # cv2.warpAffine 内部会对矩阵求逆：传入“源坐标 -> 参考帧坐标”的正向
    # 仿射，得到的正是参考帧上的重采样结果，与 coverage_mask 的多边形变换同源。
    h, w = shape
    return cv2.warpAffine(
        image, np.asarray(m, dtype=np.float32), (w, h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT, borderValue=border_value,
    )


def coverage_mask(m: np.ndarray, src_shape: tuple[int, int],
                  ref_shape: tuple[int, int]) -> np.ndarray:
    """源图经 m 变换后，在参考帧上的有效覆盖掩码（uint8, 0/255）。

    把源图四角多边形变换到参考帧并栅格化，得到该源真正有像素的区域。
    """
    sh, sw = src_shape[:2]
    rh, rw = ref_shape[:2]
    corners = np.array([
        [0, 0, 1], [sw - 1, 0, 1], [sw - 1, sh - 1, 1], [0, sh - 1, 1]
    ], dtype=np.float64).T
    warped = np.asarray(m, dtype=np.float64) @ corners
    pts = np.round(warped.T).astype(np.int32)
    mask = np.zeros((rh, rw), dtype=np.uint8)
    cv2.fillConvexPoly(mask, pts, 255)
    return mask


def common_coverage(masks: list[np.ndarray]) -> np.ndarray:
    """所有源都覆盖的交集掩码（uint8, 0/255）。"""
    assert masks, "至少需要一个掩码"
    out = masks[0].copy()
    for m in masks[1:]:
        out = cv2.bitwise_and(out, m)
    return out


def mask_bounding_box(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    """返回掩码的 (x0, y0, x1, y1)；全空返回 None。"""
    ys, xs = np.where(mask > 0)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def crop_to_mask(image: np.ndarray, mask: np.ndarray):
    """按掩码外接矩形裁剪图像与掩码，返回 (image_crop, mask_crop, bbox)。"""
    bbox = mask_bounding_box(mask)
    if bbox is None:
        raise ValueError("覆盖掩码为空，无法裁剪")
    x0, y0, x1, y1 = bbox
    return image[y0:y1, x0:x1].copy(), mask[y0:y1, x0:x1].copy(), bbox


@dataclass(frozen=True)
class TransformStats:
    """仿射变换相对单位阵的偏离量，用于配准合理性检查。"""
    scale_x: float
    scale_y: float
    shear: float
    translation_x: float
    translation_y: float
    rotation_deg: float

    @classmethod
    def from_matrix(cls, m: np.ndarray) -> "TransformStats":
        m = np.asarray(m, dtype=np.float64)
        a, b = m[0, 0], m[0, 1]
        c, d = m[1, 0], m[1, 1]
        sx = float(np.hypot(a, b))
        sy = float(np.hypot(c, d))
        rot = float(np.degrees(np.arctan2(c, d)))
        # 剪切用非正交程度度量：列向量点积 / 列长乘积
        shear = float(abs(a * c + b * d) / max(sx * sy, 1e-12))
        return cls(sx, sy, shear, float(m[0, 2]), float(m[1, 2]), rot)
