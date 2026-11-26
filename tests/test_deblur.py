"""去模糊与指标测试。"""

from __future__ import annotations

import numpy as np

from blurlab.deblur import DeblurParams, deblur_image_region, frequency_response_1d, suggested_padding
from blurlab.metrics import gradient_energy, gradient_recovery, residual_stats, unchanged_stats

from conftest import straight_edge_image


def test_deblur_recovers_gradient_on_straight_edge():
    L, theta = 11.0, 0.0
    clean, blurred = straight_edge_image(L, theta, 0.0, shape=(120, 180))
    params = DeblurParams(length_px=L, angle_deg=theta, noise_gain=6.0)
    out, stats = deblur_image_region(blurred, params)
    assert out.shape == blurred.shape
    rec = gradient_recovery(blurred, out, clean)
    assert rec > 0.5, f"梯度恢复率仅 {rec:.2f}"
    assert stats.effective_noise_gain <= 6.0 + 1e-6


def test_noise_gain_cap_is_respected():
    _, blurred = straight_edge_image(9.0, 0.0, 0.0, noise=0.02)
    for cap in (1.5, 3.0, 8.0):
        out, stats = deblur_image_region(
            blurred, DeblurParams(length_px=9.0, angle_deg=0.0, noise_gain=cap)
        )
        assert stats.effective_noise_gain <= cap + 1e-3


def test_overshoot_limits_reduce_clipping():
    clean, blurred = straight_edge_image(13.0, 0.0, 0.0)
    loose, _ = deblur_image_region(
        blurred, DeblurParams(length_px=13.0, angle_deg=0.0, noise_gain=20.0,
                              shadow_limit=0.5, overshoot=0.5)
    )
    tight, stats = deblur_image_region(
        blurred, DeblurParams(length_px=13.0, angle_deg=0.0, noise_gain=20.0,
                              shadow_limit=0.05, overshoot=0.05)
    )
    # 收紧后暗侧过冲应更小
    assert np.min(tight) >= np.min(loose) - 1e-6
    assert stats.shadow_clipped_fraction >= 0.0


def test_deblur_identity_when_no_blur():
    clean, _ = straight_edge_image(0.0, 0.0, 0.0)
    out, _ = deblur_image_region(clean, DeblurParams(length_px=0.0, angle_deg=0.0, noise_gain=1.0))
    # 无模糊时不应大改
    assert np.mean(np.abs(out - clean)) < 0.02


def test_unchanged_stats_zero_for_identical():
    clean, _ = straight_edge_image(5.0, 0.0, 0.0)
    s = unchanged_stats(clean, clean.copy(), (10, 10, 60, 60))
    assert s["rms"] == 0.0
    assert s["frac_over_tol"] == 0.0


def test_residual_stats_concentrate_at_edges():
    clean, blurred = straight_edge_image(11.0, 0.0, 0.0)
    out, _ = deblur_image_region(blurred, DeblurParams(length_px=11.0, angle_deg=0.0))
    rs = residual_stats(blurred, out)
    assert rs.edge_concentration > 0.5
    assert rs.rms > 0


def test_frequency_response_has_zero_and_gain():
    r = frequency_response_1d(DeblurParams(length_px=10.0, angle_deg=0.0), n=256)
    assert r["first_zero_cycles_per_px"] is not None
    assert abs(r["first_zero_cycles_per_px"] - 0.1) < 1e-9
    assert r["noise_gain"] <= 4.0 + 1e-6
    assert r["gain"].shape == r["freq"].shape
    # OTF 在零频为 1，且第一零点附近出现极小值
    assert abs(r["otf"][0] - 1.0) < 0.05
    # 增益在 OTF 零点附近应显著高于低频
    assert np.max(r["gain"]) > r["gain"][0]


def test_padding_covers_psf():
    assert suggested_padding(21.0) >= 10
    assert suggested_padding(0.0) >= 16
