"""geometry 纯函数单测: 旋转/方形化/fit/crop 的坐标映射与可逆性。"""

import sys
import unittest
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from aspect_tool.geometry import (  # noqa: E402
    build_display_transform, mat_apply, mat_invert, plan_output,
    GeometryPipeline, default_target,
)


def corners(sw, sh):
    return [(0, 0), (sw - 1, 0), (sw - 1, sh - 1), (0, sh - 1)]


class TestRotation(unittest.TestCase):
    def test_cw90_maps_corners(self):
        # ffprobe rotation=-90 -> 显示顺时针 90
        dt = build_display_transform(320, 240, Fraction(1), -90.0)
        self.assertEqual(dt.cw_deg, 90)
        self.assertEqual((dt.dw, dt.dh), (240, 320))
        m = dt.matrix_s_to_d()
        # 存储左上角 -> 显示右上角
        self.assertEqual(mat_apply(m, 0, 0), (239.0, 0.0))
        # 存储右下角 -> 显示左下角
        self.assertEqual(mat_apply(m, 319, 239), (0.0, 319.0))

    def test_180(self):
        dt = build_display_transform(320, 240, Fraction(1), 180.0)
        self.assertEqual(dt.cw_deg, 180)
        m = dt.matrix_s_to_d()
        self.assertEqual(mat_apply(m, 0, 0), (319.0, 239.0))

    def test_ccw90(self):
        dt = build_display_transform(320, 240, Fraction(1), 90.0)
        self.assertEqual(dt.cw_deg, 270)
        m = dt.matrix_s_to_d()
        self.assertEqual(mat_apply(m, 0, 0), (0.0, 319.0))

    def test_roundtrip_all_rotations(self):
        for ccw in (0, -90, 180, 90):
            dt = build_display_transform(320, 240, Fraction(1), float(ccw))
            m = dt.matrix_s_to_d()
            inv = mat_invert(m)
            for p in corners(320, 240):
                back = mat_apply(inv, *mat_apply(m, *p))
                self.assertAlmostEqual(back[0], p[0], places=6)
                self.assertAlmostEqual(back[1], p[1], places=6)


class TestAnamorphic(unittest.TestCase):
    def test_sar_square_size_no_rotation(self):
        dt = build_display_transform(320, 240, Fraction(4, 3), None)
        # 显示宽 = 320 * 4/3 ≈ 426.67 -> 偶数 428, 高不变 240
        self.assertEqual((dt.dw, dt.dh), (428, 240))

    def test_sar_with_rotation(self):
        dt = build_display_transform(320, 240, Fraction(4, 3), -90.0)
        # 换轴: 宽 = 240 / (4/3) = 180, 高 = 320 * 4/3 ≈ 426.67 -> 428
        self.assertEqual((dt.dw, dt.dh), (180, 428))

    def test_sar_roundtrip(self):
        dt = build_display_transform(320, 240, Fraction(4, 3), -90.0)
        m, inv = dt.matrix_s_to_d(), mat_invert(dt.matrix_s_to_d())
        for p in corners(320, 240):
            back = mat_apply(inv, *mat_apply(m, *p))
            self.assertAlmostEqual(back[0], p[0], places=6)
            self.assertAlmostEqual(back[1], p[1], places=6)


class TestPlan(unittest.TestCase):
    def setUp(self):
        self.dt = build_display_transform(320, 240, Fraction(1), -90.0)
        # 显示平面 240x320 (3:4 竖屏)

    def test_fit_keeps_all_visible(self):
        plan = plan_output(self.dt, 360, 640, "fit")
        pipe = GeometryPipeline(self.dt, plan)
        for p in corners(320, 240):
            mp = pipe.map_point_s_to_o(*p)
            self.assertTrue(mp.visible)
        # 显示面 240x320(0.75) 放进 360x640(0.5625): 宽度铺满 360,
        # 高等比缩到 480 -> 上下补黑边
        ax0, ay0, ax1, ay1 = plan.active_box
        self.assertAlmostEqual(ax0, 0.0, places=1)
        self.assertAlmostEqual(ax1, 359.0, places=1)
        self.assertGreater(ay0, 0.5)
        self.assertTrue(plan.letterbox)

    def test_crop_drops_some_points(self):
        plan = plan_output(self.dt, 360, 640, "crop")
        pipe = GeometryPipeline(self.dt, plan)
        results = [pipe.map_point_s_to_o(*p).visible for p in corners(320, 240)]
        # 3:4 内容裁到 9:16, 必然有点落在裁切区外
        self.assertIn(False, results)
        # 输出铺满, 无黑边
        self.assertFalse(plan.letterbox)

    def test_crop_box_centered(self):
        plan = plan_output(self.dt, 360, 640, "crop")
        x0, y0, x1, y1 = plan.crop_box_in_d
        # 高度方向应铺满整个 D (240x320)
        self.assertAlmostEqual(y0, 0.0, places=1)
        self.assertAlmostEqual(y1, 319.0, places=1)
        # 宽度居中裁切
        self.assertAlmostEqual(x0, (240 - (x1 - x0 + 1)) / 2, places=1)

    def test_reverse_map_consistency(self):
        plan = plan_output(self.dt, 360, 640, "fit")
        pipe = GeometryPipeline(self.dt, plan)
        for p in corners(320, 240):
            mp = pipe.map_point_s_to_o(*p)
            sx, sy = pipe.map_point_o_to_s(mp.ox, mp.oy)
            self.assertAlmostEqual(sx, p[0], places=5)
            self.assertAlmostEqual(sy, p[1], places=5)

    def test_default_target_even(self):
        ow, oh = default_target(self.dt)
        self.assertEqual(ow % 2, 0)
        self.assertEqual(oh % 2, 0)


class TestAmbiguity(unittest.TestCase):
    def test_arbitrary_angle_flagged(self):
        dt = build_display_transform(320, 240, Fraction(1), 45.0)
        self.assertFalse(dt.exact_orthogonal)
        self.assertTrue(dt.notes)


class TestFlip(unittest.TestCase):
    def _dt(self, cw, flip):
        # 直接构造, 绕过 ffprobe; 矩阵字段不影响 matrix_s_to_d
        from aspect_tool.geometry import DisplayTransform
        return DisplayTransform(320, 240, cw, flip, Fraction(1))

    def test_flip_only_mirrors_x(self):
        dt = self._dt(0, True)
        m = dt.matrix_s_to_d()
        # 左上角镜像后到右上角
        self.assertEqual(mat_apply(m, 0, 0), (319.0, 0.0))
        # y 不变
        x, y = mat_apply(m, 10, 20)
        self.assertEqual(y, 20.0)

    def test_flip_rotation_roundtrip(self):
        for cw in (0, 90, 180, 270):
            dt = self._dt(cw, True)
            m, inv = dt.matrix_s_to_d(), mat_invert(dt.matrix_s_to_d())
            for p in corners(320, 240):
                back = mat_apply(inv, *mat_apply(m, *p))
                self.assertAlmostEqual(back[0], p[0], places=6)
                self.assertAlmostEqual(back[1], p[1], places=6)

    def test_flip_detection_negative_determinant(self):
        # 镜像矩阵 det<0 应被识别为 flip
        # flip+cw90 的矩阵 (H*R90): 第一行取负 -> (0,-1;-1,0)
        matrix = (0.0, -1.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 1.0)
        dt = build_display_transform(320, 240, Fraction(1), 90.0, matrix)
        self.assertTrue(dt.flip)


if __name__ == "__main__":
    unittest.main(verbosity=2)
