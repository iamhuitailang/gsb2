"""标定与斜坐标几何测试。"""
import math

import numpy as np

from core.geometry import Calibration, Ruler, calibration_from_dict


def _axis_aligned_calib(scale=10.0, shape=(1000, 1300)):
    # 原点 (180, 880)，横尺向右 100mm，纵尺向上 70mm（v 向上为正）
    h = Ruler((180, 880), (180 + 100 * scale, 880), 100.0, "横尺")
    v = Ruler((180, 880), (180, 880 - 70 * scale), 70.0, "纵尺")
    return Calibration(h, v, shape)


def test_roundtrip_pixel_mm_identity():
    calib = _axis_aligned_calib()
    rng = np.random.default_rng(0)
    uv = np.column_stack([
        rng.uniform(0, 90, 50), rng.uniform(0, 60, 50)
    ])
    px = calib.to_pixel(uv)
    back = calib.to_mm_xy(px)
    assert np.allclose(uv, back, atol=1e-9)


def test_known_point_coordinates():
    calib = _axis_aligned_calib()
    # (u=35, v=32) mm 应落在像素 (180+350, 880-320)
    px = calib.to_pixel(np.array([[35.0, 32.0]]))[0]
    assert np.allclose(px, [530.0, 560.0], atol=1e-9)


def test_mm_per_pixel_and_distance():
    calib = _axis_aligned_calib()
    assert math.isclose(calib.horizontal.mm_per_pixel(), 0.1, rel_tol=1e-12)
    d = calib.distance_mm((0, 0), (100, 0))
    assert math.isclose(d, 10.0, rel_tol=1e-9)
    d2 = calib.distance_mm((0, 0), (30, 40))
    assert math.isclose(d2, 5.0, rel_tol=1e-9)


def test_skewed_rulers_nonorthogonal():
    # 纵尺倾斜 20°，仿射基必须仍可逆且往返一致
    scale = 10.0
    a = math.radians(20)
    h = Ruler((180, 880), (180 + 100 * scale, 880), 100.0)
    v_end = (180 + math.sin(a) * -70 * scale,
             880 + math.cos(a) * -70 * scale)
    v = Ruler((180, 880), v_end, 70.0)
    calib = Calibration(h, v, (1000, 1300))

    assert not math.isclose(calib.quality["ruler_angle_deg"], 90.0, abs_tol=1e-6)
    rng = np.random.default_rng(1)
    uv = np.column_stack([
        rng.uniform(0, 80, 40), rng.uniform(0, 50, 40)
    ])
    back = calib.to_mm_xy(calib.to_pixel(uv))
    assert np.allclose(uv, back, atol=1e-9)


def test_valid_polygon_contains_measured_points():
    calib = _axis_aligned_calib()
    inside = calib.to_pixel(np.array([[10.0, 10.0], [50.0, 50.0]]))
    assert calib.points_inside_fraction(inside) == 1.0
    outside = calib.to_pixel(np.array([[150.0, 100.0]]))
    assert calib.points_inside_fraction(outside) == 0.0
    assert len(calib.polygon_outside_parts(outside)) == 1


def test_serialization_roundtrip():
    calib = _axis_aligned_calib()
    restored = calibration_from_dict(calib.to_dict())
    uv = np.array([[12.5, 33.3]])
    assert np.allclose(restored.to_pixel(uv), calib.to_pixel(uv), atol=1e-9)


def test_parallel_rulers_fallback_no_crash():
    # 两根近乎平行的尺不应抛异常，退化为中点原点
    h = Ruler((0, 0), (100, 0), 10.0)
    v = Ruler((0, 1), (100, 1), 10.0)
    calib = Calibration(h, v, (500, 500))
    assert calib.origin.shape == (2,)
