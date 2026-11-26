"""PSF 与卷积的约定测试。"""

from __future__ import annotations

import math

import numpy as np

from blurlab import kernel


def test_psf_normalized_and_centered():
    psf = kernel.motion_psf(9.0, 30.0)
    assert psf.shape[0] == psf.shape[1]
    assert abs(psf.sum() - 1.0) < 1e-9
    assert psf.shape[0] % 2 == 1
    # 能量对称：关于核中心 180° 对称
    assert np.allclose(psf, psf[::-1, ::-1], atol=1e-12)


def test_zero_length_is_identity():
    psf = kernel.motion_psf(0.0, 42.0)
    assert psf.shape == (1, 1)
    assert psf[0, 0] == 1.0


def test_psf_length_matches_projection():
    """PSF 沿拖影轴的标准差应接近"连续均匀线段 + 像素面积"的结果。

    理想连续线段的方差是 L²/12；离散到像素网格后每个采样点还会被像素面积
    展宽，额外贡献 1/12（对细线可忽略）。用密集过采样后，误差应在 10% 内。
    """
    for L in (5.0, 9.0, 17.0):
        psf = kernel.motion_psf(L, 0.0)
        r = psf.shape[0] // 2
        xs = np.arange(psf.shape[1]) - r
        w = psf.sum(axis=0)
        mean_x = float((w * xs).sum())
        var_x = float((w * (xs - mean_x) ** 2).sum())
        expected = L * L / 12.0
        assert abs(mean_x) < 0.2
        assert abs(var_x - expected) < 0.12 * expected + 0.2, (L, var_x, expected)


def test_projected_length_physics():
    assert abs(kernel.projected_length(10.0, 30.0, 30.0) - 10.0) < 1e-9
    assert abs(kernel.projected_length(10.0, 0.0, 90.0)) < 1e-9
    expected = 10.0 * math.cos(math.radians(60.0))
    assert abs(kernel.projected_length(10.0, 0.0, 60.0) - expected) < 1e-9


def test_convolve_preserves_constant():
    img = np.full((40, 50, 3), 0.4, dtype=np.float32)
    out = kernel.convolve_same(img, kernel.motion_psf(11.0, 25.0))
    assert out.shape == img.shape
    center = out[10:30, 10:40]
    assert np.allclose(center, 0.4, atol=1e-5)


def test_convolve_energy_and_shape_grayscale():
    rng = np.random.default_rng(0)
    img = rng.random((33, 47)).astype(np.float32)
    psf = kernel.motion_psf(7.0, 135.0)
    out = kernel.convolve_same(img, psf)
    assert out.shape == img.shape
    assert np.isfinite(out).all()


def test_angle_wrap_and_difference():
    assert kernel.wrap_angle(-15.0) == 165.0
    assert abs(kernel.angle_difference(10.0, 170.0) - 20.0) < 1e-9
    assert abs(kernel.angle_difference(0.0, 90.0) - 90.0) < 1e-9


def test_compose_psf_normalized():
    psf = kernel.compose_psf(kernel.motion_psf(9.0, 10.0), kernel.gaussian_psf(0.8))
    assert abs(psf.sum() - 1.0) < 1e-9
