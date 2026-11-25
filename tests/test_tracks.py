import math
import unittest

from reframer.model import KF, Rect, Track
from reframer.tracks import rect_at


class TestInterp(unittest.TestCase):
    def test_linear_interpolation(self):
        tr = Track("p", "p", keyframes=[
            KF(0.0, Rect(0.0, 0.0, 0.1, 0.2)),
            KF(1.0, Rect(0.5, 0.2, 0.1, 0.2)),
        ])
        r = rect_at(tr, 0.5)
        self.assertAlmostEqual(r.x, 0.25)
        self.assertAlmostEqual(r.y, 0.1)
        self.assertAlmostEqual(r.w, 0.1)

    def test_null_gap_returns_none(self):
        tr = Track("p", "p", keyframes=[
            KF(0.0, Rect(0.0, 0.0, 0.1, 0.1)),
            KF(1.0, None),
            KF(2.0, Rect(0.4, 0.0, 0.1, 0.1)),
        ])
        self.assertIsNone(rect_at(tr, 1.0))
        self.assertIsNone(rect_at(tr, 1.5))
        # null 关键帧的语义是"从该时刻起消失", 直到下一个非 null 帧
        self.assertIsNone(rect_at(tr, 0.99))
        self.assertIsNotNone(rect_at(tr, 2.0))

    def test_out_of_range_clamps(self):
        tr = Track("p", "p", keyframes=[
            KF(1.0, Rect(0.1, 0.0, 0.1, 0.1)),
            KF(2.0, Rect(0.2, 0.0, 0.1, 0.1)),
        ])
        self.assertEqual(rect_at(tr, 0.0).x, 0.1)
        self.assertEqual(rect_at(tr, 9.0).x, 0.2)

    def test_rect_validation(self):
        with self.assertRaises(ValueError):
            Rect(0.9, 0.0, 0.2, 0.1).validate()
        with self.assertRaises(ValueError):
            Rect(0.0, 0.0, 0.0, 0.1).validate()


if __name__ == "__main__":
    unittest.main()
