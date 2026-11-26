"""估计器测试：单边依赖、多边联合、置信区间与依赖窗口。"""

from __future__ import annotations

import math

import numpy as np
import pytest

from blurlab import kernel
from blurlab.estimate import estimate_blur, fit_edge_profile
from blurlab.profile import edge_profile_from_segment, sample_edge_profile

from conftest import straight_edge_image


def _profile_for(blurred, center, normal_deg, window_half=22.0):
    return sample_edge_profile(blurred, center, normal_deg, window_half=window_half)


def test_single_edge_recovers_projected_width():
    """拖影沿法向时，投影宽度≈长度。"""
    L = 11.0
    _, blurred = straight_edge_image(L, angle_deg=0.0, normal_deg=0.0)
    prof = _profile_for(blurred, (110, 80), 0.0)
    fit = fit_edge_profile(prof, "e")
    assert abs(fit.width_px - L) < 1.2
    assert fit.normal_deg == 0.0


def test_single_edge_reports_direction_dependence():
    L = 11.0
    # 沿法向拖影
    _, blurred = straight_edge_image(L, angle_deg=0.0, normal_deg=0.0)
    est = estimate_blur([_profile_for(blurred, (110, 80), 0.0)], ["e"])
    assert est.method == "single-edge"
    assert est.angle_deg is None
    assert est.length_px is not None
    assert any("单" in w or "投影" in w for w in est.warnings)
    assert est.dependence.get("relation")
    # 依赖曲线随 Δ 增大而增大
    curve = est.length_curve
    assert curve[0]["length_px"] <= curve[-1]["length_px"]


def test_single_edge_offnormal_scales_inverse_cosine():
    """拖影与法向成 60°：投影宽度约 L·cos60 = L/2。"""
    L = 14.0
    _, blurred = straight_edge_image(L, angle_deg=0.0, normal_deg=60.0)
    prof = _profile_for(blurred, (110, 80), 60.0)
    fit = fit_edge_profile(prof, "e")
    assert abs(fit.width_px - L * math.cos(math.radians(60.0))) < 1.0


def test_two_orthogonal_edges_recover_length_and_flag_mirror():
    """两条正交边能定出长度，但 θ 与 180−θ 投影完全相同 -> 必须报告歧义。"""
    L, theta = 13.0, 20.0
    _, b0 = straight_edge_image(L, angle_deg=theta, normal_deg=0.0)
    _, b1 = straight_edge_image(L, angle_deg=theta, normal_deg=90.0)
    p0 = _profile_for(b0, (110, 80), 0.0)
    p1 = _profile_for(b1, (110, 80), 90.0)
    est = estimate_blur([p0, p1], ["v", "h"])
    assert est.method == "multi-edge"
    assert est.length_px is not None and est.angle_deg is not None
    assert abs(est.length_px - L) < 1.8
    # 估计角应是 theta 或其镜像 180-theta
    mirror = (180.0 - theta) % 180.0
    d = min(kernel.angle_difference(est.angle_deg, theta),
            kernel.angle_difference(est.angle_deg, mirror))
    assert d < 6.0, f"估计方向 {est.angle_deg:.1f}° 既不是 {theta}° 也不是镜像 {mirror}°"
    # 正交边必然留下镜像歧义，必须显式提示
    alts = est.dependence.get("alternative_angles", [])
    assert alts, "正交边应报告镜像等价方向"
    assert any("镜像" in w for w in est.warnings)


def test_three_edges_resolve_mirror_ambiguity():
    """加一条 135° 斜边（不在 0/90 轴系内）即可消除镜像歧义。"""
    L, theta = 13.0, 20.0
    p0 = _profile_for(straight_edge_image(L, theta, 0.0)[1], (110, 80), 0.0)
    p1 = _profile_for(straight_edge_image(L, theta, 90.0)[1], (110, 80), 90.0)
    p2 = _profile_for(straight_edge_image(L, theta, 135.0)[1], (110, 80), 135.0)
    est = estimate_blur([p0, p1, p2], ["v", "h", "d"])
    assert est.method == "multi-edge"
    assert abs(est.length_px - L) < 1.8
    d = kernel.angle_difference(est.angle_deg, theta)
    assert d < 6.0, f"三条边应消除歧义，估计 {est.angle_deg:.1f}° vs 真值 {theta}°"
    assert not est.dependence.get("alternative_angles"), "歧义应已被消除"


def test_two_edges_consistent_projection_model():
    L, theta = 15.0, 35.0
    _, b0 = straight_edge_image(L, angle_deg=theta, normal_deg=0.0)
    _, b1 = straight_edge_image(L, angle_deg=theta, normal_deg=90.0)
    est = estimate_blur(
        [_profile_for(b0, (110, 80), 0.0), _profile_for(b1, (110, 80), 90.0)], ["v", "h"]
    )
    deps = est.dependence["edges"]
    for e in deps:
        assert abs(e["residual_px"]) < 1.5


def test_parallel_normals_fall_back_to_single_edge():
    L = 10.0
    _, b = straight_edge_image(L, angle_deg=0.0, normal_deg=0.0)
    p0 = _profile_for(b, (110, 80), 0.0)
    p1 = _profile_for(b, (110, 60), 0.0)
    est = estimate_blur([p0, p1], ["a", "b"])
    assert est.method == "single-edge"
    assert any("法向过于接近" in w for w in est.warnings)


def test_profile_dependence_window_is_reported():
    _, blurred = straight_edge_image(9.0, 0.0, 0.0)
    prof = _profile_for(blurred, (110, 80), 0.0)
    fit = fit_edge_profile(prof, "e")
    lo, hi = fit.dependence["significant_u_range"] if "significant_u_range" in fit.dependence else (fit.u[0], fit.u[-1])
    # 拟合对象里记录的显著区间应覆盖边心两侧
    payload = fit.to_dict()
    lo, hi = payload["significant_u_range"]
    assert lo < fit.edge_pos < hi


def test_edge_profile_refines_normal():
    """用户拖的方向略有偏差时，结构张量应把法向拉回真实值。"""
    _, blurred = straight_edge_image(0.0, 0.0, 0.0, noise=0.0)
    # 真实竖直边法向 0°；用户跨边拖线略向下倾斜（约偏 20°）
    prof = edge_profile_from_segment(blurred, (90, 70), (130, 90))
    assert kernel.angle_difference(prof.normal_deg, 0.0) < 5.0


def test_flat_profile_raises():
    flat = np.full((80, 80, 3), 0.5, dtype=np.float32)
    prof = sample_edge_profile(flat, (40, 40), 0.0)
    with pytest.raises(ValueError):
        fit_edge_profile(prof, "flat")
