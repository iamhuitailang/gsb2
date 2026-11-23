import cv2
import numpy as np

from focus_stack.fusion import (
    SOURCE_COLORS_BGR,
    edge_regions,
    fuse,
    hard_composite,
    inspect_point,
    soft_composite,
    source_map,
)
from focus_stack.selection import INVALID_LABEL, PinSet, SelectionConfig, compute_labels, soft_weights
from focus_stack.sharpness import sharpness_maps


def _two_layer_images():
    """两张图各有一块清晰区域，检验融合各取所长。"""
    h, w = 60, 60
    a = np.full((h, w, 3), 40, np.uint8)
    b = np.full((h, w, 3), 40, np.uint8)
    cv2.circle(a, (15, 15), 10, (200, 30, 30), -1)          # 左上图只在 a 清晰
    cv2.circle(b, (45, 45), 10, (30, 30, 200), -1)          # 右下图只在 b 清晰
    return [a, b]


def test_hard_and_soft_composite_shapes():
    imgs = _two_layer_images()
    scores = sharpness_maps(imgs)
    valid = np.full(imgs[0].shape[:2], 255, np.uint8)
    labels = compute_labels(scores, valid, [0, 1], PinSet())
    weights = soft_weights(scores, labels, [0, 1], 8.0)
    hard = hard_composite(imgs, labels, valid)
    soft = soft_composite(imgs, weights, valid)
    assert hard.shape == soft.shape == (*imgs[0].shape[:2], 3)
    # 硬合成在标签 0 区域完全等于源 0
    assert (hard[labels == 0] == imgs[0][labels == 0]).all()


def test_fuse_keep_and_crop_coverage():
    imgs = _two_layer_images()
    scores = sharpness_maps(imgs)
    valid = np.full(imgs[0].shape[:2], 255, np.uint8)
    # 人为缩小有效区，模拟覆盖不足
    valid[:8, :] = 0
    labels = compute_labels(scores, valid, [0, 1], PinSet())
    weights = soft_weights(scores, labels, [0, 1], 8.0)

    keep = fuse(imgs, labels, weights, valid, "soft", "keep")
    assert keep.bbox is None
    assert (keep.composite[:8] == 0).all()

    crop = fuse(imgs, labels, weights, valid, "soft", "crop")
    assert crop.bbox is not None
    assert crop.composite.shape[0] == imgs[0].shape[0] - 8


def test_source_map_colors_and_invalid():
    labels = np.zeros((10, 10), np.int32)
    labels[5:, :] = 1
    valid = np.full((10, 10), 255, np.uint8)
    valid[:2, :] = 0
    smap = source_map(labels, 2, valid)
    assert tuple(smap[7, 7]) == SOURCE_COLORS_BGR[1]
    assert (smap[:2] == 0).all()


def test_edge_regions_mark_boundary():
    labels = np.zeros((20, 20), np.int32)
    labels[:, 10:] = 1
    valid = np.full((20, 20), 255, np.uint8)
    edges = edge_regions(labels, valid)
    assert edges[:, 9:12].sum() > 0


def test_inspect_point_reports_chosen_and_ranking():
    imgs = _two_layer_images()
    scores = sharpness_maps(imgs)
    valid = np.full(imgs[0].shape[:2], 255, np.uint8)

    class _Reg:
        class _Item:
            def __init__(self, i):
                self.index = i
                self.status = "ok"
                self.correlation = 0.9
                self.usable = True
        items = [_Item(0), _Item(1)]

    labels = compute_labels(scores, valid, [0, 1], PinSet())
    info = inspect_point(15, 15, labels, scores, [0, 1], imgs, _Reg())
    assert info["chosen"] == labels[15, 15]
    assert len(info["per_source"]) == 2
    # 按相对清晰度降序
    rels = [d["rel_sharpness"] for d in info["per_source"]]
    assert rels == sorted(rels, reverse=True)
    chosen_entry = next(d for d in info["per_source"] if d["chosen"])
    assert chosen_entry["rel_sharpness"] == 1.0
