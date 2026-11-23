"""两次分割结果的孔命运比较测试。"""
import cv2
import numpy as np

from core.compare import (
    STILL_HOLE, TO_BACKGROUND, TO_PART, NEW_HOLE, compare_segmentations,
)
from core.segmentation import SegmentParams, segment


def _plate(with_hole=True, bridge_to_outside=False, filled=False):
    img = np.full((400, 500), 240, dtype=np.uint8)
    cv2.rectangle(img, (100, 80), (400, 320), 20, cv2.FILLED)
    if with_hole and not filled:
        cv2.circle(img, (250, 200), 25, 240, cv2.FILLED)
        if bridge_to_outside:
            # 从孔向右边缘开一条背景窄缝 => 孔与外部连通
            cv2.rectangle(img, (250, 197), (400, 203), 240, cv2.FILLED)
    return img


def test_still_hole_unchanged_threshold():
    img = _plate()
    old = segment(img, SegmentParams(threshold=100))
    new = segment(img, SegmentParams(threshold=160))
    diff = compare_segmentations(old, new)
    assert len(diff.matched) == 1
    fates = diff.matched[0].hole_fates
    assert any(f.fate == STILL_HOLE for f in fates)


def test_hole_connected_to_exterior():
    old = segment(_plate(bridge_to_outside=False), SegmentParams())
    new = segment(_plate(bridge_to_outside=True), SegmentParams())
    diff = compare_segmentations(old, new)
    fates = diff.matched[0].hole_fates
    fate = next(f for f in fates if f.old_hole_id is not None)
    assert fate.fate == TO_BACKGROUND
    assert fate.connected_to_exterior


def test_hole_filled_becomes_part():
    old = segment(_plate(filled=False), SegmentParams())
    new = segment(_plate(filled=True), SegmentParams())
    diff = compare_segmentations(old, new)
    fate = diff.matched[0].hole_fates[0]
    assert fate.fate == TO_PART
    assert fate.new_area_px == 0


def test_new_hole_appears():
    old = segment(_plate(with_hole=False), SegmentParams())
    new = segment(_plate(with_hole=True), SegmentParams())
    diff = compare_segmentations(old, new)
    fates = diff.matched[0].hole_fates
    assert any(f.fate == NEW_HOLE for f in fates)


def test_component_matching_across_thresholds():
    img = _plate()
    old = segment(img, SegmentParams(threshold=80, min_speck_area_px=1))
    new = segment(img, SegmentParams(threshold=180, min_speck_area_px=1))
    diff = compare_segmentations(old, new)
    assert len(diff.matched) == 1
    assert diff.only_in_old == []
    assert diff.only_in_new == []
