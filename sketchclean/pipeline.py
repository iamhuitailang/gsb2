"""纸面草稿清理核心管线。

设计要点（对应需求）：

* 背景校正采用「低分辨率估计平滑纸张亮度场 + 比值平场校正」。亮度场是
  连续平滑的，因此明暗过渡不会产生粗黑边；校正按 *局部比值* 进行，
  浅铅笔线（与纸面差异小）和大块实黑（与纸面差异大）都按各自比例保留。
* 不做二值化，输出保持连续灰阶，浅线不会被阈值吃掉。
* 去点只作用于「面积小于阈值的暗连通块」，并做软融合，不会切断正常线条。
* 同一份 :class:`ProcessParams`（归一化坐标 + 相对尺度）在预览分辨率和
  原尺寸上跑同一段代码，保证处理含义一致。
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .params import ProcessParams, Region

# 背景场估计的工作分辨率（长边），足够捕捉缓慢阴影且计算很快。
_BG_WORK_DIM = 480


@dataclass
class ProcessResult:
    cleaned: np.ndarray          # uint8 灰度，清理结果（ROI 内）
    background: np.ndarray       # uint8，估计出的纸张亮度场（同尺寸）
    paper_mask: np.ndarray       # bool，背景估计时认定的「纸」像素
    small_dot_mask: np.ndarray   # bool，检查视图：被判为小点的连通块
    break_mask: np.ndarray       # bool，检查视图：疑似连线断裂处
    shadow_mask: np.ndarray      # bool，检查视图：阴影残留处
    roi_px: tuple[int, int, int, int]  # 在原图中的 (x0, y0, x1, y1)
    original: np.ndarray         # uint8，ROI 内原图灰度（原图永不修改）
    meta: dict


# ---------------------------------------------------------------- 读取

def read_gray(path: str) -> np.ndarray:
    """读图并转灰度。彩色图按 Rec.709 亮度公式转换。无法读取时抛异常。"""
    from PIL import Image

    with Image.open(path) as im:
        im.load()
        if im.mode in ("RGB", "L"):
            arr = np.asarray(im)
        else:
            arr = np.asarray(im.convert("RGB"))
    return to_gray(arr)


def to_gray(arr: np.ndarray) -> np.ndarray:
    if arr.ndim == 2:
        return arr.astype(np.uint8, copy=False)
    # Rec.709 luma
    f = arr.astype(np.float32)
    g = 0.2126 * f[..., 0] + 0.7152 * f[..., 1] + 0.0722 * f[..., 2]
    return np.clip(g, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------- 几何

def roi_to_pixels(shape: tuple[int, int],
                  roi: tuple[float, float, float, float] | None
                  ) -> tuple[int, int, int, int]:
    h, w = shape
    if roi is None:
        return 0, 0, w, h
    x0, y0, x1, y1 = roi
    x0, x1 = sorted((max(0.0, min(1.0, x0)), max(0.0, min(1.0, x1))))
    y0, y1 = sorted((max(0.0, min(1.0, y0)), max(0.0, min(1.0, y1))))
    px = (int(round(x0 * w)), int(round(y0 * h)),
          max(1, int(round(x1 * w))), max(1, int(round(y1 * h))))
    return px


def _polygon_mask(shape: tuple[int, int],
                  points: list[tuple[float, float]]) -> np.ndarray:
    h, w = shape
    mask = np.zeros((h, w), np.uint8)
    if len(points) >= 3:
        pts = np.array([[(x * w, y * h) for x, y in points]], np.int32)
        cv2.fillPoly(mask, pts, 1)
    return mask.astype(bool)


# ---------------------------------------------------------------- 背景场

def _fit_illumination_surface(low: np.ndarray,
                              paper_mask: np.ndarray) -> np.ndarray:
    """对纸面像素稳健拟合二次照明曲面（归一化坐标，数值稳定）。

    缓慢照明阴影是低频现象，低阶曲面天然能外推到贴边的大片暗角，
    这是 inpaint / 形态学闭运算做不到的（它们传播距离有限）。
    做两轮截尾重拟合，避免少量漏网暗像素把曲面拉偏。
    """
    lh, lw = low.shape
    yy, xx = np.mgrid[0:lh, 0:lw].astype(np.float32)
    xn, yn = xx / lw, yy / lh
    basis = np.stack(
        [np.ones_like(xn), xn, yn, xn * yn, xn * xn, yn * yn], axis=-1
    )  # H x W x 6
    ys, xs = np.nonzero(paper_mask)
    A = basis[ys, xs]
    b = low[ys, xs]
    coef, *_ = np.linalg.lstsq(A, b, rcond=None)
    for _ in range(2):  # 截尾重拟合
        resid = b - A @ coef
        keep = np.abs(resid - np.median(resid)) <= 2.0 * resid.std()
        if keep.sum() < len(b) // 4:
            break
        coef, *_ = np.linalg.lstsq(A[keep], b[keep], rcond=None)
    return basis @ coef


def estimate_background(gray: np.ndarray, p: ProcessParams) -> tuple[np.ndarray, np.ndarray]:
    """估计平滑的纸张亮度场 B。

    返回 (B_full[uint8], paper_mask[bool])，尺寸与输入相同。

    两层模型：
      1. 稳健二次曲面对纸面像素拟合，捕捉缓慢照明（含贴边大暗角），
         并能向无纸/实黑区域外推；
      2. 拟合残差（纸纹级起伏与未建模的中尺度阴影）做加权重模糊补回。
    全程没有任何硬边，平场校正因此不会产生黑边/晕圈；笔画和实黑块
    不参与拟合，其亮度按局部比值原样保留。
    """
    h, w = gray.shape
    scale = _BG_WORK_DIM / max(h, w)
    lw, lh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    low = cv2.resize(gray, (lw, lh), interpolation=cv2.INTER_AREA).astype(np.float32)

    coarse = float(np.quantile(low, 0.95))
    paper_mask_low = low >= (coarse * p.paper_quantile)
    # 大块实黑保护：面积超过 solid_block_size（短边比例的平方）的暗连通块
    # 强制排除出纸面掩膜，绝不参与照明拟合，避免把实黑当阴影摊平。
    min_solid = (p.solid_block_size * min(lw, lh)) ** 2
    dark_n, dark_labels, dark_stats, _ = cv2.connectedComponentsWithStats(
        (~paper_mask_low).astype(np.uint8), connectivity=8)
    for lab in range(1, dark_n):
        if dark_stats[lab, cv2.CC_STAT_AREA] >= min_solid:
            paper_mask_low[dark_labels == lab] = False
    # 极端欠曝时兜底，避免掩膜清空。
    if paper_mask_low.sum() < max(16, lw * lh // 50):
        paper_mask_low = low >= np.quantile(low, 0.5)

    surface = _fit_illumination_surface(low, paper_mask_low)
    # 残差只在纸面可信；非纸面位置按纸面残差的加权均值填入，再整体平滑。
    sigma = max(2.0, p.background_scale * min(lw, lh))
    resid = low - surface
    resid_sum = cv2.GaussianBlur(
        np.where(paper_mask_low, resid, 0.0), (0, 0), sigma)
    weight = cv2.GaussianBlur(
        paper_mask_low.astype(np.float32), (0, 0), sigma)
    resid_fill = resid_sum / np.maximum(weight, 1e-3)
    field = surface + resid_fill
    field = cv2.GaussianBlur(field, (0, 0), sigmaX=sigma * 0.5, sigmaY=sigma * 0.5)
    field = np.clip(field, 1.0, 255.0)

    b_full = cv2.resize(field, (w, h), interpolation=cv2.INTER_LINEAR)
    paper_mask = cv2.resize(
        paper_mask_low.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST
    ).astype(bool)
    return np.clip(b_full, 1, 255).astype(np.uint8), paper_mask



# ---------------------------------------------------------------- 校正

def flat_field_correct(gray: np.ndarray, background: np.ndarray,
                       white_target: float) -> np.ndarray:
    """比值平场校正：C = gray * white_target / B。

    纸面（gray≈B）被拉到 white_target；任意笔画按 *与本地纸面的比值*
    等比保留，浅线与实黑都不会被压扁。B 平滑 ⇒ 无硬边。
    """
    b = np.maximum(background.astype(np.float32), 1.0)
    c = gray.astype(np.float32) * (float(white_target) / b)
    return np.clip(c, 0, 255).astype(np.uint8)


def apply_gamma(img: np.ndarray, gamma: float) -> np.ndarray:
    if abs(gamma - 1.0) < 1e-3:
        return img.copy()
    f = img.astype(np.float32) / 255.0
    return np.clip(255.0 * np.power(f, gamma), 0, 255).astype(np.uint8)


# ---------------------------------------------------------------- 去点

def _area_threshold(short_side: int, p: ProcessParams) -> float:
    # despeckle_size 以 1080p 短边为基准，按短边线性缩放（不是平方），
    # 保证不同分辨率下「噪点 vs 线条」的判定含义一致。
    return float(p.despeckle_size) * (short_side / 1080.0)


def find_small_dots(cleaned: np.ndarray, p: ProcessParams,
                    ink_threshold: int | None = None
                    ) -> tuple[np.ndarray, list[dict]]:
    """找出「小而近圆」的暗连通块（噪点）。返回 (mask, 组件信息列表)。

    双重判据，避免误伤浅铅笔线：
      * 面积小于阈值（按短边等比缩放）；
      * 填充率 area / 外接框面积 >= 0.45——线条外接框细长、填充率低，
        而传感器噪点/墨点接近一团。
    """
    h, w = cleaned.shape
    t = p.ink_threshold if ink_threshold is None else ink_threshold
    dark = (cleaned < t).astype(np.uint8)
    n, labels, stats, cents = cv2.connectedComponentsWithStats(dark, connectivity=8)
    min_area = _area_threshold(min(h, w), p)
    mask = np.zeros((h, w), bool)
    infos: list[dict] = []
    for lab in range(1, n):
        area = int(stats[lab, cv2.CC_STAT_AREA])
        bw = max(1, int(stats[lab, cv2.CC_STAT_WIDTH]))
        bh = max(1, int(stats[lab, cv2.CC_STAT_HEIGHT]))
        fill_ratio = area / float(bw * bh)
        if area < min_area and fill_ratio >= 0.45:
            mask[labels == lab] = True
            infos.append({
                "area": area,
                "x": float(cents[lab][0] / w),
                "y": float(cents[lab][1] / h),
            })
    return mask, infos


def soft_despeckle(cleaned: np.ndarray, dot_mask: np.ndarray,
                   strength: float, target: float | np.ndarray) -> np.ndarray:
    """把小点向「本地纸面亮度」软融合。

    target 传数组时逐像素取本地背景（残留暗角里不会被抹成刺眼白点）；
    传标量时退化为固定目标，供区域单独调整使用。
    """
    if not dot_mask.any():
        return cleaned.copy()
    out = cleaned.astype(np.float32)
    s = float(np.clip(strength, 0.0, 1.0))
    t = np.full_like(out, float(target)) if np.ndim(target) == 0 \
        else target.astype(np.float32)
    out[dot_mask] = out[dot_mask] * (1.0 - s) + t[dot_mask] * s
    return np.clip(out, 0, 255).astype(np.uint8)


def local_paper_level(img: np.ndarray, p: ProcessParams) -> np.ndarray:
    """估计校正后图像里每个位置的本地纸面亮度（只取亮像素的重模糊均值）。

    本地纸面是低频量，放到小工作分辨率上模糊再放大，与全图大核模糊
    等价但快一个数量级。
    """
    h, w = img.shape
    scale = _BG_WORK_DIM / max(h, w)
    lw, lh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    low = cv2.resize(img, (lw, lh), interpolation=cv2.INTER_AREA).astype(np.float32)
    sigma = max(2.0, p.background_scale * 2.2 * min(lw, lh))
    bright = low >= p.ink_threshold
    num = cv2.GaussianBlur(np.where(bright, low, 0.0), (0, 0), sigma)
    den = cv2.GaussianBlur(bright.astype(np.float32), (0, 0), sigma)
    level = num / np.maximum(den, 1e-3)
    fallback = cv2.GaussianBlur(low, (0, 0), sigma)
    low_level = np.where(den > 1e-3, level, fallback)
    return cv2.resize(low_level, (w, h), interpolation=cv2.INTER_LINEAR)


# ---------------------------------------------------------------- 检查视图

def detect_breaks(cleaned: np.ndarray, p: ProcessParams) -> np.ndarray:
    """疑似连线断裂：两个暗连通块在很短距离内相邻、中间被亮缝隔开。

    流程：
      1. 8 连通找组件；用 4 连通重标 + 邻接关系识别「实体接触」的
         4 连通块对——折线尖角在 8 连通下相连、在 4 连通下分家，
         这类组件对不算断裂；
      2. 对剩余的邻近小组件对，在二者之间用形态学定位窄亮缝并标注。
    只做启发式标注，不自动修补。
    """
    h, w = cleaned.shape
    dark = (cleaned < p.ink_threshold).astype(np.uint8)
    n, labels, stats, cents = cv2.connectedComponentsWithStats(dark, connectivity=8)
    if n <= 2:
        return np.zeros((h, w), bool)

    # 巨型组件（粗主线团、实黑块）不参与断裂配对；阈值取图像面积的 1.5%，
    # 普通线段（哪怕很长）面积远低于此，不会被误排除。
    areas = stats[:, cv2.CC_STAT_AREA]
    giant = 0.015 * h * w
    gap = max(2, int(round(p.break_distance * min(h, w))))

    # 4 连通邻接：互相 8 连通接触的 4 连通块（尖角/角点）。
    _, labels4 = cv2.connectedComponents(dark, connectivity=4)
    labels4 = labels4.astype(np.int16)  # OpenCV5 形态学不接受 int32
    dil4 = cv2.dilate(labels4, np.ones((3, 3), np.uint8))
    edge = (labels4 > 0) & (dil4 != labels4)
    touch_pairs = {
        frozenset((int(a), int(b)))
        for a, b in zip(labels4[edge], dil4[edge]) if a and b
    }
    # 8 连通组件 -> 它包含的 4 连通块集合（一次性建立，避免逐对全图索引）。
    comp_blocks: dict[int, set[int]] = {}
    cy, cx = np.nonzero(dark)
    for c8, c4 in zip(labels[cy, cx], labels4[cy, cx]):
        comp_blocks.setdefault(int(c8), set()).add(int(c4))

    # 候选组件：非巨型。配对不用质心距离粗筛（长线断口两端质心可以很远），
    # 先做包围盒邻近性筛选，真正的「靠近」交给后面的邻域膨胀判定。
    cand = [i for i in range(1, n) if areas[i] < giant]
    marked = np.zeros((h, w), np.uint8)
    pad_gap = gap + 2
    for ii, a in enumerate(cand):
        ax0, ay0 = stats[a, 0], stats[a, 1]
        ax1, ay1 = ax0 + stats[a, 2], ay0 + stats[a, 3]
        for b in cand[ii + 1:]:
            bx0, by0 = stats[b, 0], stats[b, 1]
            bx1, by1 = bx0 + stats[b, 2], by0 + stats[b, 3]
            # 标准包围盒间隙：任一轴上的最小间距超过缝宽量级，
            # 就不可能是同一处断口（间隙为负表示重叠，继续检查）。
            gap_x = max(ax0, bx0) - min(ax1, bx1)
            gap_y = max(ay0, by0) - min(ay1, by1)
            if max(gap_x, gap_y) > pad_gap:
                continue
            # 实体接触（尖角）排除：两组件的 4 连通块之间有邻接关系。
            blocks_a = comp_blocks.get(int(a), set())
            blocks_b = comp_blocks.get(int(b), set())
            if any(frozenset((x, y)) in touch_pairs
                   for x in blocks_a for y in blocks_b):
                continue
            # 在两组件包围盒并集内找窄缝：膨胀后被暗区覆盖的亮像素。
            x0 = max(0, int(min(ax0, bx0)) - gap - 1)
            y0 = max(0, int(min(ay0, by0)) - gap - 1)
            x1 = min(w, int(max(ax1, bx1)) + gap + 1)
            y1 = min(h, int(max(ay1, by1)) + gap + 1)
            sub_dark = dark[y0:y1, x0:x1]
            sub_lab = labels[y0:y1, x0:x1]
            covered = cv2.dilate(sub_dark, np.ones((3, 3), np.uint8))
            between = covered.astype(bool) & (sub_dark == 0) & \
                np.isin(sub_lab, (0, a, b))
            # 缝必须同时邻近两个组件。
            near_a = cv2.dilate((sub_lab == a).astype(np.uint8),
                                np.ones((2 * gap + 1, 2 * gap + 1), np.uint8))
            near_b = cv2.dilate((sub_lab == b).astype(np.uint8),
                                np.ones((2 * gap + 1, 2 * gap + 1), np.uint8))
            seam = between & (near_a > 0) & (near_b > 0)
            sub_out = marked[y0:y1, x0:x1]
            sub_out[seam] = 1

    if not marked.any():
        return marked.astype(bool)
    return cv2.dilate(marked, np.ones((3, 3), np.uint8)).astype(bool)


def detect_shadow(original: np.ndarray, background: np.ndarray,
                  p: ProcessParams) -> np.ndarray:
    """阴影残留：估计出的背景场显著低于整张纸亮部水平的位置。

    缓慢阴影会让背景场在一大片区域整体偏低；用「背景场高亮度分位数 -
    本地背景」的差值图来定位。线上（原图本身很暗）不标注，避免把
    正常笔画误报成阴影。
    """
    paper_bright = float(np.quantile(background, 0.95))
    residual = (paper_bright - background.astype(np.float32)) > p.shadow_residual
    not_ink = original >= p.ink_threshold
    return residual & not_ink


# ---------------------------------------------------------------- 区域

def _apply_regions(cleaned: np.ndarray, corrected: np.ndarray, original: np.ndarray,
                   dot_mask: np.ndarray, p: ProcessParams) -> np.ndarray:
    out = cleaned.copy()
    for region in p.regions:
        m = _polygon_mask(out.shape, region.points)
        if not m.any():
            continue
        if region.mode == "exclude":
            # 排除：完全保留原图，不做校正/去点。
            out[m] = original[m]
        else:
            # 单独调整：在平场校正结果上重施本区域 gamma / 白点。
            local = apply_gamma(corrected, region.gamma)
            wt = float(np.clip(region.white_target, 180.0, 255.0))
            if abs(wt - p.white_target) > 1e-3:
                local = np.clip(local.astype(np.float32) * (wt / p.white_target),
                                0, 255).astype(np.uint8)
            if region.despeckle_size > 0:
                sub_params = ProcessParams(**{**p.to_dict(),
                                              "despeckle_size": region.despeckle_size})
                sub_mask, _ = find_small_dots(local, sub_params)
                local = soft_despeckle(local, sub_mask, p.despeckle_strength, wt)
            out[m] = local[m]
    return out


# ---------------------------------------------------------------- 主入口

def process_array(gray: np.ndarray, p: ProcessParams) -> ProcessResult:
    """对灰度图执行完整管线。原图数组不会被修改。"""
    gray = np.ascontiguousarray(gray)
    x0, y0, x1, y1 = roi_to_pixels(gray.shape, p.roi)
    crop = gray[y0:y1, x0:x1].copy()

    background, paper_mask = estimate_background(crop, p)
    corrected = flat_field_correct(crop, background, p.white_target)
    toned = apply_gamma(corrected, p.gamma)

    exclude_mask = np.zeros(crop.shape, bool)
    for region in p.regions:
        if region.mode == "exclude":
            exclude_mask |= _polygon_mask(crop.shape, region.points)

    if p.despeckle:
        dot_mask, dot_infos = find_small_dots(toned, p)
        dot_mask &= ~exclude_mask
        cleaned = soft_despeckle(toned, dot_mask, p.despeckle_strength,
                                 local_paper_level(toned, p))
    else:
        dot_mask = np.zeros(crop.shape, bool)
        dot_infos = []
        cleaned = toned

    cleaned = _apply_regions(cleaned, corrected, crop, dot_mask, p)
    break_mask = detect_breaks(cleaned, p)
    shadow_mask = detect_shadow(crop, background, p)

    return ProcessResult(
        cleaned=cleaned,
        background=background,
        paper_mask=paper_mask,
        small_dot_mask=dot_mask,
        break_mask=break_mask,
        shadow_mask=shadow_mask,
        roi_px=(x0, y0, x1, y1),
        original=crop,
        meta={"dots": dot_infos,
              "short_side": min(crop.shape),
              "area_threshold": _area_threshold(min(crop.shape), p)},
    )


def process_file(path: str, p: ProcessParams,
                 max_dim: int | None = None) -> tuple[ProcessResult, np.ndarray]:
    """读图处理。max_dim 给定时等比缩小后处理（预览用），返回 (结果, 缩放后原图)。"""
    gray = read_gray(path)
    if max_dim is not None and max(gray.shape) > max_dim:
        scale = max_dim / max(gray.shape)
        gray = cv2.resize(
            gray,
            (max(1, int(round(gray.shape[1] * scale))),
             max(1, int(round(gray.shape[0] * scale)))),
            interpolation=cv2.INTER_AREA,
        )
    return process_array(gray, p), gray


# ---------------------------------------------------------------- 辅助输出

def histogram(gray: np.ndarray) -> np.ndarray:
    """256 桶亮度直方图，返回计数数组。"""
    return cv2.calcHist([gray], [0], None, [256], [0, 256]).flatten().astype(np.int64)


def overlay_issues(cleaned: np.ndarray, masks: dict[str, np.ndarray],
                   alpha: float = 0.45) -> np.ndarray:
    """把检查掩膜叠成彩色 BGR 图：断裂=红，小点=橙，阴影残留=蓝。"""
    rgb = cv2.cvtColor(cleaned, cv2.COLOR_GRAY2BGR)
    colors = {"breaks": (50, 50, 230), "dots": (40, 160, 240),
              "shadow": (220, 120, 30)}
    for name, mask in masks.items():
        if mask is None or not mask.any():
            continue
        color = np.array(colors[name], np.float32)
        layer = np.full_like(rgb, color)
        m = mask[..., None]
        rgb = np.where(m, cv2.addWeighted(rgb, 1 - alpha, layer, alpha, 0), rgb)
    return rgb
