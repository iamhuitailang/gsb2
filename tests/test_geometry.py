import numpy as np
import pytest

from focus_stack.geometry import (
    common_coverage,
    compose,
    coverage_mask,
    crop_to_mask,
    identity,
    invert_affine,
    mask_bounding_box,
    warp_image,
)


def test_invert_affine_roundtrip():
    rng = np.random.default_rng(0)
    m = np.array([[1.04, 0.02, 3.1], [-0.03, 0.97, -2.4]])
    inv = invert_affine(m)
    prod = compose(m, inv)
    assert np.allclose(prod, identity(), atol=1e-10)


def test_warp_and_coverage_consistency():
    h, w = 60, 80
    img = np.full((h, w, 3), 128, np.uint8)
    m = np.array([[1.0, 0.0, 7.0], [0.0, 1.0, -5.0]])
    warped = warp_image(img, m, (h, w), border_value=0)
    cov = coverage_mask(m, img.shape[:2], (h, w))
    # 覆盖区内 warp 结果有像素，区外为 0
    assert (warped[cov > 0] == 128).all()
    assert (warped[cov == 0] == 0).all()


def test_common_coverage_and_crop():
    shape = (50, 50)
    m1 = np.array([[1, 0, 4], [0, 1, 0]], np.float64)
    m2 = np.array([[1, 0, -4], [0, 1, 0]], np.float64)
    c1 = coverage_mask(m1, shape, shape)
    c2 = coverage_mask(m2, shape, shape)
    common = common_coverage([c1, c2])
    bbox = mask_bounding_box(common)
    assert bbox is not None
    x0, y0, x1, y1 = bbox
    # 左右各切掉 4px 平移的交集
    assert x0 == 4 and x1 == 46
    img = np.zeros(shape, np.uint8)
    cropped, mcrop, b2 = crop_to_mask(img, common)
    assert cropped.shape == (y1 - y0, x1 - x0)
    assert b2 == bbox
