"""分割逻辑测试：轮廓层级、孔、小黑点、碰边。"""
import cv2
import numpy as np

from core.segmentation import (
    OUTER, HOLE, BORDER, SegmentParams, binarize, segment,
)


def _synthetic_image():
    img = np.full((400, 500), 240, dtype=np.uint8)
    # 一个 100x80 的矩形零件，带一个半径 10 的圆孔
    cv2.rectangle(img, (100, 100), (200, 180), 20, thickness=cv2.FILLED)
    cv2.circle(img, (150, 140), 10, 240, thickness=cv2.FILLED)
    # 独立小黑点 3x3
    cv2.rectangle(img, (300, 300), (302, 302), 20, thickness=cv2.FILLED)
    return img


def test_binarize_dark_on_light():
    img = _synthetic_image()
    params = SegmentParams(threshold=128)
    binary = binarize(img, params)
    assert binary[140, 150] == 255   # 孔内是背景
    assert binary[110, 110] == 0     # 零件是黑


def test_outer_hole_hierarchy():
    img = _synthetic_image()
    seg = segment(img, SegmentParams(threshold=128, min_speck_area_px=20))
    outers = seg.outers()
    assert len(outers) == 1
    main = outers[0]
    assert main.kind == OUTER
    assert len(main.child_ids) == 1
    hole = seg.components[main.child_ids[0]]
    assert hole.kind == HOLE
    # 圆半径 10 => 面积约 314 px²，给抗锯齿留余量
    assert 280 < hole.hole_area_px < 350


def test_speck_filter_toggle():
    img = _synthetic_image()
    # 大阈值过滤：3x3 黑点被丢弃
    seg_f = segment(img, SegmentParams(min_speck_area_px=20))
    assert seg_f.dropped_speck_count == 1
    assert len(seg_f.outers()) == 1
    # 阈值降到 1：黑点保留为独立零件
    seg_k = segment(img, SegmentParams(min_speck_area_px=1))
    assert len(seg_k.outers()) == 2
    assert seg_k.dropped_speck_count == 0


def test_border_touch_detection():
    img = np.full((300, 300), 240, dtype=np.uint8)
    cv2.rectangle(img, (0, 50), (120, 200), 20, cv2.FILLED)  # 贴左边
    seg = segment(img, SegmentParams())
    outers = seg.outers()
    assert len(outers) == 1
    assert outers[0].kind == BORDER
    assert "left" in outers[0].border_sides


def test_background_components_distinguish_exterior():
    img = _synthetic_image()
    seg = segment(img, SegmentParams())
    hole_labels = [
        lab for lab, info in seg.bg_components.items() if info["is_hole"]
    ]
    exterior = [
        lab for lab, info in seg.bg_components.items()
        if info["touches_border"]
    ]
    assert len(hole_labels) == 1      # 圆孔是唯一封闭背景
    assert len(exterior) >= 1


def test_filled_area_excludes_hole():
    img_with = _synthetic_image()
    seg_with = segment(img_with, SegmentParams(min_speck_area_px=20))
    main = seg_with.outers()[0]

    img_no_hole = np.full((400, 500), 240, dtype=np.uint8)
    cv2.rectangle(img_no_hole, (100, 100), (200, 180), 20,
                  thickness=cv2.FILLED)
    seg_full = segment(img_no_hole, SegmentParams(min_speck_area_px=20))
    full_main = seg_full.outers()[0]

    # 外轮廓包围面积两者相同；带孔零件的实际填充面积更小，
    # 差值应接近孔的像素面积（半径 10 的圆 ≈ 314）
    assert main.outer_area_px == full_main.outer_area_px
    removed = full_main.filled_area_px - main.filled_area_px
    assert 250 < removed < 380
    assert main.filled_area_px < main.outer_area_px
