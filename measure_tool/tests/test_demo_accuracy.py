"""用演示图的已知尺寸验证全流程测量误差。

容许误差取 0.3mm / 1.5%（演示图本身有模糊和噪声，不是理想矢量图）。
同时验证斜标尺、贴边截断和开口孔这三类场景的可靠性标记。
"""
import json
import math

import cv2
import pytest

from core.geometry import Calibration, Ruler
from core.measurements import measure_all
from core.segmentation import SegmentParams, load_gray, segment

TOL_MM = 0.3
TOL_PCT = 0.015


def _calib_from_gt(gt_image: dict, shape) -> Calibration:
    rs = gt_image["rulers"]
    h, v = rs[0], rs[1]
    return Calibration(
        Ruler(tuple(h["a"]), tuple(h["b"]), h["length_mm"], h["name"]),
        Ruler(tuple(v["a"]), tuple(v["b"]), v["length_mm"], v["name"]),
        shape,
    )


def _pipeline(demo_dir, gt_image):
    gray = load_gray(str(demo_dir / gt_image["image"]))
    calib = _calib_from_gt(gt_image, gray.shape[:2])
    # 标尺刻度/数字是小面积黑块，提高小黑点门槛把它们与噪点一起过滤
    seg = segment(gray, SegmentParams(threshold=128, min_speck_area_px=3000))
    all_m = measure_all(seg, calib)
    # 真实零件面积都在 1 万 px² 以上；剩余的小外块是标尺刻度/数字，
    # 探出图边的标尺框是 border 类，一并排除
    measurements = {
        cid: m for cid, m in all_m.items()
        if not m.touches_border
        and seg.components[cid].outer_area_px >= 10000
    }
    return gray, calib, seg, measurements


def _match_gt_part(seg, measurements, gt_part, calib):
    """按 ground truth 中心找到对应的测量组件。"""
    center_px = calib.to_pixel([gt_part["center_mm"]])[0]
    best = None
    best_d = 1e18
    for cid, m in measurements.items():
        comp = seg.components[cid]
        x, y, w, h = comp.bbox
        bc = (x + w / 2, y + h / 2)
        d = math.dist(bc, center_px)
        if d < best_d:
            best_d, best = d, cid
    return best, best_d


def test_demo_a_aligned_dimensions(demo_dir, ground_truth):
    gt_image = ground_truth["images"][0]
    assert gt_image["image"] == "demo_a_aligned.png"
    gray, calib, seg, measurements = _pipeline(demo_dir, gt_image)

    assert len(measurements) == 2  # 小黑点与标尺刻度被过滤，只剩两件零件
    for gt_part in gt_image["parts"]:
        cid, dist = _match_gt_part(seg, measurements, gt_part, calib)
        assert dist < 30
        m = measurements[cid]
        if gt_part["shape"]["kind"] == "rect":
            assert abs(m.outer_width_mm - gt_part["local_width_mm"]) < TOL_MM
            assert abs(m.outer_height_mm - gt_part["local_height_mm"]) < TOL_MM
        else:
            diam = gt_part["local_diameter_mm"]
            assert abs(m.outer_width_mm - diam) < TOL_MM
            assert abs(m.outer_height_mm - diam) < TOL_MM
        # 面积误差按百分比
        assert abs(m.outer_area_mm2 - gt_part["outer_area_mm2"]) \
            / gt_part["outer_area_mm2"] < TOL_PCT
        assert abs(m.filled_area_mm2 - gt_part["filled_area_mm2"]) \
            / gt_part["filled_area_mm2"] < TOL_PCT
        assert m.hole_count == len(gt_part["holes"])
        assert m.inside_fraction > 0.999
        assert not m.touches_border


def test_demo_b_rotated_skewed_rulers(demo_dir, ground_truth):
    gt_image = ground_truth["images"][1]
    gray, calib, seg, measurements = _pipeline(demo_dir, gt_image)

    # 横尺相对图片边倾斜 12°
    assert abs(calib.quality["horizontal_tilt_deg"]) > 5
    assert len(measurements) == 2

    for gt_part in gt_image["parts"]:
        cid, _ = _match_gt_part(seg, measurements, gt_part, calib)
        m = measurements[cid]
        # 旋转后在标尺 u/v 框架下，外接宽高不再等于局部宽高，
        # 但轮廓面积与孔数保持不变 —— 这是斜标尺下可可靠给出的量
        assert abs(m.outer_area_mm2 - gt_part["outer_area_mm2"]) \
            / gt_part["outer_area_mm2"] < TOL_PCT
        assert m.hole_count == len(gt_part["holes"])
        # 投影序列里应能找到接近局部直径/边长的极值跨度
        gt_w = gt_part.get("local_width_mm", gt_part.get("local_diameter_mm"))
        gt_h = gt_part.get("local_height_mm", gt_part.get("local_diameter_mm"))
        sizes = [p.size_mm for p in m.projections]
        assert max(sizes) >= max(gt_w, gt_h) - TOL_MM


def test_demo_c_border_and_open_hole_flagged(demo_dir, ground_truth):
    gt_image = ground_truth["images"][2]
    gray, calib, seg, measurements = _pipeline(demo_dir, gt_image)

    border_parts = [m for m in measure_all(seg, calib).values()
                    if m.touches_border]
    # 贴边矩形板 + 探出底边的标尺框
    assert len(border_parts) >= 1
    truncated = [m for m in border_parts if any("截断" in w for w in m.warnings)]
    assert truncated
    bm = truncated[0]

    # 开口孔板：两个形状里只有一个是封闭孔
    open_part_gt = next(p for p in gt_image["parts"]
                        if any(h["open_to_exterior"] for h in p["holes"]))
    cid, _ = _match_gt_part(seg, measurements, open_part_gt, calib)
    m = measurements[cid]
    assert m.hole_count == 1  # 开口孔不算孔
    assert m.hole_area_mm2 > 0


def test_scale_accuracy_under_one_percent(demo_dir, ground_truth):
    """圆盘直径读数与真值的相对误差 < 1%。"""
    gt_image = ground_truth["images"][0]
    _, _, _, measurements = _pipeline(demo_dir, gt_image)
    disk_gt = next(p for p in gt_image["parts"]
                   if p["shape"]["kind"] == "circle")
    for m in measurements.values():
        if abs(m.outer_width_mm - disk_gt["local_diameter_mm"]) < 2:
            err = abs(m.outer_width_mm - disk_gt["local_diameter_mm"]) \
                / disk_gt["local_diameter_mm"]
            assert err < 0.01
            return
    pytest.fail("未找到圆盘测量结果")
