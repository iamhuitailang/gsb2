import cv2
import numpy as np

from focus_stack.selection import (
    INVALID_LABEL,
    Pin,
    PinSet,
    SelectionConfig,
    argmax_labels,
    compute_labels,
    ghost_map,
    seam_map,
    soft_weights,
)
from focus_stack.sharpness import (
    SharpnessConfig,
    laplacian_variance_map,
    margin_map,
    relative_scores,
)


def test_sharp_maps_higher_on_focused_texture():
    rng = np.random.default_rng(0)
    h, w = 120, 120
    sharp = np.full((h, w), 128, np.uint8)
    cv2.line(sharp, (10, 60), (110, 60), 230, 2)
    for x in range(0, w, 8):
        cv2.line(sharp, (x, 0), (x, h), 60, 1)
    blurry = cv2.GaussianBlur(sharp, (15, 15), 6)
    cfg = SharpnessConfig(window=15)
    s_sharp = laplacian_variance_map(sharp, cfg).mean()
    s_blur = laplacian_variance_map(blurry, cfg).mean()
    assert s_sharp > s_blur * 3


def test_flat_region_selection_is_stable_across_runs():
    # 纯色区所有分数完全相等：argmax 平局固定取编号最小的源，逐次运行确定。
    scores = np.zeros((4, 50, 50), np.float32)
    valid = np.full((50, 50), 255, np.uint8)
    labels_a = argmax_labels(scores, valid, [0, 1, 2, 3])
    labels_b = argmax_labels(scores.copy(), valid, [0, 1, 2, 3])
    assert (labels_a == 0).all()
    assert (labels_b == 0).all()
    # 经过空间平滑后整片保持同一标签
    from focus_stack.selection import _constrained_median_smooth
    pin_mask = np.zeros_like(valid)
    pin_label = np.full(labels_a.shape, INVALID_LABEL, np.int32)
    smoothed = _constrained_median_smooth(
        labels_b, pin_mask, pin_label, SelectionConfig())
    assert (smoothed == 0).all()


def test_pin_forces_region_and_survives_recompute():
    scores = np.random.default_rng(6).random((3, 40, 40)).astype(np.float32)
    valid = np.full((40, 40), 255, np.uint8)
    pins = PinSet()
    pin = Pin.create(source_index=2, shape="rect", coords=[5, 5, 20, 20])
    pins.add(pin)
    cfg = SelectionConfig(smooth_iterations=2)
    labels = compute_labels(scores, valid, [0, 1, 2], pins, cfg)
    # pin 内部（去掉滤波核边界）全部强制为源 2
    assert (labels[8:17, 8:17] == 2).all()

    # 再增一个 pin，旧 pin 内部保持
    pin2 = Pin.create(source_index=1, shape="ellipse", coords=[25, 25, 38, 38])
    pins.add(pin2)
    labels2 = compute_labels(scores, valid, [0, 1, 2], pins, cfg)
    assert (labels2[8:17, 8:17] == 2).all()
    assert (labels2[28:35, 28:35] == 1).all()


def test_remove_pin_keeps_others():
    pins = PinSet()
    p1 = Pin.create(0, "rect", [0, 0, 5, 5], "a")
    p2 = Pin.create(1, "rect", [6, 6, 9, 9], "b")
    pins.add(p1)
    pins.add(p2)
    assert pins.remove(p1.id)
    assert [p.id for p in pins.pins] == [p2.id]
    assert pins.remove("nonexistent") is False


def test_pin_rasterization_shapes():
    rect = Pin.create(0, "rect", [2, 2, 10, 8])
    ell = Pin.create(0, "ellipse", [2, 2, 10, 8])
    poly = Pin.create(0, "polygon", [[0, 0], [9, 0], [9, 9]])
    for p in (rect, ell, poly):
        m = p.rasterize(20, 20)
        assert m.shape == (20, 20)
        assert m.sum() > 0
    assert rect.rasterize_mask_at(5, 5)
    assert not rect.rasterize_mask_at(15, 15)


def test_soft_weights_sum_to_one_and_hard_limit():
    scores = np.random.default_rng(7).random((3, 12, 12)).astype(np.float32) * 100
    labels = np.argmax(scores, axis=0).astype(np.int32)
    valid = np.full((12, 12), 255, np.uint8)
    w = soft_weights(scores, labels, [0, 1, 2], temperature=5.0)
    assert np.allclose(w.sum(axis=0), 1.0, atol=1e-5)
    # 温度趋近 0 时退化为 one-hot
    wh = soft_weights(scores, labels, [0, 1, 2], temperature=1e-3)
    assert np.all((wh > 0.5) == (np.arange(3)[:, None, None] == labels[None]))
    # 无效区权重为 0
    labels[0, 0] = INVALID_LABEL
    w2 = soft_weights(scores, labels, [0, 1, 2], temperature=5.0)
    assert (w2[:, 0, 0] == 0).all()


def test_seam_and_ghost_detect_disagreement():
    labels = np.zeros((20, 20), np.int32)
    labels[:, 10:] = 1
    seam = seam_map(labels, band=2)
    assert seam[:, 8:13].sum() > 0
    assert seam[:, :5].sum() == 0

    aligned = [np.full((20, 20, 3), 50, np.uint8),
               np.full((20, 20, 3), 200, np.uint8)]
    ghost = ghost_map(aligned, labels, [0, 1])
    # 接缝带内应能测到明显颜色差
    assert ghost[seam > 0].mean() > 50


def test_relative_scores_range():
    scores = np.stack([np.full((5, 5), v, np.float32) for v in (10, 20, 5)])
    rel = relative_scores(scores)
    assert np.allclose(rel[1], 1.0)
    assert np.allclose(rel[2], 0.0)
    assert np.all((rel[0] > 0) & (rel[0] < 1))
    assert margin_map(scores).shape == (5, 5)
