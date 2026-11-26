"""区域、重叠次序与合成测试——需求 5 的核心不变量。"""

from __future__ import annotations

import numpy as np

from blurlab.deblur import DeblurParams
from blurlab.regions import RegionSet, coverage_overlay, normalize_rect


def _solid(value: float, h=80, w=100) -> np.ndarray:
    return np.full((h, w, 3), value, dtype=np.float32)


def _params(L=9.0, angle=0.0) -> DeblurParams:
    return DeblurParams(length_px=L, angle_deg=angle)


def test_normalize_rect_clamps_and_orders():
    assert normalize_rect((70, 60, 10, 20), 100, 80) == (10, 20, 70, 60)
    assert normalize_rect((-30, -20, 500, 500), 100, 80) == (0, 0, 100, 80)


def test_disjoint_regions_blend_independently():
    rs = RegionSet(width=100, height=80)
    a = rs.add((0, 0, 40, 80), _params(), label="A", feather_px=0)
    b = rs.add((60, 0, 100, 80), _params(), label="B", feather_px=0)
    orig = _solid(0.5)
    pa = _solid(0.2)
    pb = _solid(0.8)
    out = rs.blend(orig, {"A": pa, "B": pb})
    assert np.allclose(out[:, :40], 0.2, atol=1e-6)
    assert np.allclose(out[:, 60:], 0.8, atol=1e-6)
    assert np.allclose(out[:, 45:55], 0.5, atol=1e-6)


def test_overlap_later_priority_wins():
    rs = RegionSet(width=100, height=80)
    # priority 小的先处理
    rs.add((0, 0, 60, 80), _params(), label="first", feather_px=0, priority=0)
    rs.add((40, 0, 100, 80), _params(), label="second", feather_px=0, priority=1)
    orig = _solid(0.0)
    out = rs.blend(orig, {"first": _solid(0.3), "second": _solid(0.7)})
    # 重叠区 40..60 由 second 决定
    assert np.allclose(out[:, 45:55], 0.7, atol=1e-6)
    assert np.allclose(out[:, :35], 0.3, atol=1e-6)
    assert np.allclose(out[:, 65:], 0.7, atol=1e-6)


def test_overlap_order_follows_priority_not_insertion():
    rs = RegionSet(width=100, height=80)
    # 先插入高优先级（后处理）的区域，确认次序按 priority 而非插入顺序
    rs.add((40, 0, 100, 80), _params(), label="later", feather_px=0, priority=5)
    rs.add((0, 0, 60, 80), _params(), label="earlier", feather_px=0, priority=1)
    out = rs.blend(_solid(0.0), {"later": _solid(0.9), "earlier": _solid(0.1)})
    assert np.allclose(out[:, 45:55], 0.9, atol=1e-6)


def test_coverage_map_reports_owner_and_count():
    rs = RegionSet(width=100, height=80)
    rs.add((0, 0, 60, 80), _params(), label="A", feather_px=0, priority=0)
    rs.add((40, 0, 100, 80), _params(), label="B", feather_px=0, priority=1)
    owner, count = rs.coverage_map()
    assert owner[10, 10] == 0
    assert owner[10, 80] == 1
    assert owner[10, 50] == 1  # 重叠区归后者
    assert count[10, 50] == 2
    assert count[10, 10] == 1


def test_overlap_report_lists_winner():
    rs = RegionSet(width=100, height=80)
    rs.add((0, 0, 60, 80), _params(), label="A", feather_px=0, priority=0)
    rs.add((40, 0, 100, 80), _params(), label="B", feather_px=0, priority=1)
    rep = rs.overlap_report()
    assert len(rep) == 1
    assert rep[0]["winner"] == "B"
    assert rep[0]["overlap_px"] == 20 * 80


def test_three_way_overlap_deterministic():
    rs = RegionSet(width=100, height=80)
    for i in range(3):
        rs.add((i * 20, 0, i * 20 + 60, 80), _params(), label=f"R{i}", feather_px=0, priority=i)
    out = rs.blend(_solid(0.0), {f"R{i}": _solid(0.1 + 0.3 * i) for i in range(3)})
    # 中心 40..60 三层重叠，最高优先级 R2=0.7
    assert np.allclose(out[:, 45:55], 0.7, atol=1e-6)
    # 20..40 只被 R0,R1 覆盖 -> R1=0.4
    assert np.allclose(out[:, 25:35], 0.4, atol=1e-6)
    # 结果处处有限且在 [0,1]
    assert np.isfinite(out).all()
    assert out.min() >= 0 and out.max() <= 1


def test_feather_blends_smoothly_and_keeps_original_at_borders():
    rs = RegionSet(width=100, height=80)
    rs.add((0, 0, 60, 80), _params(), label="A", feather_px=10, priority=0)
    rs.add((40, 0, 100, 80), _params(), label="B", feather_px=10, priority=1)
    orig = _solid(0.5)
    out = rs.blend(orig, {"A": _solid(0.0), "B": _solid(1.0)})
    assert np.isfinite(out).all()
    row = out[40, :, 0]
    # A 内部（远离羽化带）：完全采用 A
    assert abs(row[30] - 0.0) < 1e-3
    # B 内部：完全采用 B
    assert abs(row[85] - 1.0) < 1e-3
    # 两区域重叠且 B 在此处掩膜为满：B 覆盖 A
    assert abs(row[55] - 1.0) < 1e-3
    # 羽化带内是原图与处理结果的混合，不能超出 [0,1] 且不应是原图的硬切
    assert out.min() >= -1e-6 and out.max() <= 1.0 + 1e-6
    # 最左缘在 A 的羽化起点，权重趋近 0，结果接近原图
    assert abs(row[0] - 0.5) < 1e-3


def test_coverage_overlay_modes():
    rs = RegionSet(width=100, height=80)
    rs.add((0, 0, 60, 80), _params(), label="A", feather_px=0)
    orig = _solid(0.5)
    own = coverage_overlay(orig, rs, mode="owner")
    cnt = coverage_overlay(orig, rs, mode="count")
    assert own.shape == orig.shape and cnt.shape == orig.shape
    assert not np.allclose(own[10, 10], orig[10, 10])  # 覆盖区着色
    assert np.allclose(own[10, 90], orig[10, 90])      # 未覆盖区不变


def test_disabled_region_not_applied():
    rs = RegionSet(width=100, height=80)
    a = rs.add((0, 0, 60, 80), _params(), label="A", feather_px=0)
    rs.add((40, 0, 100, 80), _params(), label="B", feather_px=0, priority=1)
    a.enabled = False
    out = rs.blend(_solid(0.0), {"A": _solid(0.1), "B": _solid(0.9)})
    # A 未启用：仅 B 生效，B 覆盖 40..100，其余保持原图 0
    assert np.allclose(out[:, :40], 0.0, atol=1e-6)
    assert np.allclose(out[:, 40:], 0.9, atol=1e-6)


def test_region_roundtrip_json():
    rs = RegionSet(width=100, height=80)
    r = rs.add((0, 0, 60, 80), DeblurParams(11.0, 30.0, noise_gain=5.0), label="A", priority=2)
    d = r.to_dict()
    from blurlab.regions import Region

    back = Region.from_dict(d)
    assert back.label == "A"
    assert back.params.length_px == 11.0
    assert back.params.angle_deg == 30.0
    assert back.params.noise_gain == 5.0
    assert back.priority == 2
