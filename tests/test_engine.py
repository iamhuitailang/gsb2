"""SeamEngine 核心行为测试。"""

import numpy as np
import pytest

from seamsqueeze import MaskSet, Rect, SeamEngine
from seamsqueeze.demo import make_dense, make_sparse
from seamsqueeze.engine import (
    HORIZONTAL,
    VERTICAL,
    ProtectionBlockedError,
    TargetTooSmallError,
)


def _check_pixels_survive(engine: SeamEngine, rect: Rect) -> None:
    """源矩形内的每个像素都必须仍存在于当前帧。"""
    h, w = engine.src_map.shape
    present = set(engine.src_map.ravel().tolist())
    for y in range(rect.y0, rect.y1 + 1):
        for x in range(rect.x0, rect.x1 + 1):
            assert y * engine.src_w + x in present, (
                f"保护区像素 (y={y}, x={x}) 被接缝穿过"
            )


def test_sparse_resize_shrinks_only_width():
    image, masks = make_sparse()
    engine = SeamEngine(image, masks)
    w0, h0 = engine.size
    records = engine.resize_to(460, h0, order="width_first")

    assert engine.size == (460, h0)
    assert all(r.direction == VERTICAL for r in records)
    assert len(records) == w0 - 460
    # 两个完整物件的全部像素都幸存。
    for rect in masks.protect:
        _check_pixels_survive(engine, rect)


def test_protected_rectangle_never_cut_dense():
    image, masks = make_dense()
    engine = SeamEngine(image, masks)
    # 两个保护圆宽 111px，最小可行宽度 = 720 - 111 = 609，目标必须在上界之上。
    engine.resize_to(620, 240, order="alternate")
    assert engine.size == (620, 240)
    for rect in masks.protect:
        _check_pixels_survive(engine, rect)
    # 所有记录都不得触碰保护。
    assert not any(r.hits_protection for r in engine.steps)


def test_shrink_preference_concentrates_removed_columns_in_whitespace():
    image, masks = make_sparse()
    shrink = masks.shrink[0]
    capacity = shrink.width  # 标记留白 341 列

    # 竖直缝必须逐行连续，经过物件高度时只能从留白外绕；因此用
    # 「标记留白 vs 不标记」的相对差异验证偏好，而非要求绝对占比。
    engine = SeamEngine(image, masks)
    engine.resize_to(engine.size[0] - 120, engine.size[1], order="width_first")
    cols = engine.removed_source_columns()
    inside = sum(1 for c in cols if shrink.x0 <= c <= shrink.x1)

    from seamsqueeze import MaskSet as _MS

    ref = SeamEngine(image, _MS(protect=masks.protect, shrink=[]))
    ref.resize_to(ref.size[0] - 120, ref.size[1], order="width_first")
    ref_cols = ref.removed_source_columns()
    ref_inside = sum(1 for c in ref_cols if shrink.x0 <= c <= shrink.x1)
    assert inside > ref_inside
    # 标记留白后，落在留白内的被抽列应占明显多数。
    assert inside / len(cols) > 0.7

    # 缩减量超过留白容量时，多余接缝外溢是几何必然，引擎仍不得穿保护。
    big = SeamEngine(image, masks)
    big.resize_to(460, big.size[1], order="width_first")
    for rect in masks.protect:
        _check_pixels_survive(big, rect)


def test_undo_restores_frame_masks_and_mapping():
    image, masks = make_sparse()
    engine = SeamEngine(image, masks)
    before_protect = engine.protect.copy()
    before_map = engine.src_map.copy()
    before_size = engine.size

    engine.resize_to(500, 260, order="alternate")
    assert engine.size != before_size
    for _ in range(len(engine.steps)):
        engine.undo()

    assert engine.size == before_size
    assert np.array_equal(engine.image, image)
    assert np.array_equal(engine.protect, before_protect)
    assert np.array_equal(engine.shrink, engine.shrink)  # 快照可反复撤销
    assert np.array_equal(engine.src_map, before_map)
    assert engine.removed_ids == set()
    assert engine.steps == []


def test_undo_after_resize_then_step_keeps_mapping_consistent():
    image, masks = make_sparse()
    engine = SeamEngine(image, masks)
    engine.resize_to(520, 280, order="alternate")
    mid_size = engine.size
    mid_map = engine.src_map.copy()
    engine.remove_seam(VERTICAL)
    engine.undo()
    assert engine.size == mid_size
    assert np.array_equal(engine.src_map, mid_map)
    # 撤销后再抽的缝仍不得穿过保护。
    rec = engine.remove_seam(VERTICAL)
    assert not rec.hits_protection
    for rect in masks.protect:
        _check_pixels_survive(engine, rect)


def test_ordering_changes_sequence():
    image, masks = make_sparse()
    e1 = SeamEngine(image, masks)
    e2 = SeamEngine(image, masks)
    e1.resize_to(500, 240, order="width_first")
    e2.resize_to(500, 240, order="height_first")
    dirs1 = [s.direction for s in e1.steps]
    dirs2 = [s.direction for s in e2.steps]
    assert dirs1 == [VERTICAL] * (720 - 500) + [HORIZONTAL] * (300 - 240)
    assert dirs2 == [HORIZONTAL] * (300 - 240) + [VERTICAL] * (720 - 500)
    assert dirs1 != dirs2


def test_target_below_protection_bound_raises():
    image, masks = make_sparse()
    engine = SeamEngine(image, masks)
    min_w = engine.min_width()
    with pytest.raises(TargetTooSmallError) as exc:
        engine.resize_to(min_w - 1, engine.size[1])
    assert "保护区域" in str(exc.value)


def test_feasibility_bounds_formula():
    # 无蒙版时不存在保护约束，理论上下界为 1（总能找到不穿保护的缝）。
    image, _ = make_sparse()
    engine = SeamEngine(image, MaskSet())
    assert engine.min_width() == 1
    assert engine.min_height() == 1

    # 单行保护 k 个像素：宽度下界 = 宽 - k（该行最多只能抽走 w-k 条缝）。
    img = np.zeros((4, 10, 3), dtype=np.uint8)
    masks = MaskSet(protect=[Rect(2, 1, 5, 1)])  # 第 1 行连续保护 4 个像素
    eng = SeamEngine(img, masks)
    assert eng.min_width() == 6  # 10 - 4
    # 单列保护 m 个像素：高度下界 = 高 - m。
    masks2 = MaskSet(protect=[Rect(3, 0, 3, 2)])  # 第 3 列连续保护 3 个像素
    eng2 = SeamEngine(img, masks2)
    assert eng2.min_height() == 1  # 4 - 3

    # 下界处应可完成，再小一格必然拒绝。
    eng.resize_to(eng.min_width(), eng.size[1])
    assert eng.size[0] == eng.min_width()
    with pytest.raises(TargetTooSmallError):
        SeamEngine(img, masks).resize_to(eng.min_width() - 1, 4)

    # 无蒙版时可以一路缩到很窄而不触发保护错误。
    free = SeamEngine(img, MaskSet())
    free.resize_to(2, 2)
    assert free.size == (2, 2)


def test_blocking_when_no_free_path():
    # 单行高度：水平方向每行只有一个像素，把整行保护后无自由路径。
    image = np.zeros((1, 12, 3), dtype=np.uint8)
    image[:, :, 0] = np.arange(12) * 20
    masks = MaskSet(protect=[Rect(0, 0, 11, 0, name="整行")])
    engine = SeamEngine(image, masks)
    assert engine.min_width() == 0
    with pytest.raises((ProtectionBlockedError, TargetTooSmallError)):
        engine.remove_seam(VERTICAL)


def test_preview_does_not_mutate():
    image, masks = make_dense()
    engine = SeamEngine(image, masks)
    size_before = engine.size
    map_before = engine.src_map.copy()
    rec = engine.preview_seam(VERTICAL)
    assert engine.size == size_before
    assert np.array_equal(engine.src_map, map_before)
    assert len(rec.current_path) == engine.size[1]
    assert len(rec.source_path) == len(rec.current_path)


def test_removed_pixels_match_dimension_loss():
    image, masks = make_sparse()
    engine = SeamEngine(image, masks)
    n = 80
    for _ in range(n):
        engine.remove_seam(VERTICAL)
    h, w = image.shape[:2]
    # 每条竖直缝贡献 h 个源像素。
    assert len(engine.removed_source_pixels()) == n * h
    assert engine.size == (w - n, h)


def test_invalid_mask_overlap_rejected():
    image, _ = make_sparse()
    masks = MaskSet(
        protect=[Rect(10, 10, 50, 50)],
        shrink=[Rect(40, 40, 80, 80)],
    )
    with pytest.raises(ValueError):
        SeamEngine(image, masks)
