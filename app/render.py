"""全景画布渲染: 全局变换、曝光补偿、羽化融合。

设计要点
--------
- 匹配链上某一对失败会把序列切成多个"组", 每个组各自拼接, 组合在同一张
  画布上用间隔分开。某张图失败不会让已成功的部分消失。
- 每张图带一个手动平移偏移 (offset_x/offset_y), 叠加在自动估计的变换上,
  调整一张不会改变其它图的自动对齐关系。
- 融合采用按距边界距离生成的羽化权重做加权平均, 羽化宽度可调;
  曝光差异先做自动增益补偿, 每张图的增益也可手动覆盖。
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .stitch import PairResult

GROUP_GAP = 40            # 失败分组之间的画布间隔(全分辨率像素)
GAIN_CLIP = (0.3, 3.0)


@dataclass
class RenderResult:
    bgr: np.ndarray            # 渲染出的画布(BGR, uint8)
    coverage: list[dict]       # 每张图在画布上的覆盖多边形与所属组
    groups: list[dict]         # 每个组在画布上的外接矩形
    gains: dict[str, float]    # 实际使用的每图增益
    group_of: dict[str, int]


def _image_corners(h: int, w: int) -> np.ndarray:
    return np.float32([[0, 0], [w, 0], [w, h], [0, h]]).reshape(-1, 1, 2)


def compute_layout(
    order: list[str],
    shapes: dict[str, tuple[int, int]],
    pairs: list[PairResult],
    offsets: dict[str, tuple[float, float]],
) -> tuple[dict[str, np.ndarray], dict[str, int]]:
    """计算每张图到组公共坐标系的 3x3 变换 M。

    组内第一张为锚点 (M = 平移手动偏移); 后续图沿匹配链累乘单应性。
    匹配失败的相邻对之间断开, 另起新组。
    """
    pair_by_index = {p.index: p for p in pairs}
    transforms: dict[str, np.ndarray] = {}
    group_of: dict[str, int] = {}
    group_id = -1

    for i, image_id in enumerate(order):
        h, w = shapes[image_id]
        ox, oy = offsets.get(image_id, (0.0, 0.0))
        shift = np.array(
            [[1.0, 0.0, ox], [0.0, 1.0, oy], [0.0, 0.0, 1.0]], dtype=np.float64
        )
        if i == 0:
            group_id = 0
            transforms[image_id] = shift
            group_of[image_id] = group_id
            continue

        pair = pair_by_index.get(i - 1)
        prev_id = order[i - 1]
        if pair is not None and pair.ok and pair.homography is not None \
                and group_of.get(prev_id) == group_id:
            # H 把当前图坐标映射到前一张图坐标, 再乘前一张的全局变换
            transforms[image_id] = transforms[prev_id] @ pair.homography @ shift
            group_of[image_id] = group_id
        else:
            # 断链: 另起一组, 自身作为新组锚点
            group_id += 1
            transforms[image_id] = shift
            group_of[image_id] = group_id

    return transforms, group_of


def _warp_corners(corners: np.ndarray, m: np.ndarray) -> np.ndarray:
    return cv2.perspectiveTransform(corners, m).reshape(-1, 2)


def compute_auto_gains(
    order: list[str],
    images: dict[str, np.ndarray],
    transforms: dict[str, np.ndarray],
    group_of: dict[str, int],
    pairs: list[PairResult],
) -> dict[str, float]:
    """在缩小的画布上按重叠区亮度关系, 最小二乘估计每图曝光增益。

    对每个成功匹配的相邻对, 令两张图在重叠区的加权平均亮度满足
    gain_b * mean_b = gain_a * mean_a, 连同锚点增益=1 一起解线性方程组。
    不同组分别求解。
    """
    # 缩小画布, 控制计算量
    max_h = max(images[i].shape[0] for i in order)
    scale = min(1.0, 600.0 / max_h)

    # 收集缩小后的角点, 得到每组画布尺寸
    bounds: dict[int, list[np.ndarray]] = {}
    small_tf: dict[str, np.ndarray] = {}
    scale_mat = np.array(
        [[scale, 0, 0], [0, scale, 0], [0, 0, 1.0]], dtype=np.float64
    )
    for image_id in order:
        h, w = images[image_id].shape[:2]
        m = scale_mat @ transforms[image_id]
        small_tf[image_id] = m
        g = group_of[image_id]
        pts = _warp_corners(_image_corners(h, w), m)
        bounds.setdefault(g, []).append(pts)

    gains: dict[str, float] = {}
    for g, pts_list in bounds.items():
        members = [i for i in order if group_of[i] == g]
        all_pts = np.concatenate(pts_list)
        x_min, y_min = all_pts.min(axis=0)
        x_max, y_max = all_pts.max(axis=0)
        cw = max(1, int(np.ceil(x_max - x_min)) + 1)
        ch = max(1, int(np.ceil(y_max - y_min)) + 1)
        adjust = np.array(
            [[1.0, 0.0, -x_min], [0.0, 1.0, -y_min], [0.0, 0.0, 1.0]],
            dtype=np.float64,
        )

        lum_sum = np.zeros(len(members), np.float64)
        wgt_sum = np.zeros(len(members), np.float64)
        idx = {image_id: k for k, image_id in enumerate(members)}

        # 逐图投影灰度与权重, 统计各图平均亮度
        grays: dict[str, np.ndarray] = {}
        masks: dict[str, np.ndarray] = {}
        for image_id in members:
            bgr = images[image_id]
            gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float64)
            m = adjust @ small_tf[image_id]
            warp_g = cv2.warpPerspective(gray, m, (cw, ch))
            warp_m = cv2.warpPerspective(
                np.ones(gray.shape, np.uint8), m, (cw, ch)
            ).astype(bool)
            grays[image_id] = warp_g
            masks[image_id] = warp_m
            k = idx[image_id]
            lum_sum[k] = warp_g[warp_m].sum()
            wgt_sum[k] = warp_m.sum()

        # 构建方程: 成功相邻对给出 gain_a*mean_a - gain_b*mean_b = 0
        rows: list[np.ndarray] = []
        rhs: list[float] = []
        means = np.divide(
            lum_sum, np.maximum(wgt_sum, 1e-6)
        )
        for p in pairs:
            if not p.ok:
                continue
            a, b = order[p.index], order[p.index + 1]
            if a not in idx or b not in idx:
                continue
            overlap = masks[a] & masks[b]
            if overlap.sum() < 64:
                continue
            ma = grays[a][overlap].mean()
            mb = grays[b][overlap].mean()
            if mb < 1e-3 or ma < 1e-3:
                continue
            row = np.zeros(len(members))
            row[idx[a]] = ma
            row[idx[b]] = -mb
            rows.append(row)
            rhs.append(0.0)

        anchor = members[0]
        row = np.zeros(len(members))
        row[idx[anchor]] = 1.0
        rows.append(row)
        rhs.append(1.0)

        sol, *_ = np.linalg.lstsq(np.stack(rows), np.array(rhs), rcond=None)
        sol = np.clip(sol, *GAIN_CLIP)
        for image_id, k in idx.items():
            gains[image_id] = float(sol[k])

    return gains


def _feather_weight(h: int, w: int, feather_px: float) -> np.ndarray:
    """按像素到图像边界的距离生成 0..1 羽化权重。"""
    ones = np.ones((h, w), np.uint8)
    dist = cv2.distanceTransform(ones, cv2.DIST_L2, 3)
    if feather_px <= 1.0:
        weight = (dist > 0).astype(np.float32)
    else:
        weight = np.clip(dist / float(feather_px), 0.0, 1.0).astype(np.float32)
    return weight


def render_panorama(
    order: list[str],
    images: dict[str, np.ndarray],
    pairs: list[PairResult],
    offsets: dict[str, tuple[float, float]],
    feather_px: float,
    auto_exposure: bool,
    manual_gains: dict[str, float],
    scale: float = 1.0,
) -> RenderResult:
    """渲染整张拼接画布。

    scale<1 时所有坐标与羽化宽度同比缩小, 用于快速预览;
    scale=1 用于全分辨率导出。
    """
    shapes = {i: images[i].shape[:2] for i in order}
    transforms, group_of = compute_layout(order, shapes, pairs, offsets)

    if auto_exposure:
        gains = compute_auto_gains(order, images, transforms, group_of, pairs)
    else:
        gains = {i: 1.0 for i in order}
    for image_id, g in manual_gains.items():
        if image_id in gains:
            gains[image_id] = float(np.clip(g, *GAIN_CLIP))

    # 每组各自的包围盒(缩放到目标渲染分辨率)
    group_rects: dict[int, dict[str, float]] = {}
    scaled_corners: dict[str, np.ndarray] = {}
    scale_mat = np.array(
        [[scale, 0, 0], [0, scale, 0], [0, 0, 1.0]], dtype=np.float64
    )
    for image_id in order:
        h, w = shapes[image_id]
        pts = _warp_corners(_image_corners(h, w), scale_mat @ transforms[image_id])
        scaled_corners[image_id] = pts
        g = group_of[image_id]
        rect = group_rects.get(g)
        x_min, y_min = pts.min(axis=0)
        x_max, y_max = pts.max(axis=0)
        if rect is None:
            group_rects[g] = {
                "x_min": x_min, "y_min": y_min, "x_max": x_max, "y_max": y_max
            }
        else:
            rect["x_min"] = min(rect["x_min"], x_min)
            rect["y_min"] = min(rect["y_min"], y_min)
            rect["x_max"] = max(rect["x_max"], x_max)
            rect["y_max"] = max(rect["y_max"], y_max)

    # 组从左到右排列, 组间留固定间隔
    ordered_groups = sorted(group_rects)
    origin_x = 0
    placements: dict[int, tuple[int, int, int, int]] = {}
    total_w = 0
    total_h = 0
    for n, g in enumerate(ordered_groups):
        rect = group_rects[g]
        cw = int(np.ceil(rect["x_max"] - rect["x_min"])) + 2
        ch = int(np.ceil(rect["y_max"] - rect["y_min"])) + 2
        x0 = int(origin_x)
        y0 = 0
        placements[g] = (x0, y0, cw, ch)
        origin_x = x0 + cw + int(GROUP_GAP * scale)
        total_w = x0 + cw
        total_h = max(total_h, ch)

    canvas = np.zeros((total_h, total_w, 3), np.float64)
    weight_acc = np.zeros((total_h, total_w), np.float64)
    coverage: list[dict] = []

    for image_id in order:
        bgr = images[image_id].astype(np.float64) * gains[image_id]
        h0, w0 = shapes[image_id]
        h = max(1, int(round(h0 * scale)))
        w = max(1, int(round(w0 * scale)))
        if scale != 1.0:
            bgr = cv2.resize(bgr, (w, h), interpolation=cv2.INTER_AREA)
        weight = _feather_weight(h, w, max(1.0, feather_px * scale))

        g = group_of[image_id]
        gx, gy, _, _ = placements[g]
        rect = group_rects[g]
        # 组内平移: 缩放后的组坐标 -> 画布坐标
        local_adjust = np.array(
            [[1.0, 0.0, gx - rect["x_min"]],
             [0.0, 1.0, gy - rect["y_min"]],
             [0.0, 0.0, 1.0]],
            dtype=np.float64,
        )
        m = local_adjust @ scale_mat @ transforms[image_id]

        warped = cv2.warpPerspective(bgr, m, (total_w, total_h))
        warped_w = cv2.warpPerspective(weight, m, (total_w, total_h))

        mask = warped_w > 0
        for c in range(3):
            canvas[..., c] += warped[..., c] * warped_w
        weight_acc += warped_w

        poly = _warp_corners(_image_corners(h, w), m).reshape(-1, 2)
        coverage.append({
            "image_id": image_id,
            "group": g,
            "polygon": [[float(x), float(y)] for x, y in poly],
        })

    valid = weight_acc > 1e-6
    result = np.zeros_like(canvas, dtype=np.uint8)
    for c in range(3):
        channel = np.divide(
            canvas[..., c], weight_acc,
            out=np.zeros_like(weight_acc), where=valid,
        )
        result[..., c] = np.clip(channel, 0, 255).astype(np.uint8)

    groups_out = []
    for g in ordered_groups:
        gx, gy, cw, ch = placements[g]
        groups_out.append({
            "group": g, "x": gx, "y": gy, "width": cw, "height": ch,
        })

    return RenderResult(
        bgr=result, coverage=coverage, groups=groups_out,
        gains=gains, group_of=group_of,
    )
