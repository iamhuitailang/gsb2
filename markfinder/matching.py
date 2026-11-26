"""旋转/缩放/翻面模板匹配核心。

打分采用 *掩膜零均值归一化互相关（masked NCC）*：
掩膜外的像素不参与统计，因此圈模板时带进来的背景不会干扰匹配；
NCC 对线性光照变化不敏感。遮挡鲁棒性由网格单元的局部 NCC 提供
（:func:`score_pose` 返回逐单元分数与 25 分位数 robust_score）。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable

import cv2
import numpy as np

from .candidates import (
    Match,
    local_maxima,
    scale_grid,
    subpixel_refine,
)
from .geometry import template_corners, warp_corners
from .template import Template

ProgressCb = Callable[[int, int, str], None]

# 角度精修时在粗角度两侧展开的步数与细分。
# 方向 chamfer 的角度平台很宽（±3° 内高分），细步距取粗步距的 1/2、
# 合计覆盖 ±1 个粗步距即可，无需灰度 NCC 时代的 0.5° 密网格。
_REFINE_HALF_STEPS = 2
_REFINE_SUBDIV = 2
# 单元内至少有这么多掩膜像素，单元分数才有效
_MIN_CELL_PIXELS = 20
_NCC_EPS = 1e-8


@dataclass
class SearchParams:
    """查找参数。"""

    min_angle: float = 0.0
    max_angle: float = 360.0
    angle_step: float = 5.0
    min_scale: float = 0.8
    max_scale: float = 1.25
    num_scales: int = 5
    allow_flip: bool = False
    # 主分是方向 chamfer（clip 到 [-1,1]，真标记通常 0.8+，干扰项 <0.5）
    score_threshold: float = 0.6
    # 反向边缘覆盖率门控：低于此值说明模板边缘只是目标边缘的一个小子集
    # （典型的小缩放/部分匹配误报），直接拒绝。取值 0.2 以保留遮挡标记
    # （遮挡会显著降低覆盖率，但方向 chamfer 主分仍高）。
    coverage_threshold: float = 0.25
    max_matches: int = 200
    peaks_per_pose: int = 30
    cell_rows: int = 4
    cell_cols: int = 4
    refine: bool = True
    # 强制使用指定画布边长（合成验证时与生成端几何对齐用）；None 则自动计算
    canvas_size_override: int | None = None
    progress: ProgressCb | None = None

    def pose_count(self) -> int:
        n_ang = max(1, int(math.floor((self.max_angle - self.min_angle) / self.angle_step)))
        n_flip = 2 if self.allow_flip else 1
        return n_ang * max(1, self.num_scales) * n_flip


@dataclass
class PoseResult:
    """单个位姿的评估结果，供局部对照视图使用。"""

    warped_template: np.ndarray
    warped_mask: np.ndarray
    target_crop: np.ndarray
    matrix: np.ndarray
    score: float
    cell_scores: np.ndarray
    cell_rows: int
    cell_cols: int


def _to_gray(image: np.ndarray) -> np.ndarray:
    if image.ndim == 2:
        return image.astype(np.float64)
    return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float64)


def _edge_binary(image: np.ndarray) -> np.ndarray:
    """二值边缘图（Canny），单通道 0/255。"""
    gray = _to_gray(image).astype(np.uint8)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    return cv2.Canny(gray, 50, 150)


def _distance_field(image: np.ndarray) -> np.ndarray:
    """目标图的边缘距离场：边缘像素为 0，其余为到最近边缘的欧氏距离。"""
    edges = _edge_binary(image)
    inverted = cv2.threshold(edges, 1, 255, cv2.THRESH_BINARY_INV)[1]
    return cv2.distanceTransform(inverted, cv2.DIST_L2, 3)


# chamfer 分数归一用的距离尺度（像素）：平均距离超过它记为完全不匹配
_CHAMFER_SCALE = 12.0


def chamfer_map(
    dist_field: np.ndarray,
    warped_template: np.ndarray,
    warped_mask: np.ndarray,
) -> np.ndarray:
    """滑窗 chamfer 匹配分数图。

    模板二值边缘点在目标距离场上取平均距离 d，分数 = clip(1 - d/scale, -1, 1]。
    与 NCC 相比，位姿偏 1~3px 只会让距离平滑增大，因此对旋转/缩放
    网格的量化误差鲁棒，适合做粗搜索。
    """
    tpl_edges = cv2.bitwise_and(_edge_binary(warped_template), warped_mask)
    kernel = (tpl_edges > 0).astype(np.float32)
    n_points = float(kernel.sum())
    if n_points < 8:
        h = max(1, dist_field.shape[0] - warped_mask.shape[0] + 1)
        w = max(1, dist_field.shape[1] - warped_mask.shape[1] + 1)
        return np.zeros((h, w), dtype=np.float64)
    dist_sum = cv2.matchTemplate(
        dist_field.astype(np.float32), kernel, cv2.TM_CCORR
    ).astype(np.float64)
    mean_dist = dist_sum / n_points
    return np.clip(1.0 - mean_dist / _CHAMFER_SCALE, -1.0, 1.0)


# 方向 chamfer 的无向方向箱数（θ mod 180°，硬边无极性）
_N_ORI_BINS = 6
# 截尾比例：丢掉逐点距离最差的 25%，对局部缺角/遮挡鲁棒
_TRIM_RATIO = 0.25


def _sobel_gradients(image: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """返回 (gx, gy, 幅值)，float32。"""
    gray = _to_gray(image).astype(np.float32)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    return gx, gy, cv2.magnitude(gx, gy)


def orientation_distance_fields(
    image: np.ndarray, n_bins: int = _N_ORI_BINS
) -> tuple[np.ndarray, np.ndarray]:
    """构建无向方向箱距离场。

    返回 (fields, edge_mask)：
    - ``fields`` 形状 (n_bins, H, W)，第 k 层是“方向落在第 k 箱的目标
      边缘像素”的距离变换（边缘处为 0，越远越大）；
    - ``edge_mask`` 目标二值边缘 (H,W)，供反向覆盖率使用。

    方向取梯度法向并 mod 180°（无向），用 Sobel 幅值的相对阈值选边缘，
    比固定 Canny 阈值在模糊/低对比图上更稳。
    """
    gx, gy, mag = _sobel_gradients(image)
    # 无向方向：[0,180)
    ori = np.mod(cv2.phase(gx, gy, angleInDegrees=True), 180.0)
    thresh = max(20.0, float(np.percentile(mag[mag > 1e-3], 80)) if (mag > 1e-3).any() else 20.0)
    edge = (mag >= thresh).astype(np.uint8)
    h, w = edge.shape
    fields = np.zeros((n_bins, h, w), dtype=np.float32)
    bin_idx = np.floor(ori / (180.0 / n_bins)).astype(np.int32) % n_bins
    for k in range(n_bins):
        seg = np.where(edge & (bin_idx == k), 0, 255).astype(np.uint8)
        fields[k] = cv2.distanceTransform(seg, cv2.DIST_L2, 3)
    return fields, edge


def _template_edge_points(
    warped_template: np.ndarray, warped_mask: np.ndarray, n_bins: int
) -> tuple[np.ndarray, np.ndarray]:
    """提取 warped 模板的边缘点坐标与无向方向箱。

    返回 (points[N,2]=(y,x) 整数坐标, bins[N])。直接对 warped 模板做
    Sobel，方向同样 mod 180°。
    """
    gx, gy, mag = _sobel_gradients(warped_template)
    edges = cv2.bitwise_and(_edge_binary(warped_template), warped_mask)
    ys, xs = np.where(edges > 0)
    if len(ys) == 0:
        return np.zeros((0, 2), np.int64), np.zeros((0,), np.int64)
    ori = np.mod(cv2.phase(gx, gy, angleInDegrees=True), 180.0)
    bins = np.floor(ori[ys, xs] / (180.0 / n_bins)).astype(np.int32) % n_bins
    return np.stack([ys, xs], axis=1), bins


def oriented_chamfer_score(
    fields: np.ndarray,
    image_edges: np.ndarray,
    warped_template: np.ndarray,
    warped_mask: np.ndarray,
    top_left: tuple[float, float],
    n_bins: int = _N_ORI_BINS,
) -> tuple[float, float]:
    """在候选位姿做点wise 方向 chamfer 打分。

    模板每个边缘点按自身方向箱，到目标对应方向距离场取距离；逐点距离做
    截尾均值（丢最差 25%），主分 = clip(1 - d/scale, -1, 1]。
    另算反向覆盖率 = 模板窗内目标边缘被模板边缘（膨胀 2px）覆盖的比例，
    用来挡住“模板边缘是目标边缘子集”式的部分匹配误报。

    返回 (主分, 反向覆盖率)。``top_left`` 为模板画布左上角在目标图的浮点坐标。
    """
    points, bins = _template_edge_points(warped_template, warped_mask, n_bins)
    if points.shape[0] < 8:
        return 0.0, 0.0
    h_img, w_img = fields.shape[1:]
    ty = np.rint(points[:, 0] + top_left[1]).astype(np.int64)
    tx = np.rint(points[:, 1] + top_left[0]).astype(np.int64)
    valid = (ty >= 0) & (ty < h_img) & (tx >= 0) & (tx < w_img)
    ty, tx, tb = ty[valid], tx[valid], bins[valid]
    if ty.size < 8:
        return 0.0, 0.0
    # 各点到“同方向”目标边缘的距离
    dists = fields[tb, ty, tx].astype(np.float64)
    dists.sort()
    keep = max(1, int(round(dists.size * (1.0 - _TRIM_RATIO))))
    trimmed_mean = float(dists[:keep].mean())
    main = float(np.clip(1.0 - trimmed_mean / _CHAMFER_SCALE, -1.0, 1.0))

    # 反向覆盖：模板边缘膨胀后，在对应窗口内覆盖了多少目标边缘
    tpl_edge = cv2.bitwise_and(_edge_binary(warped_template), warped_mask)
    dilated = cv2.dilate(tpl_edge, np.ones((5, 5), np.uint8))
    s = warped_mask.shape[0]
    u0, v0 = int(round(top_left[0])), int(round(top_left[1]))
    x0, y0 = max(u0, 0), max(v0, 0)
    x1, y1 = min(u0 + s, w_img), min(v0 + s, h_img)
    if x1 <= x0 or y1 <= y0:
        return main, 0.0
    win_edges = image_edges[y0:y1, x0:x1]
    win_tpl = dilated[y0 - v0:y1 - v0, x0 - u0:x1 - u0]
    n_img_edges = int((win_edges > 0).sum())
    coverage = (
        float(np.logical_and(win_edges > 0, win_tpl > 0).sum()) / n_img_edges
        if n_img_edges > 0
        else 0.0
    )
    return main, float(coverage)


def fixed_canvas_size(template: Template, max_scale: float) -> int:
    """同一次查找里所有位姿共用的画布边长（按最大缩放的旋转外接框取奇数）。

    画布固定后，模板中心永远对齐画布中心，不同缩放/角度的滑窗结果
    才能在同一坐标系下比较，精修时也不会因画布大小变化而错位。
    """
    diag = math.hypot(template.width, template.height) * max_scale
    size = int(math.ceil(diag)) + 6
    return size if size % 2 else size + 1


def warp_pose(
    template: Template,
    angle: float,
    scale: float,
    flip: bool,
    canvas_size: int | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    """把模板变换到一张方形画布上，模板中心对齐画布中心。

    返回 (warped_bgr, warped_mask, 2x3 仿射矩阵, 画布边长)。
    """
    if canvas_size is None:
        diag = math.hypot(template.width, template.height) * scale
        canvas_size = int(math.ceil(diag)) + 4
    s = canvas_size
    tpl_cx, tpl_cy = template.width / 2.0, template.height / 2.0
    matrix = cv2.getRotationMatrix2D((tpl_cx, tpl_cy), float(angle), float(scale))
    # 把模板中心平移到画布中心
    matrix[:, 2] += np.array([s / 2.0 - tpl_cx, s / 2.0 - tpl_cy], dtype=np.float64)
    if flip:
        flip_mat = np.array(
            [[-1.0, 0.0, 2.0 * tpl_cx], [0.0, 1.0, 0.0]],
            dtype=np.float64,
        )
        matrix = matrix @ np.vstack([flip_mat, [0.0, 0.0, 1.0]])
    warped = cv2.warpAffine(
        template.image,
        matrix,
        (s, s),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0),
    )
    wmask = cv2.warpAffine(
        template.mask,
        matrix,
        (s, s),
        flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    _, wmask = cv2.threshold(wmask, 127, 255, cv2.THRESH_BINARY)
    return warped, wmask, matrix, s


def masked_ncc_map(
    image_gray: np.ndarray,
    warped_template_gray: np.ndarray,
    warped_mask: np.ndarray,
) -> np.ndarray:
    """整图滑窗的掩膜零均值 NCC 分数图，尺寸 (H-S+1, W-S+1)。

    对每个窗口 Ω（掩膜像素集合，n=|Ω|）计算：

        NCC = Σ(I-Ī)(T-T̄) / sqrt(Σ(I-Ī)² · Σ(T-T̄)²)

    展开后只需四种滑窗求和（ΣI、ΣI²、ΣT、ΣIT），
    用 OpenCV 积分图/相关一次算完；掩膜外像素一律不参与。
    """
    m = (warped_mask > 0).astype(np.float32)
    n_pixels = float(m.sum())
    out_h = image_gray.shape[0] - m.shape[0] + 1
    out_w = image_gray.shape[1] - m.shape[1] + 1
    if n_pixels < 4 or out_h <= 0 or out_w <= 0:
        return np.zeros((max(1, out_h), max(1, out_w)), dtype=np.float64)

    img = image_gray.astype(np.float64)
    tpl = warped_template_gray.astype(np.float64)
    t_mean = float((tpl * m).sum() / n_pixels)
    t0 = ((tpl - t_mean) * m).astype(np.float32)
    t_sq = float((t0.astype(np.float64) ** 2).sum())
    if t_sq < _NCC_EPS:
        return np.zeros((max(1, out_h), max(1, out_w)), dtype=np.float64)

    # 掩膜加权的窗口统计：把掩膜（及 t0）当作相关核做 CCORR，
    # 每个输出位置就是该窗口内“掩膜像素”的 ΣI、ΣI²、ΣI·T0。
    # 图像与核都用 32F（OpenCV 限制）；窗口最大约 1e6 个像素、
    # 灰度 255，累加 ~6e10 在 32F 整数精度内仍可分辨（2^24≈1.7e7），
    # 方差项随后转 64F 计算以避免抵消。
    m32 = m.astype(np.float32)
    img32 = img.astype(np.float32)
    sum_i = cv2.matchTemplate(img32, m32, cv2.TM_CCORR).astype(np.float64)
    sum_i2 = cv2.matchTemplate((img * img).astype(np.float32), m32, cv2.TM_CCORR).astype(
        np.float64
    )
    cross = cv2.matchTemplate(img32, t0, cv2.TM_CCORR).astype(np.float64)

    i_mean = sum_i / n_pixels
    numerator = cross - i_mean * float(t0.sum())  # t0 已零均值，第二项实际为 0，保留以稳健
    denom_i = np.maximum(sum_i2 - (sum_i * sum_i) / n_pixels, 0.0)
    denom = np.sqrt(denom_i * t_sq)
    ncc = np.where(denom > _NCC_EPS, numerator / (denom + _NCC_EPS), 0.0)
    ncc[~np.isfinite(ncc)] = 0.0
    return np.clip(ncc, -1.0, 1.0)


def _position_nms(matches: list, radius_px: float) -> list:
    """纯位置非极大值抑制：翻面属性不同的绝不合并。

    按精修分从高到低贪心，落入任一已保留候选 ``radius_px`` 内的即被吸收，
    不考虑角度/缩放差异——用于精修后消掉同一物理标记的多个朝向副本。
    """
    if not matches:
        return []
    ordered = sorted(matches, key=lambda m: m.score, reverse=True)
    r2 = radius_px ** 2
    kept: list = []
    for cand in ordered:
        if any(
            cand.flipped == owner.flipped
            and (cand.x - owner.x) ** 2 + (cand.y - owner.y) ** 2 <= r2
            for owner in kept
        ):
            continue
        kept.append(cand)
    kept.sort(key=lambda m: (m.y, m.x))
    return kept


def _angle_grid(params: SearchParams) -> np.ndarray:
    if params.max_angle <= params.min_angle:
        return np.array([params.min_angle], dtype=np.float64)
    n = max(1, int(math.floor((params.max_angle - params.min_angle) / params.angle_step)))
    return params.min_angle + np.arange(n + 1) * params.angle_step


def _bbox_for(matrix: np.ndarray, template: Template, top_left: tuple[float, float]) -> np.ndarray:
    corners = template_corners(template.width, template.height)
    mapped = warp_corners(matrix, corners)
    return mapped + np.asarray(top_left, dtype=np.float64)


def score_pose(
    image: np.ndarray,
    template: Template,
    center: tuple[float, float],
    angle: float,
    scale: float,
    flip: bool,
    cell_rows: int = 4,
    cell_cols: int = 4,
    canvas_size: int | None = None,
) -> PoseResult:
    """在指定位姿上重新打分，并给出逐网格单元的局部 NCC（遮挡对照）。

    目标裁剪窗以 center 为中心、边长取变换后模板外接框；
    单元按画布均匀切分，掩膜像素不足的单元记 NaN。
    传入与查找时一致的 ``canvas_size`` 可保证中心对齐方式相同。
    """
    warped_bgr, wmask, matrix, size = warp_pose(
        template, angle, scale, flip, canvas_size=canvas_size
    )
    gray = _to_gray(image)
    tpl_gray = _to_gray(warped_bgr)

    u = int(round(center[0] - size / 2.0))
    v = int(round(center[1] - size / 2.0))
    h_img, w_img = gray.shape

    # 精修位姿是亚像素的，整数取整会带来半像素误差。在该位置 ±2px
    # 邻域内选出 NCC 最高的整数偏移 (best_v, best_u)，主分与单元分都
    # 按这个偏移对齐，保证两者描述的是同一个配准。
    full_ncc = masked_ncc_map(gray, tpl_gray, wmask)
    best_score, best_du, best_dv = 0.0, 0, 0
    for dv in range(-2, 3):
        for du in range(-2, 3):
            rr, cc = v + dv, u + du
            if 0 <= rr < full_ncc.shape[0] and 0 <= cc < full_ncc.shape[1]:
                val = float(full_ncc[rr, cc])
                if val > best_score:
                    best_score, best_du, best_dv = val, du, dv
    score = best_score
    u_align, v_align = u + best_du, v + best_dv

    u0, v0 = max(u_align, 0), max(v_align, 0)
    u1, v1 = min(u_align + size, w_img), min(v_align + size, h_img)
    target_crop = image[v0:v1, u0:u1].copy()

    # 逐单元局部 NCC
    m = (wmask > 0).astype(np.float64)
    tpl_f = tpl_gray
    cell = np.full((cell_rows, cell_cols), np.nan, dtype=np.float64)
    for r in range(cell_rows):
        for c in range(cell_cols):
            y0 = r * size // cell_rows
            y1 = (r + 1) * size // cell_rows
            x0 = c * size // cell_cols
            x1 = (c + 1) * size // cell_cols
            sub_m = m[y0:y1, x0:x1]
            n = float(sub_m.sum())
            if n < _MIN_CELL_PIXELS:
                continue
            sub_t = tpl_f[y0:y1, x0:x1]
            # 目标对应区域（越界部分按黑边处理），按最优整数偏移对齐
            sub_i = np.zeros_like(sub_t)
            sy0, sx0 = y0 + v_align, x0 + u_align
            iy0, ix0 = max(sy0, 0), max(sx0, 0)
            iy1, ix1 = min(sy0 + sub_t.shape[0], h_img), min(sx0 + sub_t.shape[1], w_img)
            if iy1 > iy0 and ix1 > ix0:
                sub_i[iy0 - sy0:iy1 - sy0, ix0 - sx0:ix1 - sx0] = gray[iy0:iy1, ix0:ix1]
            t_mean = float((sub_t * sub_m).sum() / n)
            t0 = (sub_t - t_mean) * sub_m
            t_norm = math.sqrt(float((t0 * t0).sum()))
            i_mean = float((sub_i * sub_m).sum() / n)
            i0 = (sub_i - i_mean) * sub_m
            i_norm = math.sqrt(float((i0 * i0).sum()))
            if t_norm > _NCC_EPS and i_norm > _NCC_EPS:
                cell[r, c] = float((t0 * i0).sum() / (t_norm * i_norm))

    return PoseResult(
        warped_template=warped_bgr,
        warped_mask=wmask,
        target_crop=target_crop,
        matrix=matrix,
        score=score,
        cell_scores=cell,
        cell_rows=cell_rows,
        cell_cols=cell_cols,
    )


def _refine_pose(
    ori_fields: np.ndarray,
    image_edges: np.ndarray,
    template: Template,
    center: tuple[float, float],
    angle: float,
    scale: float,
    flip: bool,
    angle_step: float,
    cell_rows: int,
    cell_cols: int,
    canvas_size: int,
    min_angle: float = 0.0,
    max_angle: float = 360.0,
    min_scale: float | None = None,
    max_scale: float | None = None,
) -> tuple[float, float, float, float, float, float, np.ndarray]:
    """方向 chamfer 精修：角度细分 + 缩放细网格 + 小范围位置微调。

    返回 (cx, cy, angle, scale, score, coverage, bbox)。所有位姿在同一个
    ``canvas_size`` 画布上对齐中心。方向 chamfer 峰宽（±3° 内平台 >0.89）、
    对双重插值/模糊/遮挡鲁棒，因此网格可以比灰度 NCC 稀疏很多。

    位置只在粗中心 ±2px 内微调（粗 chamfer 已把中心定位到 1~2px），
    不做跨位置寻峰，避免漂到邻近标记。
    """
    size = canvas_size
    fine_step = angle_step / _REFINE_SUBDIV
    # 方向 chamfer 平台宽，缩放网格步距约 2.5%、覆盖粗缩放 ±10%
    local_scales = scale * np.linspace(0.90, 1.10, 9)
    # 精修缩放同样不得越出用户给定的缩放区间，避免向小缩放漂移产生误报
    if min_scale is not None:
        local_scales = local_scales[local_scales >= min_scale - 1e-9]
    if max_scale is not None:
        local_scales = local_scales[local_scales <= max_scale + 1e-9]
    base_top_left_x = center[0] - size / 2.0
    base_top_left_y = center[1] - size / 2.0
    best = None
    for sc in local_scales:
        for k in range(-_REFINE_HALF_STEPS, _REFINE_HALF_STEPS + 1):
            a = angle + k * fine_step
            # 精修角度也必须落在用户限定的角度区间内
            if a < min_angle - 1e-9 or a > max_angle + 1e-9:
                continue
            warped, wmask, matrix, _ = warp_pose(
                template, a, float(sc), flip, canvas_size=size
            )
            for dy in (-2, -1, 0, 1, 2):
                for dx in (-2, -1, 0, 1, 2):
                    tl = (base_top_left_x + dx, base_top_left_y + dy)
                    main, coverage = oriented_chamfer_score(
                        ori_fields, image_edges, warped, wmask, tl
                    )
                    # 主分为主，反向覆盖作为部分匹配惩罚项
                    val = main * (0.7 + 0.3 * coverage)
                    if best is None or val > best[0]:
                        best = (val, main, coverage, a, float(sc), tl, matrix)

    if best is None:
        # 精修角度全部落在区间外：退回粗位姿
        _, _, matrix0, _ = warp_pose(template, angle, scale, flip, canvas_size=size)
        tlx, tly = base_top_left_x, base_top_left_y
        bbox = _bbox_for(matrix0, template, (tlx, tly))
        return (
            tlx + size / 2.0, tly + size / 2.0,
            angle % 360.0, scale, 0.0, 0.0, bbox,
        )

    val, main, coverage, best_angle, best_scale, (tlx, tly), matrix = best
    cx, cy = tlx + size / 2.0, tly + size / 2.0
    bbox = _bbox_for(matrix, template, (tlx, tly))
    return cx, cy, best_angle, best_scale, main, coverage, bbox


def find_matches(
    template: Template,
    image: np.ndarray,
    params: SearchParams,
) -> list[Match]:
    """两阶段查找。

    1. **粗搜索（chamfer）**：在目标图的边缘距离场上，对旋转×缩放网格
       计算滑窗 chamfer 分数。距离场对位姿的几像素偏差只产生平滑的
       距离变化，因此粗网格（如 10°、5 档缩放）下真标记仍有 0.9+ 的分，
       而不同形状的干扰项明显偏低；
    2. **精修（灰度 NCC）**：对每个粗候选在小邻域内做角度细分 +
       缩放细网格的原图掩膜 NCC，得到准确位姿、最终分数与遮挡单元分，
       再按用户阈值过滤。
    """
    gray = _to_gray(image)
    dist_field = _distance_field(image)
    ori_fields, image_edges = orientation_distance_fields(image)
    angles = _angle_grid(params)
    scales = scale_grid(params.min_scale, params.max_scale, params.num_scales)
    flip_modes = [False, True] if params.allow_flip else [False]
    canvas = (
        params.canvas_size_override
        if params.canvas_size_override
        else fixed_canvas_size(template, float(np.max(scales)))
    )
    # chamfer 粗搜阈值：真标记在量化网格下约 0.9+，反向/不同形状干扰
    # 通常 <0.75；取 0.78 广撒网又能挡掉大部分低分伪峰，朝向与最终误报
    # 再交给精修灰度 NCC、阈值与人工复核裁决。
    coarse_threshold = 0.78

    total = len(flip_modes) * len(scales) * len(angles)
    done = 0
    coarse: list[Match] = []

    for flip in flip_modes:
        for scale in scales:
            for angle in angles:
                done += 1
                if params.progress is not None:
                    params.progress(done, total, f"粗搜 角度 {angle:.0f}° 缩放 {scale:.2f}")
                warped, wmask, matrix, size = warp_pose(
                    template, angle, scale, flip, canvas_size=canvas
                )
                if wmask.sum() == 0:
                    continue
                cmap = chamfer_map(dist_field, warped, wmask)
                min_dist = max(2, size // 8)
                for col, row, val in local_maxima(
                    cmap, coarse_threshold, params.peaks_per_pose, min_dist
                ):
                    sx, sy, sub_val = subpixel_refine(cmap, col, row)
                    top_left = (float(sx), float(sy))
                    cx, cy = sx + size / 2.0, sy + size / 2.0
                    coarse.append(
                        Match(
                            id="",
                            x=float(cx),
                            y=float(cy),
                            angle=float(angle % 360.0),
                            scale=float(scale),
                            flipped=bool(flip),
                            score=float(sub_val),
                            robust_score=float(sub_val),
                            bbox=_bbox_for(matrix, template, top_left),
                            cell_scores=np.full(
                                (params.cell_rows, params.cell_cols), np.nan
                            ),
                            cell_rows=params.cell_rows,
                            cell_cols=params.cell_cols,
                        )
                    )

    # 粗阶段先做纯位置 NMS：同一物理位置在不同角度/缩放下会产生一串
    # chamfer 候选（含反向、邻近角度），只保留 chamfer 分最高的那个进入
    # 精修。正确朝向的候选中心聚拢在真实位置几个像素内，反向/错误角度的
    # 峰中心会漂得更远；半径取 0.55 倍短边可收掉正确簇，同时小于两个真实
    # 标记的间距，贴近的两个标记不会被并掉。翻面候选单独成组。
    coarse_radius = 0.55 * min(template.width, template.height)
    merged = _position_nms(coarse, coarse_radius)
    # 粗候选按 chamfer 分取前 N 个再精修，控制密集精修的耗时
    coarse_cap = max(params.max_matches * 4, 40)
    merged = sorted(merged, key=lambda m: m.score, reverse=True)[:coarse_cap]

    results: list[Match] = []
    for m in merged:
        if params.refine:
            cx, cy, fine_angle, fine_scale, ori_score, coverage, bbox = _refine_pose(
                ori_fields,
                image_edges,
                template,
                (m.x, m.y),
                m.angle,
                m.scale,
                m.flipped,
                params.angle_step,
                params.cell_rows,
                params.cell_cols,
                canvas,
                params.min_angle,
                params.max_angle,
                params.min_scale,
                params.max_scale,
            )
            m.x, m.y = cx, cy
            m.angle = fine_angle % 360.0
            m.scale = fine_scale
            m.bbox = bbox
            # 主分采用方向 chamfer（几何一致 + 朝向判别 + 遮挡鲁棒）；
            # 灰度 NCC 降级为逐单元诊断分，不参与阈值裁决
            if ori_score > 0:
                m.score = ori_score
            m.coverage = coverage
            if not m.note:
                m.note = f"coverage={coverage:.2f}"
        # 逐单元灰度 NCC 仅用于四宫格遮挡对照（缺角/遮挡单元显式偏低）
        pose = score_pose(
            image,
            template,
            (m.x, m.y),
            m.angle,
            m.scale,
            m.flipped,
            params.cell_rows,
            params.cell_cols,
            canvas_size=canvas,
        )
        m.cell_scores = pose.cell_scores
        # robust 用方向 chamfer 截尾均值口径：这里用主分作为稳健基线，
        # cell NCC 仅在 GUI 对照视图里展示，不再写回 robust_score
        m.robust_score = m.score
        results.append(m)

    # 粗阶段已按位置去重，每个物理位置只精修一个候选。这里仅做一次
    # 极保守的收尾去重（半径 0.3 倍短边），合并亚像素级残余重复，
    # 半径远小于真实标记间距，贴近的两个标记一定都保留。
    results = _position_nms(results, 0.3 * min(template.width, template.height))

    # 联合门控：覆盖率过低说明是部分匹配式误报（常见于小缩放偶然对齐）；
    # 但遮挡会同时拉低覆盖率而主分仍高，因此主分足够高（>=0.9）时放宽
    # 覆盖率要求，靠方向 chamfer 的高分保住遮挡标记。
    def _passes_gate(m: Match) -> bool:
        if m.score < params.score_threshold:
            return False
        if m.coverage >= params.coverage_threshold:
            return True
        return m.score >= 0.9 and m.coverage >= 0.15

    results = [m for m in results if _passes_gate(m)]
    results.sort(key=lambda m: m.score, reverse=True)
    results = results[: params.max_matches]
    results.sort(key=lambda m: (m.y, m.x))
    for idx, m in enumerate(results, start=1):
        m.id = f"m{idx:04d}"
    return results
