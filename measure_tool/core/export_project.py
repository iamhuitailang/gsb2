"""标定、轮廓与毫米读数的导出 / 读回 / 描边。

导出一个工程 JSON（自描述、可直接读回），并可选生成一张描边 PNG：
在原图上画出有效区域、外轮廓、孔、外宽外高测量线段与投影线。
读回时校验图片尺寸与标定一致性，再重建 Calibration / 测量表。
"""

from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

from .geometry import Calibration, calibration_from_dict
from .measurements import Measurement
from .segmentation import COLORS, Segmentation, OUTER, HOLE, BORDER

SCHEMA_VERSION = 1


def build_export(*, image_path: str, image_shape: tuple[int, int],
                 calibration: Calibration,
                 segmentation: Segmentation,
                 measurements: dict[int, Measurement],
                 pending: dict[int, dict] | None = None,
                 diff: dict | None = None,
                 source_name: str = "") -> dict:
    """组装可序列化的工程字典。"""
    return {
        "schema_version": SCHEMA_VERSION,
        "source": {
            "image_path": str(image_path),
            "image_name": Path(image_path).name,
            "image_shape": list(image_shape),
            "source_name": source_name,
        },
        "calibration": calibration.to_dict(),
        "segmentation": {
            "params": segmentation.params.to_dict(),
            "kept_speck_count": segmentation.kept_speck_count,
            "dropped_speck_count": segmentation.dropped_speck_count,
            "bg_components": list(segmentation.bg_components.values()),
            "components": [
                {
                    "comp_id": c.comp_id,
                    "kind": c.kind,
                    "parent_id": c.parent_id,
                    "child_ids": c.child_ids,
                    "bbox": list(c.bbox),
                    "outer_area_px": c.outer_area_px,
                    "filled_area_px": c.filled_area_px,
                    "hole_area_px": c.hole_area_px,
                    "touches_border": c.touches_border,
                    "border_sides": c.border_sides,
                    "bg_label": c.bg_label,
                    "contour_px": c.contour.reshape(-1, 2).astype(float).tolist(),
                }
                for c in segmentation.components.values()
            ],
        },
        "measurements": {str(k): m.to_dict() for k, m in measurements.items()},
        "pending_readings": pending or {},
        "snapshot_diff": diff,
    }


def save_project(project: dict, path: str | Path) -> Path:
    path = Path(path)
    path.write_text(json.dumps(project, ensure_ascii=False, indent=2),
                    encoding="utf-8")
    return path


def load_project(path: str | Path) -> dict:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if data.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(
            f"工程文件版本 {data.get('schema_version')} 与当前 {SCHEMA_VERSION} 不兼容"
        )
    return data


def restore_calibration(project: dict,
                        image_shape: tuple[int, int] | None = None) -> Calibration:
    shape = tuple(image_shape or project["source"]["image_shape"])
    return calibration_from_dict(project["calibration"], shape)


def validate_project_against_image(project: dict,
                                   image_shape: tuple[int, int]) -> list[str]:
    """读回时检查图片与工程是否匹配，返回问题列表（空=通过）。"""
    problems = []
    saved = tuple(project["source"]["image_shape"])
    if saved != tuple(image_shape):
        problems.append(
            f"图片尺寸不一致：工程记录 {saved[1]}x{saved[0]}，"
            f"当前图片 {image_shape[1]}x{image_shape[0]}，毫米读数会错位"
        )
    cal = restore_calibration(project, image_shape)
    # 横纵 mm/px 差异来自两尺独立点选的像素误差，15% 以内视为正常
    if cal.quality["scale_mismatch_percent"] > 15.0:
        problems.append(
            f"横纵标尺 mm/px 相差 {cal.quality['scale_mismatch_percent']:.1f}%，"
            "请确认标尺长度输入与端点选择"
        )
    return problems


# ---------------------------------------------------------------------- #
# 描边图
# ---------------------------------------------------------------------- #
def draw_annotation(gray: np.ndarray, calibration: Calibration,
                    project: dict | None = None,
                    measurements: dict[int, Measurement] | None = None,
                    selected_id: int | None = None) -> np.ndarray:
    """在原图上描出测量用的线段和边界，返回 BGR 图。"""
    canvas = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)

    # 有效测量区域（半透明平行四边形）
    poly = calibration.valid_polygon.astype(np.int32)
    overlay = canvas.copy()
    cv2.fillPoly(overlay, [poly], (200, 200, 100))
    canvas = cv2.addWeighted(overlay, 0.18, canvas, 0.82, 0)
    cv2.polylines(canvas, [poly], True, (200, 200, 100), 2)

    # 两根标尺
    for ruler, color in ((calibration.horizontal, (255, 140, 0)),
                         (calibration.vertical, (0, 140, 255))):
        a = tuple(np.round(ruler.a).astype(int))
        b = tuple(np.round(ruler.b).astype(int))
        cv2.line(canvas, a, b, color, 3)
        for p in (a, b):
            cv2.circle(canvas, p, 6, color, -1)
        mid = (int((a[0] + b[0]) / 2), int((a[1] + b[1]) / 2))
        cv2.putText(canvas, f"{ruler.name} {ruler.length_mm:g}mm",
                    (mid[0] + 8, mid[1] - 8), cv2.FONT_HERSHEY_SIMPLEX,
                    0.7, color, 2)

    # 轮廓
    if project:
        for comp in project["segmentation"]["components"]:
            kind = comp["kind"]
            pts = np.array(comp["contour_px"], dtype=np.int32).reshape(-1, 1, 2)
            color = COLORS[kind]
            thickness = 3 if comp["comp_id"] == selected_id else 2
            cv2.drawContours(canvas, [pts], -1, color, thickness)

    # 测量线段：外宽（横尺向）、外高（纵尺向）
    if measurements:
        for cid, m in measurements.items():
            comp = _find_comp(project, cid)
            if comp is None:
                continue
            active = cid == selected_id
            _draw_width_height(canvas, calibration, comp, m, active)

    return canvas


def _find_comp(project: dict | None, comp_id: int) -> dict | None:
    if not project:
        return None
    for comp in project["segmentation"]["components"]:
        if comp["comp_id"] == comp_id:
            return comp
    return None


def _draw_width_height(canvas: np.ndarray, calib: Calibration,
                       comp: dict, m: Measurement, active: bool) -> None:
    pts = np.array(comp["contour_px"], dtype=float)
    uv = calib.to_mm_xy(pts)
    u_min, u_max = uv[:, 0].min(), uv[:, 0].max()
    v_min, v_max = uv[:, 1].min(), uv[:, 1].max()
    u_mid = (u_min + u_max) / 2
    v_mid = (v_min + v_max) / 2

    # 外宽：在 v = v_mid 处沿 u 轴
    w_p0 = calib.to_pixel(np.array([[u_min, v_mid]]))[0]
    w_p1 = calib.to_pixel(np.array([[u_max, v_mid]]))[0]
    # 外高：在 u = u_mid 处沿 v 轴
    h_p0 = calib.to_pixel(np.array([[u_mid, v_min]]))[0]
    h_p1 = calib.to_pixel(np.array([[u_mid, v_max]]))[0]

    w_color = (255, 140, 0)
    h_color = (0, 140, 255)
    thick = 3 if active else 2
    cv2.line(canvas, _i(w_p0), _i(w_p1), w_color, thick, cv2.LINE_AA)
    cv2.line(canvas, _i(h_p0), _i(h_p1), h_color, thick, cv2.LINE_AA)

    if active:
        cv2.putText(canvas, f"W {m.outer_width_mm:.2f} mm (含孔外径)",
                    _i(w_p1 + np.array([8, 0])), cv2.FONT_HERSHEY_SIMPLEX,
                    0.65, w_color, 2)
        cv2.putText(canvas, f"H {m.outer_height_mm:.2f} mm (含孔外径)",
                    _i(h_p1 + np.array([8, 0])), cv2.FONT_HERSHEY_SIMPLEX,
                    0.65, h_color, 2)
        cv2.putText(
            canvas,
            f"fill {m.filled_area_mm2:.1f} mm2 (不含孔) / "
            f"hole {m.hole_area_mm2:.1f} mm2",
            _i(h_p0 + np.array([8, 18])), cv2.FONT_HERSHEY_SIMPLEX,
            0.6, (60, 60, 60), 2,
        )
        # 投影线（沿各方向过中心的跨度线段）
        cx, cy = pts.mean(axis=0)
        for pr in m.projections:
            rad = np.radians(pr.angle_deg)
            unit = np.array([np.cos(rad), np.sin(rad)])
            rel = (pts - np.array([cx, cy])) @ unit
            p_a = np.array([cx, cy]) + unit * rel.min()
            p_b = np.array([cx, cy]) + unit * rel.max()
            cv2.line(canvas, _i(p_a), _i(p_b), (180, 180, 180), 1,
                     cv2.LINE_AA)


def _i(p: np.ndarray) -> tuple[int, int]:
    return int(round(float(p[0]))), int(round(float(p[1])))
