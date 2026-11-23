"""ECC 图像配准。

同一场景的多张照片因对焦呼吸（focus breathing）存在小幅缩放和平移，
用 cv2.findTransformECC 估计每张源图到参考帧的 2x3 仿射变换。

配准结果分三档：
- ok:   相关系数高且变换参数在合理范围内
- warn: 相关系数偏低，或变换偏大（可能是错位照片）
- fail: ECC 不收敛 / 相关系数过低 / 变换严重不合理，该源不参与自动合成

失败判定阈值集中在 RegistrationConfig，界面与测试都可覆盖。
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from .geometry import (
    TransformStats,
    common_coverage,
    coverage_mask,
    identity,
    invert_affine,
    warp_image,
)

# 结果状态常量
STATUS_OK = "ok"
STATUS_WARN = "warn"
STATUS_FAIL = "fail"

# 配准预览中各源边缘使用的 BGR 颜色（第 0 张参考图用白色）
EDGE_COLORS_BGR = [
    (255, 255, 255), (0, 255, 255), (255, 80, 0), (0, 255, 0),
    (255, 0, 255), (0, 200, 255), (200, 128, 255),
]


@dataclass
class RegistrationConfig:
    motion: int = cv2.MOTION_AFFINE
    max_iter: int = 200
    epsilon: float = 1e-7
    pyramid_levels: int = 2          # 0 表示不做金字塔
    gauss_filt: int = 5
    # 相关系数阈值
    cc_warn: float = 0.75
    cc_fail: float = 0.45
    # 变换合理性（相对参考帧尺寸）
    max_scale_dev: float = 0.10      # 缩放偏离 1 的上限，±10%
    max_shear: float = 0.08
    max_rotation_deg: float = 5.0
    max_translation_frac: float = 0.20  # 平移上限 = 短边 × 该比例
    low_texture_var: float = 60.0    # 参考图方差过低时给警告


@dataclass
class ImageRegistration:
    index: int
    matrix: np.ndarray                # 源坐标 -> 参考帧坐标，2x3
    correlation: float
    status: str
    message: str
    coverage: np.ndarray | None = None  # uint8 0/255，参考帧上的有效区

    @property
    def usable(self) -> bool:
        return self.status != STATUS_FAIL


@dataclass
class Registration:
    ref_index: int
    items: list[ImageRegistration]
    ref_shape: tuple[int, int]
    config: RegistrationConfig
    common_mask: np.ndarray = field(default=None)  # type: ignore[assignment]

    def matrix_of(self, index: int) -> np.ndarray:
        return self.items[index].matrix

    def usable_indices(self) -> list[int]:
        return [it.index for it in self.items if it.usable]


def _to_gray_float(image: np.ndarray) -> np.ndarray:
    if image.ndim == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        gray = image
    return gray.astype(np.float32) / 255.0


def _find_ecc_pyramid(template: np.ndarray, moving: np.ndarray,
                      cfg: RegistrationConfig) -> tuple[float, np.ndarray]:
    """金字塔多尺度 ECC。返回 (相关系数, 2x3 仿射)。失败时抛 cv2.error。"""
    warp = identity().astype(np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT,
                cfg.max_iter, cfg.epsilon)
    levels = max(1, cfg.pyramid_levels + 1)

    # 从最粗层开始，逐层把上一层估计放大 2 倍作为初值
    for level in range(levels - 1, -1, -1):
        scale = 2 ** level
        if scale > 1:
            interp = cv2.INTER_AREA
            t = cv2.resize(template, None, fx=1.0 / scale, fy=1.0 / scale,
                           interpolation=interp)
            m_img = cv2.resize(moving, None, fx=1.0 / scale, fy=1.0 / scale,
                               interpolation=interp)
            # 平移项按该层尺度缩放；线性部分不变
            w = warp.copy()
            w[:, 2] /= scale
        else:
            t = template
            m_img = moving
            w = warp.copy()
        cc, w = cv2.findTransformECC(
            t, m_img, w, cfg.motion, criteria, None, cfg.gauss_filt)
        if level > 0:
            w = w.copy()
            w[:, 2] *= scale
        warp = w
    return float(cc), warp.astype(np.float64)


def _check_stats(mat: np.ndarray, cc: float, shape: tuple[int, int],
                 cfg: RegistrationConfig) -> tuple[str, str]:
    """根据相关系数与变换参数给出状态与说明。"""
    st = TransformStats.from_matrix(mat)
    problems: list[str] = []
    severe = False

    if cc < cfg.cc_fail:
        severe = True
        problems.append(f"相关系数 {cc:.3f} 低于失败阈值 {cfg.cc_fail:.2f}")
    elif cc < cfg.cc_warn:
        problems.append(f"相关系数 {cc:.3f} 低于警告阈值 {cfg.cc_warn:.2f}")

    if abs(st.scale_x - 1) > cfg.max_scale_dev or abs(st.scale_y - 1) > cfg.max_scale_dev:
        severe = True
        problems.append(
            f"缩放异常 (sx={st.scale_x:.3f}, sy={st.scale_y:.3f})，"
            f"允许偏差 ±{cfg.max_scale_dev:.0%}")
    if st.shear > cfg.max_shear:
        problems.append(f"剪切偏大 ({st.shear:.3f} > {cfg.max_shear})")
    if abs(st.rotation_deg) > cfg.max_rotation_deg:
        severe = True
        problems.append(
            f"旋转 {st.rotation_deg:.2f}° 超过 {cfg.max_rotation_deg:.1f}°")
    limit = cfg.max_translation_frac * min(shape[:2])
    if max(abs(st.translation_x), abs(st.translation_y)) > limit:
        severe = True
        problems.append(
            f"平移 ({st.translation_x:.1f}, {st.translation_y:.1f}) px "
            f"超过短边的 {cfg.max_translation_frac:.0%}（{limit:.1f} px）")

    if severe:
        return STATUS_FAIL, "；".join(problems)
    if problems:
        return STATUS_WARN, "；".join(problems)
    return STATUS_OK, f"相关系数 {cc:.3f}，变换在合理范围内"


def register_images(images: list[np.ndarray], ref_index: int = 0,
                    cfg: RegistrationConfig | None = None,
                    progress=None) -> Registration:
    """对一组同尺寸图像做 ECC 配准。

    images:  BGR 或灰度图列表，顺序即用户给定顺序（不会被重排）。
    ref_index: 参考帧下标（默认第 0 张）。
    progress: 可选回调 progress(done, total, index)。
    """
    if not 2 <= len(images) <= 8:
        raise ValueError("源图数量需在 2~8 张之间")
    cfg = cfg or RegistrationConfig()
    ref_img = images[ref_index]
    ref_shape = ref_img.shape[:2]
    template = _to_gray_float(ref_img)

    # 低纹理参考图警告（纯色场景 ECC 本身就不可靠）
    ref_gray = template
    ref_var = float(ref_gray.var() * 255 * 255)

    items: list[ImageRegistration] = []
    for i, img in enumerate(images):
        if img.shape[:2] != ref_shape:
            raise ValueError(f"第 {i + 1} 张图尺寸 {img.shape[:2]} 与参考图 {ref_shape} 不一致")
        if i == ref_index:
            mat = identity()
            cc = 1.0
            status, msg = STATUS_OK, "参考帧"
        else:
            moving = _to_gray_float(img)
            try:
                cc, mat = _find_ecc_pyramid(template, moving, cfg)
                status, msg = _check_stats(mat, cc, ref_shape, cfg)
            except cv2.error as exc:
                cc, mat = 0.0, identity()
                status = STATUS_FAIL
                msg = f"ECC 不收敛：{exc.err if hasattr(exc, 'err') else exc}"
        if i == ref_index and ref_var < cfg.low_texture_var:
            status = STATUS_WARN
            msg += f"；参考图纹理偏少（方差 {ref_var:.0f}），配准可能不稳定"
        # 覆盖掩码需要“源坐标 -> 参考帧坐标”的映射，ECC 矩阵取逆
        src_to_ref = identity() if i == ref_index else invert_affine(mat)
        cov = coverage_mask(src_to_ref, img.shape[:2], ref_shape)
        items.append(ImageRegistration(i, mat, cc, status, msg, cov))
        if progress:
            progress(i + 1, len(images), i)

    common = common_coverage([it.coverage for it in items if it.usable])
    return Registration(ref_index, items, ref_shape, cfg, common)


def align_images(images: list[np.ndarray], reg: Registration) -> list[np.ndarray]:
    """按配准结果把所有源图 warp 到参考帧（越界填 0）。

    ECC 估计的矩阵语义是“参考帧坐标 -> 该源坐标”，而 warp_image 需要
    “源坐标 -> 参考帧坐标”的正向映射，因此这里取逆。
    """
    out = []
    for i, img in enumerate(images):
        if i == reg.ref_index:
            out.append(img.copy())
        else:
            src_to_ref = invert_affine(reg.matrix_of(i))
            out.append(warp_image(img, src_to_ref, reg.ref_shape, 0))
    return out


def edge_overlay(images: list[np.ndarray], reg: Registration,
                 canny_lo: int = 60, canny_hi: int = 160) -> np.ndarray:
    """配准边缘对照图：参考帧灰度底图 + 各源 Canny 边缘（不同颜色）。

    边缘对得齐时不同颜色会重合（发白/叠加色），错位时会看到彩色重边。
    """
    h, w = reg.ref_shape
    ref_gray = cv2.cvtColor(images[reg.ref_index], cv2.COLOR_BGR2GRAY) \
        if images[reg.ref_index].ndim == 3 else images[reg.ref_index]
    canvas = cv2.cvtColor(ref_gray, cv2.COLOR_GRAY2BGR)
    canvas = (canvas * 0.45).astype(np.uint8)

    aligned = align_images(images, reg)
    for i, img in enumerate(aligned):
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
        edges = cv2.Canny(gray, canny_lo, canny_hi)
        edges = cv2.bitwise_and(edges, reg.items[i].coverage)
        color = EDGE_COLORS_BGR[i % len(EDGE_COLORS_BGR)]
        layer = np.zeros_like(canvas)
        layer[edges > 0] = color
        canvas = cv2.add(canvas, layer)
    return canvas


def coverage_overlay(reg: Registration) -> np.ndarray:
    """覆盖区示意图：每张源的覆盖多边形用不同颜色，交集为亮色。"""
    h, w = reg.ref_shape
    canvas = np.zeros((h, w, 3), dtype=np.uint8)
    for i, it in enumerate(reg.items):
        color = EDGE_COLORS_BGR[i % len(EDGE_COLORS_BGR)]
        layer = np.zeros_like(canvas)
        layer[it.coverage > 0] = color
        canvas = cv2.add(canvas, layer // 3)
    if reg.common_mask is not None:
        canvas[reg.common_mask > 0] = (
            canvas[reg.common_mask > 0] // 2 + np.array([80, 80, 80], np.uint8))
    return canvas
