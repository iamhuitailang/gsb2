"""表格框线检测。

设计要点：
- 横/竖线分别用形态学开运算提取，再对投影峰聚类得到候选线位置；
- 每条候选线按"相邻两条正交线之间的区段"逐段评估墨迹支持率，
  而不是整条线一刀切；
- 短缺口（扫描断线）允许桥接，合并格中本来就没印的边判为 absent，
  判不准的给 uncertain 并列入低可信清单，绝不自动补成实线。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

# 边段状态
PRESENT = "present"        # 有边（可能经过缺口桥接）
ABSENT = "absent"          # 基本无墨迹，视为合并格的无边
UNCERTAIN = "uncertain"    # 有少量墨迹，判不准，交人工确认

HIGH = "high"
MEDIUM = "medium"
LOW = "low"


class DetectionError(RuntimeError):
    """图中找不到可识别的表格框线。"""


@dataclass
class EdgeSeg:
    state: str
    confidence: str
    support: float          # 有效区段内墨迹占比 0~1
    longest_gap: int        # 最长无墨迹连续段（像素）
    bridged: bool = False   # 是否做了缺口桥接
    faint: bool = False     # 是否为浅框线
    stamp_coverage: float = 0.0
    reason: str = ""

    def to_dict(self) -> dict:
        return {
            "state": self.state,
            "confidence": self.confidence,
            "support": round(self.support, 3),
            "longest_gap": self.longest_gap,
            "bridged": self.bridged,
            "faint": self.faint,
            "stamp_coverage": round(self.stamp_coverage, 3),
            "reason": self.reason,
        }


@dataclass
class DetectionResult:
    xs: list[float]                 # 竖线 x 坐标（含外框）
    ys: list[float]                 # 横线 y 坐标（含外框）
    # h_segs[(y 线索引, x 段索引)] = 该横线上的边段
    h_segs: dict[tuple[int, int], EdgeSeg] = field(default_factory=dict)
    # v_segs[(y 段索引, x 线索引)]
    v_segs: dict[tuple[int, int], EdgeSeg] = field(default_factory=dict)
    low_confidence: list[dict] = field(default_factory=list)
    table_bbox: tuple[int, int, int, int] = (0, 0, 0, 0)
    stamp_mask_sum: int = 0

    def to_dict(self) -> dict:
        # 注意：h_segs/v_segs 的键是 tuple，序列化由 GridModel.to_dict 统一
        # 转成 "a,b" 字符串，这里只放可直接 JSON 化的字段
        return {
            "xs": self.xs,
            "ys": self.ys,
            "low_confidence": self.low_confidence,
            "table_bbox": list(self.table_bbox),
        }


def build_stamp_mask(image: np.ndarray) -> np.ndarray:
    """印章掩码：彩色图取偏红区域，灰度图无法判断则返回空。"""
    if image.ndim != 3:
        return np.zeros(image.shape[:2], dtype=np.uint8)
    b, g, r = cv2.split(image)
    mask = ((r.astype(np.int16) - g.astype(np.int16) > 25)
            & (r.astype(np.int16) - b.astype(np.int16) > 25)
            & (r > 90)).astype(np.uint8) * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    mask = cv2.dilate(mask, kernel, iterations=2)
    return mask


def _line_masks(bin_inv: np.ndarray) -> tuple[np.ndarray, np.ndarray, int, int]:
    """提取横/竖线掩码，自动缩短核长重试以兼容断线、浅线。"""
    h, w = bin_inv.shape
    for frac in (28, 45, 70):
        hlen = max(12, w // frac)
        vlen = max(12, h // frac)
        hk = cv2.getStructuringElement(cv2.MORPH_RECT, (hlen, 1))
        vk = cv2.getStructuringElement(cv2.MORPH_RECT, (1, vlen))
        hmask = cv2.morphologyEx(bin_inv, cv2.MORPH_OPEN, hk)
        vmask = cv2.morphologyEx(bin_inv, cv2.MORPH_OPEN, vk)
        if cv2.countNonZero(hmask) > h * 3 and cv2.countNonZero(vmask) > w * 3:
            return hmask, vmask, hlen, vlen
    # 最后兜底：哪怕只有一个方向够多也返回，由上层决定报错
    hk = cv2.getStructuringElement(cv2.MORPH_RECT, (max(10, w // 70), 1))
    vk = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(10, h // 70)))
    return (cv2.morphologyEx(bin_inv, cv2.MORPH_OPEN, hk),
            cv2.morphologyEx(bin_inv, cv2.MORPH_OPEN, vk), 0, 0)


def _cluster_peaks(profile: np.ndarray, min_spacing: int, thresh: float) -> list[int]:
    """对一维投影轮廓找峰：超过阈值的连续区段取加权中心。"""
    above = profile >= thresh
    peaks: list[int] = []
    i = 0
    n = len(profile)
    while i < n:
        if not above[i]:
            i += 1
            continue
        j = i
        while j < n and above[j]:
            j += 1
        seg = profile[i:j]
        center = int(round(np.arange(i, j) @ seg / max(seg.sum(), 1e-6)))
        peaks.append(center)
        i = j
    # 间距过小的峰合并
    merged: list[int] = []
    for p in peaks:
        if merged and p - merged[-1] < min_spacing:
            merged[-1] = (merged[-1] + p) // 2
        else:
            merged.append(p)
    return merged


def _refine_position(profile: np.ndarray, pos: int, radius: int = 4) -> int:
    lo = max(0, pos - radius)
    hi = min(len(profile), pos + radius + 1)
    return lo + int(np.argmax(profile[lo:hi]))


def detect_lines(image: np.ndarray) -> DetectionResult:
    """对拉正后的图检测表格线与逐段边状态。"""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    h, w = gray.shape

    # 两种邻域尺寸的自适应阈值相或，尽量保住浅框线
    b1 = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 31, 12)
    b2 = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 51, 10)
    bin_inv = cv2.bitwise_or(b1, b2)

    stamp = build_stamp_mask(image)
    hmask, vmask, _, _ = _line_masks(bin_inv)
    if cv2.countNonZero(hmask) < h * 2 or cv2.countNonZero(vmask) < w * 2:
        raise DetectionError("未检测到足够的横/竖框线，已标记为待处理")

    union = cv2.bitwise_or(hmask, vmask)
    ys_idx, xs_idx = np.where(union > 0)
    tx0, tx1 = int(xs_idx.min()), int(xs_idx.max())
    ty0, ty1 = int(ys_idx.min()), int(ys_idx.max())
    table_w, table_h = tx1 - tx0, ty1 - ty0

    row_prof = hmask.sum(axis=1) / 255.0
    col_prof = vmask.sum(axis=0) / 255.0
    min_gap = max(10, min(table_w, table_h) // 40)

    h_thresh = max(8.0, table_w * 0.18)
    v_thresh = max(8.0, table_h * 0.18)
    y_cand = [p for p in _cluster_peaks(row_prof, min_gap, h_thresh)
              if ty0 - 5 <= p <= ty1 + 5]
    x_cand = [p for p in _cluster_peaks(col_prof, min_gap, v_thresh)
              if tx0 - 5 <= p <= tx1 + 5]
    if len(y_cand) < 2 or len(x_cand) < 2:
        raise DetectionError("框线候选不足（需要至少两条横线、两条竖线），已标记为待处理")

    y_cand = [_refine_position(row_prof, p) for p in y_cand]
    x_cand = [_refine_position(col_prof, p) for p in x_cand]

    # 外框：覆盖跨度够大的最外两条
    def _span(profile: np.ndarray, pos: int, radius: int = 3) -> int:
        return int(profile[max(0, pos - radius):pos + radius + 1].max())

    strong_h = [p for p in y_cand if _span(row_prof, p) >= table_w * 0.55]
    strong_v = [p for p in x_cand if _span(col_prof, p) >= table_h * 0.55]
    if len(strong_h) < 2 or len(strong_v) < 2:
        raise DetectionError("找不到完整的表格外框，已标记为待处理")
    y_top, y_bot = min(strong_h), max(strong_h)
    x_left, x_right = min(strong_v), max(strong_v)

    ys = sorted([y for y in y_cand if y_top <= y <= y_bot])
    xs = sorted([x for x in x_cand if x_left <= x <= x_right])

    max_gap = max(15, w // 45)
    result = DetectionResult(xs=[float(x) for x in xs], ys=[float(y) for y in ys],
                             table_bbox=(x_left, y_top, x_right, y_bot),
                             stamp_mask_sum=int(stamp.sum() // 255))

    # 横线逐段（段索引 j：xs[j] -> xs[j+1]）
    for iy, y in enumerate(ys):
        for j in range(len(xs) - 1):
            result.h_segs[(iy, j)] = _eval_segment(
                gray, bin_inv, stamp, xs[j], xs[j + 1], y, horizontal=True,
                cross_positions=xs, max_gap=max_gap,
                outer=(iy == 0 or iy == len(ys) - 1))
    # 竖线逐段（段索引 i：ys[i] -> ys[i+1]）
    for i in range(len(ys) - 1):
        for jx, x in enumerate(xs):
            result.v_segs[(i, jx)] = _eval_segment(
                gray, bin_inv, stamp, ys[i], ys[i + 1], x, horizontal=False,
                cross_positions=ys, max_gap=max_gap,
                outer=(jx == 0 or jx == len(xs) - 1))

    result.low_confidence = _collect_low_confidence(result)
    return result


def _eval_segment(gray: np.ndarray, bin_inv: np.ndarray, stamp: np.ndarray,
                  lo: float, hi: float, line_pos: float, horizontal: bool,
                  cross_positions: list[float], max_gap: int,
                  outer: bool) -> EdgeSeg:
    """评估一条边段的墨迹支持情况。"""
    lo_i, hi_i = int(round(lo)), int(round(hi))
    pos = int(round(line_pos))
    half = 2  # 线宽容差
    h, w = gray.shape

    if horizontal:
        lo_i = max(0, lo_i); hi_i = min(w, hi_i)
        r0, r1 = max(0, pos - half), min(h, pos + half + 1)
        strip = bin_inv[r0:r1, lo_i:hi_i]
        ink_any = (strip > 0).any(axis=0)
        stamp_col = (stamp[r0:r1, lo_i:hi_i] > 0).any(axis=0)
        gray_strip = gray[r0:r1, lo_i:hi_i]
    else:
        lo_i = max(0, lo_i); hi_i = min(h, hi_i)
        c0, c1 = max(0, pos - half), min(w, pos + half + 1)
        strip = bin_inv[lo_i:hi_i, c0:c1]
        ink_any = (strip > 0).any(axis=1)
        stamp_col = (stamp[lo_i:hi_i, c0:c1] > 0).any(axis=1)
        gray_strip = gray[lo_i:hi_i, c0:c1]

    n = len(ink_any)
    # 交点附近（正交线 ±4px）与印章覆盖区都不计入墨迹分母：
    # 红圈暗部会被自适应阈值当成黑墨，但它不是框线
    cross = np.zeros(n, dtype=bool)
    for k in range(n):
        global_coord = lo_i + k
        if any(abs(global_coord - cp) <= 4 for cp in cross_positions):
            cross[k] = True
    stamped = stamp_col & ~cross
    valid = ~cross & ~stamp_col
    n_valid = int(valid.sum())
    stamp_cov = float(stamped.sum()) / max(n - int(cross.sum()), 1)
    if n_valid < 6:
        return EdgeSeg(UNCERTAIN, LOW, 0.0, 0, stamp_coverage=stamp_cov,
                       reason="有效区段过短（多为印章/交点覆盖），无法判断")

    ink_valid = ink_any & valid
    support = float(ink_valid.sum()) / n_valid

    # 游程分析（只看有效列）：同时统计最长墨迹游程与最长缺口。
    # 关键：合并格内边在本段本应无墨，即便邻段有共线竖线，也不会在本段
    # 形成长连续墨迹，因此用"最长墨迹游程/有效长度"区分真线与跨段接续。
    longest_gap = 0
    longest_ink_run = 0
    cur_gap = 0
    cur_ink = 0
    end_ink = [False, False]
    valid_idx = np.where(valid)[0]
    for rank, k in enumerate(valid_idx):
        if ink_any[k]:
            cur_ink += 1
            cur_gap = 0
            longest_ink_run = max(longest_ink_run, cur_ink)
        else:
            cur_gap += 1
            cur_ink = 0
            longest_gap = max(longest_gap, cur_gap)
        if rank == 0:
            end_ink[0] = bool(ink_any[k])
        if rank == len(valid_idx) - 1:
            end_ink[1] = bool(ink_any[k])
    run_ratio = longest_ink_run / max(n_valid, 1)

    # 浅线判定：墨迹处的平均灰度偏高（对比弱）
    if ink_valid.any():
        # ink_any 沿条带长度方向，横向条带形状为 (行, 列)，竖向为 (行, 列)
        along = ink_any.reshape((1, -1) if horizontal else (-1, 1))
        faint_mean = float(
            gray_strip[np.broadcast_to(along, gray_strip.shape)].mean())
    else:
        faint_mean = 255.0
    faint = faint_mean > 165

    seg = EdgeSeg(UNCERTAIN, LOW, support, longest_gap,
                  faint=faint, stamp_coverage=stamp_cov)

    # 真线需要"高支持率"且"长连续墨迹"；只有高支持率但游程短，
    # 多为邻段共线残片或文字，不足以在本段判线。
    if support >= 0.72 and run_ratio >= 0.55:
        seg.state = PRESENT
        seg.confidence = MEDIUM if faint else HIGH
        seg.reason = "连续框线" + ("（偏浅）" if faint else "")
    elif (support >= 0.42 and run_ratio >= 0.4
          and longest_gap <= max_gap and all(end_ink)):
        seg.state = PRESENT
        seg.bridged = True
        seg.confidence = MEDIUM
        seg.reason = f"两端有墨、最大缺口 {longest_gap}px 已桥接"
    elif support < 0.12:
        # 几乎完全没印：合并格的无边。外框上的缺失改判 uncertain
        if outer:
            seg.state = UNCERTAIN
            seg.confidence = LOW
            seg.reason = "外框区段无墨迹，可能是扫描缺失，需人工确认"
        else:
            seg.state = ABSENT
            seg.confidence = MEDIUM
            seg.reason = "无框线墨迹，按合并格无边处理（不自动补线）"
    else:
        seg.state = UNCERTAIN
        seg.confidence = LOW
        seg.reason = (f"墨迹支持率 {support:.0%}、最长连续游程占比 "
                      f"{run_ratio:.0%}、最大缺口 {longest_gap}px，"
                      "不足以判线也不足以判无，需人工确认")
    if stamp_cov > 0.05:
        seg.reason += f"；印章遮挡 {stamp_cov:.0%}"
        if seg.state == PRESENT and seg.confidence == HIGH:
            seg.confidence = MEDIUM
        # 遮挡比例高且本身墨迹不足：印章可能盖住真线，不能武断判无边
        if stamp_cov >= 0.25 and seg.state == ABSENT:
            seg.state = UNCERTAIN
            seg.confidence = LOW
            seg.reason = "印章大面积遮挡且其余位置无墨迹，可能压线，需人工确认"
    return seg


def _collect_low_confidence(res: DetectionResult) -> list[dict]:
    items: list[dict] = []
    for (iy, j), seg in res.h_segs.items():
        if seg.confidence == LOW or seg.state == UNCERTAIN:
            items.append({"orientation": "h", "line": iy, "seg": j,
                          **seg.to_dict()})
    for (i, jx), seg in res.v_segs.items():
        if seg.confidence == LOW or seg.state == UNCERTAIN:
            items.append({"orientation": "v", "line": jx, "seg": i,
                          **seg.to_dict()})
    return items
