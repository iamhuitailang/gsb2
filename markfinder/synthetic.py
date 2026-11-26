"""合成验证图片：自己绘制的形状 + 真值标注，用于计算数量与查准/查全。

数据集内容：
- ``template/`` 下是干净形状模板（带 alpha 掩膜）；
- ``sheets/`` 下是若干张“一包图”，标记被随机旋转/缩放，
  部分缺角遮挡、部分刻意翻面，另有不同形状的干扰项；
- ``ground_truth.json`` 记录每个标记的位置、角度、缩放、是否翻面、是否遮挡；
- ``manifest.json`` 给出各图数量汇总，可直接核对计数能力。
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import cv2
import numpy as np

from .geometry import angle_diff
from .matching import SearchParams, find_matches, warp_pose
from .template import Template, save_template

MARK_COLOR = (190, 90, 30)       # BGR 深蓝
DISTRACTOR_COLOR = (40, 130, 90)
BG_MEAN = 232


# ---------------------------------------------------------------- 形状绘制
def _polygon_points(kind: str, size: int) -> np.ndarray:
    """在 size×size 画布内返回形状轮廓点（居中）。"""
    c = size / 2.0
    r = size * 0.42
    if kind == "star":
        pts = []
        for i in range(10):
            ang = -math.pi / 2 + i * math.pi / 5
            rad = r if i % 2 == 0 else r * 0.45
            pts.append([c + rad * math.cos(ang), c + rad * math.sin(ang)])
        return np.array(pts, np.int32)
    if kind == "hex":
        pts = []
        for i in range(6):
            ang = -math.pi / 2 + i * math.pi / 3
            pts.append([c + r * math.cos(ang), c + r * math.sin(ang)])
        return np.array(pts, np.int32)
    raise ValueError(f"未知形状: {kind}")


def render_shape(kind: str, size: int = 96, color: tuple[int, int, int] = MARK_COLOR) -> Template:
    """把自绘形状渲染成带掩膜的模板（形状外为透明背景）。"""
    img = np.zeros((size, size, 3), np.uint8)
    mask = np.zeros((size, size), np.uint8)
    if kind == "arrow":
        # 箭头：粗箭杆 + 三角箭头，朝上
        shaft_w = max(6, size // 8)
        head_w = size // 2
        head_h = size // 3
        cx = size // 2
        cv2.rectangle(
            mask,
            (cx - shaft_w // 2, size // 4),
            (cx + shaft_w // 2, size - size // 8),
            255, -1,
        )
        head = np.array(
            [
                [cx - head_w // 2, size // 4 + head_h // 3],
                [cx + head_w // 2, size // 4 + head_h // 3],
                [cx, size // 4 - head_h // 2],
            ],
            np.int32,
        )
        cv2.fillPoly(mask, [head], 255)
    elif kind == "cross":
        t = max(8, size // 5)
        cv2.rectangle(mask, (size // 2 - t // 2, size // 8), (size // 2 + t // 2, size - size // 8), 255, -1)
        cv2.rectangle(mask, (size // 8, size // 2 - t // 2), (size - size // 8, size // 2 + t // 2), 255, -1)
    elif kind == "asym":
        # 强非对称形状：竖直主干 + 底部仅向右伸出的长横臂 + 顶部仅向左的短钩，
        # 左右两侧结构明显不同，水平翻面后边缘方向分布差异大，外观上可观测，
        # 用于翻面裁决测试（对称的箭头/十字翻面物理上不可分）。
        t = max(8, size // 6)
        x0 = size // 4
        # 竖直主干（偏左）
        cv2.rectangle(mask, (x0, size // 8), (x0 + t, size - size // 8), 255, -1)
        # 底部仅向右的长横臂
        cv2.rectangle(mask, (x0, size - size // 8 - t),
                      (x0 + size * 2 // 3, size - size // 8), 255, -1)
        # 顶部仅向左的短钩
        cv2.rectangle(mask, (x0 - size // 4, size // 8),
                      (x0 + t, size // 8 + t), 255, -1)
    else:
        cv2.fillPoly(mask, [_polygon_points(kind, size)], 255)
    img[mask > 0] = color
    tpl = Template(image=img, mask=mask).cropped()
    return tpl


# ---------------------------------------------------------------- 场景合成
def _make_background(w: int, h: int, rng: np.random.Generator) -> np.ndarray:
    bg = np.full((h, w, 3), BG_MEAN, np.float32)
    noise = rng.normal(0, 5.0, (h, w, 1))
    bg = np.clip(bg + noise, 0, 255).astype(np.uint8)
    # 淡淡的大色块，模拟纸面不均
    overlay = bg.copy()
    cv2.circle(overlay, (int(w * 0.2), int(h * 0.3)), int(min(w, h) * 0.3), (215, 215, 215), -1)
    cv2.circle(overlay, (int(w * 0.85), int(h * 0.8)), int(min(w, h) * 0.25), (245, 245, 245), -1)
    return cv2.addWeighted(overlay, 0.35, bg, 0.65, 0)


def _composite(scene: np.ndarray, warped: np.ndarray, wmask: np.ndarray, top: int, left: int) -> None:
    h, w = scene.shape[:2]
    sh, sw = warped.shape[:2]
    x0, y0 = max(left, 0), max(top, 0)
    x1, y1 = min(left + sw, w), min(top + sh, h)
    if x1 <= x0 or y1 <= y0:
        return
    sub = scene[y0:y1, x0:x1]
    m = wmask[y0 - top:y1 - top, x0 - left:x1 - left] > 0
    sub[m] = warped[y0 - top:y1 - top, x0 - left:x1 - left][m]


def _add_occlusion(scene: np.ndarray, center: tuple[float, float], radius: int, rng: np.random.Generator) -> None:
    """在标记边缘盖一块背景色遮挡，约占一角。"""
    cx, cy = center
    dx = rng.uniform(-radius * 0.6, radius * 0.6)
    dy = rng.uniform(-radius * 0.6, radius * 0.6)
    cv2.circle(
        scene,
        (int(cx + dx), int(cy + dy)),
        int(radius * rng.uniform(0.45, 0.6)),
        (BG_MEAN, BG_MEAN, BG_MEAN),
        -1,
    )


def _sample_positions(
    rng: np.random.Generator,
    count: int,
    w: int,
    h: int,
    margin: int,
    min_dist: float,
    fixed_pairs: int = 0,
) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    # 先放固定的“贴近但不合并”标记对
    for _ in range(fixed_pairs):
        for attempt in range(500):
            cx = rng.uniform(margin + min_dist, w - margin - min_dist)
            cy = rng.uniform(margin + min_dist, h - margin - min_dist)
            pair = [(cx, cy), (cx + min_dist * 0.95, cy + min_dist * 0.15)]
            if all(
                all(math.hypot(px - qx, py - qy) >= min_dist * 0.8 for qx, qy in pts)
                for px, py in pair
            ) and all(margin < x < w - margin and margin < y < h - margin for x, y in pair):
                pts.extend(pair)
                break
    while len(pts) < count:
        x = rng.uniform(margin, w - margin)
        y = rng.uniform(margin, h - margin)
        if all(math.hypot(x - px, y - py) >= min_dist for px, py in pts):
            pts.append((x, y))
    return pts[:count]


def generate_dataset(
    out_dir: str | Path,
    n_sheets: int = 3,
    marks_per_sheet: int = 12,
    width: int = 1280,
    height: int = 960,
    seed: int = 20261126,
    shape_kind: str = "arrow",
) -> dict:
    """生成一整套合成验证数据，返回真值字典并写入 JSON。"""
    rng = np.random.default_rng(seed)
    out = Path(out_dir)
    (out / "template").mkdir(parents=True, exist_ok=True)
    (out / "sheets").mkdir(parents=True, exist_ok=True)

    base = render_shape(shape_kind, size=96)
    tpl_path = out / "template" / f"{shape_kind}.png"
    save_template(base, tpl_path)
    distractor = render_shape("star", size=96, color=DISTRACTOR_COLOR)

    # 与匹配端 fixed_canvas_size 一致的统一画布：标记贴入场景与匹配时
    # 重渲染走同一几何，二次 warp 可复现，避免亚像素错位拉低 NCC。
    from .matching import fixed_canvas_size

    canvas = fixed_canvas_size(base, 1.3)

    truth: dict = {
        "template": str(tpl_path),
        "shape": shape_kind,
        "canvas_size": canvas,
        "sheets": [],
    }
    min_center_dist = min(base.width, base.height) * 1.15

    for si in range(n_sheets):
        scene = _make_background(width, height, rng)
        # 每张图 2 个干扰项（不同形状）
        distract_pts = _sample_positions(rng, 2, width, height, 80, min_center_dist)
        for dx, dy in distract_pts:
            warped, wmask, _, s = warp_pose(
                distractor,
                angle=float(rng.uniform(0, 360)),
                scale=float(rng.uniform(0.85, 1.15)),
                flip=False,
            )
            _composite(scene, warped, wmask, int(dy - s / 2), int(dx - s / 2))

        # 最后一张图放一对贴得很近的标记，验证 NMS 不会误合并
        fixed_pairs = 1 if si == n_sheets - 1 else 0
        positions = _sample_positions(
            rng, marks_per_sheet, width, height, 90, min_center_dist, fixed_pairs=fixed_pairs
        )
        instances = []
        for idx, (cx, cy) in enumerate(positions):
            angle = float(rng.uniform(0, 360))
            scale = float(np.exp(rng.uniform(math.log(0.75), math.log(1.3))))
            # 约 20% 翻面、20% 遮挡
            flipped = rng.random() < 0.2
            occluded = rng.random() < 0.2
            warped, wmask, _, s = warp_pose(
                base, angle=angle, scale=scale, flip=flipped, canvas_size=canvas
            )
            top, left = int(round(cy - s / 2)), int(round(cx - s / 2))
            _composite(scene, warped, wmask, top, left)
            if occluded:
                _add_occlusion(scene, (cx, cy), int(min(base.width, base.height) * scale * 0.45), rng)
            instances.append(
                {
                    "x": round(cx, 2),
                    "y": round(cy, 2),
                    "angle": round(angle, 2),
                    "scale": round(scale, 4),
                    "flipped": flipped,
                    "occluded": occluded,
                }
            )

        sheet_path = out / "sheets" / f"sheet_{si:02d}.png"
        cv2.imwrite(str(sheet_path), scene)
        truth["sheets"].append({"file": str(sheet_path), "instances": instances})

    with open(out / "ground_truth.json", "w", encoding="utf-8") as f:
        json.dump(truth, f, ensure_ascii=False, indent=2)

    manifest = {
        "sheets": [
            {
                "file": s["file"],
                "total_marks": len(s["instances"]),
                "normal": sum(1 for i in s["instances"] if not i["flipped"]),
                "flipped": sum(1 for i in s["instances"] if i["flipped"]),
                "occluded": sum(1 for i in s["instances"] if i["occluded"]),
            }
            for s in truth["sheets"]
        ]
    }
    with open(out / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return truth


# ---------------------------------------------------------------- 指标验证
def evaluate_sheet(
    matches: list,
    instances: list[dict],
    position_tol_px: float,
    angle_tol_deg: float = 15.0,
    scale_tol: float = 0.25,
) -> dict:
    """贪心配对预测与真值，返回该图指标。

    配对条件：中心距 < position_tol_px、翻面属性一致、角度/缩放差在容差内。
    """
    remaining = list(instances)
    pairs = []
    false_alarms = []
    for m in sorted(matches, key=lambda x: x.score, reverse=True):
        best, best_d = None, float("inf")
        for gt in remaining:
            if gt["flipped"] != m.flipped:
                continue
            d = math.hypot(gt["x"] - m.x, gt["y"] - m.y)
            if d > position_tol_px or d >= best_d:
                continue
            if abs(angle_diff(gt["angle"], m.angle)) > angle_tol_deg:
                continue
            if abs(gt["scale"] - m.scale) > scale_tol:
                continue
            best, best_d = gt, d
        if best is not None:
            remaining.remove(best)
            pairs.append((m, best))
        else:
            false_alarms.append(m)

    normal_gt = [g for g in instances if not g["flipped"]]
    flipped_gt = [g for g in instances if g["flipped"]]
    found_normal = sum(1 for _, g in pairs if not g["flipped"])
    found_flipped = sum(1 for _, g in pairs if g["flipped"])
    return {
        "gt_total": len(instances),
        "gt_normal": len(normal_gt),
        "gt_flipped": len(flipped_gt),
        "predicted": len(matches),
        "matched": len(pairs),
        "recall_normal": found_normal / max(1, len(normal_gt)),
        "flipped_matched": found_flipped,
        "false_positives": len(false_alarms),
        "precision": len(pairs) / max(1, len(matches)),
        "missed": remaining,
    }


def validate_dataset(
    dataset_dir: str | Path,
    params: SearchParams | None = None,
    score_threshold: float | None = None,
) -> dict:
    """对合成数据集跑完整查找并汇总计数与查准/查全指标。"""
    dataset_dir = Path(dataset_dir)
    with open(dataset_dir / "ground_truth.json", "r", encoding="utf-8") as f:
        truth = json.load(f)
    from .template import load_template

    tpl = load_template(truth["template"])
    params = params or SearchParams()
    if score_threshold is not None:
        params.score_threshold = score_threshold
    # 与合成生成端使用同一画布，保证二次 warp 几何完全一致
    if truth.get("canvas_size"):
        params.canvas_size_override = int(truth["canvas_size"])

    base_size = min(tpl.width, tpl.height)
    tol = base_size * 0.6
    per_sheet = []
    for sheet in truth["sheets"]:
        img = cv2.imread(sheet["file"], cv2.IMREAD_COLOR)
        matches = find_matches(tpl, img, params)
        metrics = evaluate_sheet(matches, sheet["instances"], tol)
        metrics["file"] = sheet["file"]
        per_sheet.append(metrics)

    total_gt = sum(s["gt_total"] for s in per_sheet)
    total_normal = sum(s["gt_normal"] for s in per_sheet)
    total_matched = sum(s["matched"] for s in per_sheet)
    total_fp = sum(s["false_positives"] for s in per_sheet)
    flipped_matched = sum(s["flipped_matched"] for s in per_sheet)
    summary = {
        "allow_flip": params.allow_flip,
        "score_threshold": params.score_threshold,
        "sheets": per_sheet,
        "totals": {
            "gt_total": total_gt,
            "gt_normal": total_normal,
            "matched": total_matched,
            "false_positives": total_fp,
            "recall_normal": sum(
                s["recall_normal"] * s["gt_normal"] for s in per_sheet
            ) / max(1, total_normal),
            "precision": total_matched / max(1, total_matched + total_fp),
            "flipped_matched": flipped_matched,
            "count_abs_error": sum(abs(s["predicted"] - s["gt_normal"]) for s in per_sheet)
            if not params.allow_flip
            else sum(abs(s["predicted"] - s["gt_total"]) for s in per_sheet),
        },
    }
    return summary
