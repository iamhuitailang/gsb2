"""结果可视化：原图标注与局部对照面板。"""

from __future__ import annotations

import math

import cv2
import numpy as np

from .candidates import Match
from .matching import PoseResult, score_pose, warp_pose, fixed_canvas_size
from .template import Template

# 决策配色（BGR）
_COLORS = {
    "candidate": (60, 200, 255),      # 橙黄
    "confirmed": (60, 220, 60),       # 绿
    "false_positive": (60, 60, 240),  # 红
}
_HIDDEN_COLOR = (160, 160, 160)


def _direction_arrow(bbox: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """用模板上边中点 -> 模板中心表示朝向。"""
    top_mid = (bbox[0] + bbox[1]) / 2.0
    center = bbox.mean(axis=0)
    return center, top_mid


def draw_match(
    image: np.ndarray,
    match: Match,
    label: str | None = None,
    show_hidden: bool = False,
) -> np.ndarray:
    """在图上画一个候选：外接四边形、中心、朝向箭头、分数标签。"""
    out = image
    if match.hidden and not show_hidden:
        return out
    color = _HIDDEN_COLOR if match.hidden else _COLORS.get(match.decision, _COLORS["candidate"])
    pts = np.round(match.bbox).astype(np.int32).reshape(-1, 1, 2)
    thickness = 3 if match.decision == "confirmed" else 2
    cv2.polylines(out, [pts], isClosed=True, color=color, thickness=thickness)

    center, tip = _direction_arrow(match.bbox)
    cv2.arrowedLine(
        out,
        tuple(np.round(center).astype(int)),
        tuple(np.round(tip).astype(int)),
        color,
        2,
        tipLength=0.35,
    )
    cv2.circle(out, tuple(np.round(center).astype(int)), 3, color, -1)

    if label is None:
        tag = f"{match.id} {match.score:.2f}"
        if match.flipped:
            tag += " flip"
    else:
        tag = label
    anchor = tuple(np.round(pts[0, 0]).astype(int))
    _put_text(out, tag, anchor, color)
    return out


def _put_text(img: np.ndarray, text: str, anchor: tuple[int, int], color: tuple) -> None:
    (tw, th), base = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
    x = max(0, anchor[0])
    y = max(th + 2, anchor[1] - 4)
    cv2.rectangle(img, (x, y - th - base), (x + tw + 4, y + base), (30, 30, 30), -1)
    cv2.putText(img, text, (x + 2, y - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA)


def draw_all(
    image: np.ndarray,
    matches: list[Match],
    show_hidden: bool = False,
) -> np.ndarray:
    """整图标注，返回新图。"""
    out = image.copy()
    for m in matches:
        draw_match(out, m, show_hidden=show_hidden)
    return out


def cell_heatmap(cell_scores: np.ndarray, cell_size: int = 60) -> np.ndarray:
    """把逐单元 NCC 画成热力小图：红=差（疑似缺角/遮挡），绿=好，灰=无有效像素。"""
    rows, cols = cell_scores.shape
    canvas = np.full((rows * cell_size, cols * cell_size, 3), 255, np.uint8)
    for r in range(rows):
        for c in range(cols):
            v = cell_scores[r, c]
            x0, y0 = c * cell_size, r * cell_size
            if np.isnan(v):
                color = (200, 200, 200)
            else:
                t = float(np.clip((v + 1.0) / 2.0, 0.0, 1.0))  # -1..1 -> 0..1
                # 红 (60,60,240) -> 绿 (60,220,60)
                color = (
                    int(60 + (60 - 60) * t),
                    int(60 + (220 - 60) * t),
                    int(240 + (60 - 240) * t),
                )
            cv2.rectangle(canvas, (x0, y0), (x0 + cell_size - 2, y0 + cell_size - 2), color, -1)
            txt = "--" if np.isnan(v) else f"{v:.2f}"
            cv2.putText(
                canvas, txt, (x0 + 6, y0 + cell_size // 2 + 6),
                cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA,
            )
    return canvas


def comparison_panel(
    image: np.ndarray,
    template: Template,
    match: Match,
) -> np.ndarray:
    """四宫格局部对照：变换后模板 | 目标局部 | 差异图 | 单元热力。

    差异图 = 掩膜内模板与目标的灰度绝对差（越亮差异越大），
    配合单元热力可以判断是整体不像（误报）还是局部被挡（候选可留）。
    """
    # 用与匹配端一致的固定画布，保证局部对照与候选位姿几何对齐
    canvas = fixed_canvas_size(template, max(match.scale, 1.0))
    pose = score_pose(
        image,
        template,
        (match.x, match.y),
        match.angle,
        match.scale,
        match.flipped,
        match.cell_rows,
        match.cell_cols,
        canvas_size=canvas,
    )
    size = pose.warped_mask.shape[0]
    u = int(round(match.x - size / 2.0))
    v = int(round(match.y - size / 2.0))
    h_img, w_img = image.shape[:2]
    target = np.zeros_like(pose.warped_template)
    x0, y0 = max(u, 0), max(v, 0)
    x1, y1 = min(u + size, w_img), min(v + size, h_img)
    target[y0 - v:y1 - v, x0 - u:x1 - u] = image[y0:y1, x0:x1]

    tpl_gray = cv2.cvtColor(pose.warped_template, cv2.COLOR_BGR2GRAY)
    tgt_gray = cv2.cvtColor(target, cv2.COLOR_BGR2GRAY)
    diff = cv2.absdiff(tpl_gray, tgt_gray)
    diff[pose.warped_mask == 0] = 0
    diff_color = cv2.cvtColor(diff, cv2.COLOR_GRAY2BGR)
    diff_color[pose.warped_mask == 0] = (220, 220, 220)

    heat = cell_heatmap(pose.cell_scores, cell_size=max(24, size // match.cell_cols))
    heat = cv2.resize(heat, (size, size), interpolation=cv2.INTER_NEAREST)

    gap = 8
    title_h = 28
    panels = [
        ("warped template", pose.warped_template),
        ("target patch", target),
        ("abs diff (masked)", diff_color),
        ("cell NCC heatmap", heat),
    ]
    row = np.full((size + title_h, 4 * size + 5 * gap, 3), 245, np.uint8)
    for i, (title, panel) in enumerate(panels):
        x = gap + i * (size + gap)
        _panel_title(row, title, x, title_h)
        row[title_h:title_h + size, x:x + size] = panel
    header = np.full((36, row.shape[1], 3), 245, np.uint8)
    info = (
        f"{match.id}  score={match.score:.3f}  robust={match.robust_score:.3f}  "
        f"angle={match.angle:.1f}  scale={match.scale:.2f}  flipped={match.flipped}  "
        f"decision={match.decision}"
    )
    cv2.putText(header, info, (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (40, 40, 40), 1, cv2.LINE_AA)
    return np.vstack([header, row])


def _panel_title(canvas: np.ndarray, title: str, x: int, title_h: int) -> None:
    cv2.putText(
        canvas, title, (x + 4, title_h - 8),
        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (50, 50, 50), 1, cv2.LINE_AA,
    )


def template_preview(template: Template, max_side: int = 240) -> np.ndarray:
    """模板预览：棋盘格表示被圈掉的背景。"""
    img = template.image.copy()
    checker = np.zeros_like(img)
    block = 12
    for r in range(0, checker.shape[0], block):
        for c in range(0, checker.shape[1], block):
            shade = 215 if ((r // block + c // block) % 2 == 0) else 175
            checker[r:r + block, c:c + block] = (shade, shade, shade)
    mask3 = cv2.cvtColor(template.mask, cv2.COLOR_GRAY2BGR) > 0
    preview = np.where(mask3, img, checker)
    scale = min(1.0, max_side / max(preview.shape[:2]))
    if scale < 1.0:
        preview = cv2.resize(preview, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    return preview
