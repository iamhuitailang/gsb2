"""标定/换算/可靠区间的单元测试（不依赖真实视频文件）。"""

import unittest
from types import SimpleNamespace

from proxylink.errors import CalibrationError, OutOfRangeError
from proxylink.mapping import Anchor, Mapping


def fake_media(duration, fps=24.0):
    return SimpleNamespace(duration=duration, fps=fps)


ORIGINAL = fake_media(10.0, 24.0)


class TestSingleAnchor(unittest.TestCase):

    def test_identity_mapping(self):
        m = Mapping.build(ORIGINAL, fake_media(10.0), [Anchor(0, 0)])
        self.assertEqual(m.rate, 1.0)
        self.assertAlmostEqual(m.proxy_to_original(3.0), 3.0)
        self.assertAlmostEqual(m.original_to_proxy(3.0), 3.0)

    def test_offset_anchor(self):
        # 代理缺头：代理 0s 对应原片 2s
        m = Mapping.build(ORIGINAL, fake_media(8.0), [Anchor(2.0, 0.0)])
        self.assertAlmostEqual(m.proxy_to_original(0.0), 2.0)
        self.assertAlmostEqual(m.proxy_to_original(5.0), 7.0)
        self.assertAlmostEqual(m.original_to_proxy(2.0), 0.0)

    def test_out_of_range_head_and_tail(self):
        # 代理缺头：想从原片 0s 换过去 -> 代理时间为负，必须报错停止
        m = Mapping.build(ORIGINAL, fake_media(8.0), [Anchor(2.0, 0.0)])
        with self.assertRaises(OutOfRangeError) as ctx:
            m.original_to_proxy(0.0)
        self.assertIn("早于素材起点", str(ctx.exception))

        # 代理缺尾：代理只有 8s，把代理时间推到其末尾之后 -> 原片画面不存在
        m2 = Mapping.build(ORIGINAL, fake_media(8.0), [Anchor(0.0, 0.0)])
        with self.assertRaises(OutOfRangeError) as ctx:
            m2.proxy_to_original(8.5)
        self.assertIn("超出", str(ctx.exception))

    def test_clamp_instead_of_raise(self):
        m = Mapping.build(ORIGINAL, fake_media(8.0), [Anchor(2.0, 0.0)])
        self.assertEqual(m.original_to_proxy(0.0, clamp=True), 0.0)


class TestTwoAnchor(unittest.TestCase):

    def test_rate_from_two_points(self):
        # 代理走时是原片的一半（fps 12 vs 24）
        proxy = fake_media(5.0, 12.0)
        m = Mapping.build(ORIGINAL, proxy, [Anchor(0, 0), Anchor(4.0, 2.0)])
        self.assertAlmostEqual(m.rate, 2.0)
        self.assertAlmostEqual(m.proxy_to_original(1.0), 2.0)
        self.assertAlmostEqual(m.original_to_proxy(4.0), 2.0)

    def test_identical_points_rejected(self):
        with self.assertRaises(CalibrationError):
            Mapping.build(ORIGINAL, fake_media(10.0), [Anchor(1.0, 1.0), Anchor(1.0, 1.0)])

    def test_rate_inconsistent_with_fps_rejected(self):
        # rate=4 与 fps 之比 1.0 严重不符 -> 锚点标错
        with self.assertRaises(CalibrationError):
            Mapping.build(ORIGINAL, fake_media(10.0, 24.0),
                          [Anchor(0, 0), Anchor(4.0, 1.0)])

    def test_anchor_outside_duration_rejected(self):
        with self.assertRaises(CalibrationError):
            Mapping.build(ORIGINAL, fake_media(5.0), [Anchor(0, 0), Anchor(8.0, 4.0)])

    def test_no_anchor_rejected(self):
        with self.assertRaises(CalibrationError):
            Mapping.build(ORIGINAL, fake_media(10.0), [])


class TestCoverage(unittest.TestCase):

    def test_full_coverage(self):
        m = Mapping.build(ORIGINAL, fake_media(10.0), [Anchor(0, 0)])
        cov = m.coverage()
        self.assertTrue(cov["head_match"]["aligned"])
        self.assertTrue(cov["tail_match"]["aligned"])
        rel = cov["original"]["reliable_range"]
        self.assertAlmostEqual(rel[0], 0.0)
        self.assertAlmostEqual(rel[1], 10.0)
        self.assertEqual(sum(u["seconds"] for u in cov["original"]["unreachable"]), 0.0)

    def test_short_proxy_missing_tail(self):
        m = Mapping.build(ORIGINAL, fake_media(8.0), [Anchor(0, 0)])
        cov = m.coverage()
        self.assertTrue(cov["head_match"]["aligned"])
        self.assertFalse(cov["tail_match"]["aligned"])
        self.assertAlmostEqual(cov["tail_match"]["original_missing_tail_seconds"], 2.0)
        self.assertEqual(cov["tail_match"]["original_missing_tail_frames"], 48)
        rel = cov["original"]["reliable_range"]
        self.assertAlmostEqual(rel, [0.0, 8.0])

    def test_headshift_proxy_missing_head(self):
        m = Mapping.build(ORIGINAL, fake_media(8.0), [Anchor(2.0, 0.0)])
        cov = m.coverage()
        self.assertFalse(cov["head_match"]["aligned"])
        self.assertAlmostEqual(
            cov["head_match"]["original_missing_head_seconds"], 2.0)
        self.assertEqual(cov["head_match"]["original_missing_head_frames"], 48)
        # 代理 8s 覆盖原片 2s..10s，尾部恰好对齐
        self.assertTrue(cov["tail_match"]["aligned"])
        rel = cov["original"]["reliable_range"]
        self.assertAlmostEqual(rel[0], 2.0)
        self.assertAlmostEqual(rel[1], 10.0)

    def test_locate_status(self):
        m = Mapping.build(ORIGINAL, fake_media(8.0), [Anchor(0, 0)])
        ok = m.locate("original", 5.0)
        self.assertTrue(ok["ok"])
        bad = m.locate("original", 9.0)
        self.assertFalse(bad["ok"])
        self.assertIn("停止", bad["reason"])


class TestFrameSnapping(unittest.TestCase):

    def test_result_snaps_to_frame(self):
        m = Mapping.build(ORIGINAL, fake_media(10.0), [Anchor(0, 0)])
        # 1/3 秒不是帧边界，结果应吸附到最近帧
        out = m.original_to_proxy(1.0 / 3.0)
        self.assertAlmostEqual(out, round((1.0 / 3.0) * 24) / 24)


if __name__ == "__main__":
    unittest.main()
