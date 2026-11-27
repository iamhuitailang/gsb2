"""时间映射核心逻辑测试：python3 -m unittest discover -s tests"""

import os
import sys
import unittest
from fractions import Fraction

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from framelab.core.mapping import build_mapping, format_timecode


class TestTimecode(unittest.TestCase):
    def test_integer_fps(self):
        self.assertEqual(format_timecode(0, 30), "00:00:00:00")
        self.assertEqual(format_timecode(29, 30), "00:00:00:29")
        self.assertEqual(format_timecode(30, 30), "00:00:01:00")
        self.assertEqual(format_timecode(3600 * 24 + 5, 24), "01:00:00:05")

    def test_fractional_fps(self):
        fps = Fraction(30000, 1001)  # 29.97
        self.assertEqual(format_timecode(0, fps), "00:00:00:00")
        self.assertEqual(format_timecode(29, fps), "00:00:00:29")
        self.assertEqual(format_timecode(30, fps), "00:00:01:00")


class TestNearestNeighbor(unittest.TestCase):
    def test_30_to_60_each_frame_duplicated(self):
        r = build_mapping(30, 30, 60, method="nearest")
        self.assertEqual(r.stats.out_frame_count, 60)
        kinds = [row.kind for row in r.rows]
        # 每个源帧出现两次，half-up 舍入下第二次落在下一源帧位置上
        self.assertEqual(kinds.count("duplicate"), 30)
        # 末帧钳制使源帧 29 连续出现 3 次（28,29,29,29）
        self.assertEqual(r.stats.max_duplicate_run, 2)
        seq = [row.src_index for row in r.rows[:4]]
        self.assertEqual(seq, [0, 1, 1, 2])
        self.assertEqual(r.rows[0].src_index, 0)
        self.assertEqual(r.rows[1].src_index, 1)
        self.assertEqual(r.rows[2].src_index, 1)

    def test_60_to_30_drops_half(self):
        r = build_mapping(60, 60, 30, method="nearest")
        self.assertEqual(r.stats.out_frame_count, 30)
        self.assertEqual(r.stats.dropped_src_frames, list(range(1, 60, 2)))
        self.assertTrue(all(row.kind != "duplicate" for row in r.rows))
        self.assertEqual(r.rows[0].src_index, 0)
        self.assertEqual(r.rows[1].src_index, 2)

    def test_24_to_30_pulldown_pattern(self):
        # 24→30：每 4 个源帧产生 5 个输出帧，重复节奏 2,3,2,3
        r = build_mapping(24, 24, 30, method="nearest")
        self.assertEqual(r.stats.out_frame_count, 30)
        seq = [row.src_index for row in r.rows[:5]]
        self.assertEqual(seq, [0, 1, 2, 2, 3])
        self.assertEqual(r.stats.duplicate_frames, 6)
        self.assertEqual(r.stats.max_duplicate_run, 1)

    def test_same_fps_identity(self):
        r = build_mapping(25, 100, 25, method="nearest")
        self.assertEqual([row.src_index for row in r.rows], list(range(100)))
        self.assertEqual(r.stats.duplicate_frames, 0)
        self.assertEqual(r.stats.dropped_src_frames, [])

    def test_speed_2x_doubles_rate_halves_duration(self):
        r = build_mapping(30, 30, 30, speed=2, method="nearest")
        self.assertEqual(r.stats.out_frame_count, 15)
        self.assertAlmostEqual(r.stats.out_duration, 0.5)
        # 输出帧采样源帧 0,2,4,...
        self.assertEqual([row.src_index for row in r.rows], list(range(0, 30, 2)))
        self.assertEqual(r.stats.dropped_src_frames, list(range(1, 30, 2)))

    def test_half_speed_repeats(self):
        r = build_mapping(30, 10, 30, speed=0.5, method="nearest")
        self.assertEqual(r.stats.out_frame_count, 20)
        seq = [row.src_index for row in r.rows]
        self.assertEqual(seq, [0, 1, 1, 2, 2, 3, 3, 4, 4, 5,
                               5, 6, 6, 7, 7, 8, 8, 9, 9, 9])
        self.assertEqual(r.stats.max_duplicate_run, 2)  # 末帧被钳制，连续重复 3 次

    def test_12_to_48_long_duplicate_run(self):
        # 12→48：每个源帧连续出现 4 次，后 3 次为重复
        r = build_mapping(12, 12, 48, method="nearest")
        # 末帧钳制：最后一段连续重复 6 次
        self.assertEqual(r.stats.max_duplicate_run, 5)
        self.assertEqual(r.stats.stutter_ratio, 0.75)
        self.assertEqual([row.src_index for row in r.rows[:5]], [0, 0, 1, 1, 1])


class TestBlend(unittest.TestCase):
    def test_blend_weights_30_to_60(self):
        r = build_mapping(30, 30, 60, method="blend")
        self.assertTrue(all(row.kind == "blend" for row in r.rows))
        # 偶数输出帧 weight=0（与源帧对齐），奇数帧 weight=0.5（正中混合）
        self.assertEqual(r.rows[0].blend_weight, 0.0)
        self.assertEqual(r.rows[1].blend_weight, 0.5)
        self.assertEqual(r.rows[2].blend_weight, 0.0)
        self.assertEqual(r.rows[0].src_index, 0)
        self.assertEqual(r.rows[0].src_index_2, 1)
        # 权重 0.5 属于明显拖影区间
        self.assertEqual(r.stats.ghost_frames, 29)
        self.assertEqual(r.stats.blend_frames, 60)

    def test_blend_last_frame_clamped(self):
        r = build_mapping(30, 30, 60, method="blend")
        last = r.rows[-1]
        self.assertEqual(last.src_index, 29)
        self.assertEqual(last.src_index_2, 29)
        self.assertEqual(last.blend_weight, 0.0)

    def test_speed_change_blend(self):
        r = build_mapping(30, 30, 30, speed=2, method="blend")
        # 2 倍速：输出帧 n 对应源坐标 2n，全部精确对齐，weight=0
        self.assertTrue(all(w == 0 for w in (row.blend_weight for row in r.rows)))


class TestVFR(unittest.TestCase):
    def test_vfr_explicit_times_nearest(self):
        # 非均匀 PTS：前两帧间隔 0.5s，后面 0.1s
        times = [0.0, 0.5, 0.6, 0.7, 0.8]
        r = build_mapping(10, 5, 10, method="nearest", src_times=times)
        idxs = [row.src_index for row in r.rows]
        self.assertEqual(idxs[0], 0)      # t=0
        self.assertEqual(idxs[5], 1)      # t=0.5
        self.assertEqual(idxs[6], 2)      # t=0.6

    def test_vfr_blend_uses_real_spacing(self):
        times = [0.0, 0.5, 0.6]
        r = build_mapping(10, 3, 10, method="blend", src_times=times)
        # t=0.25（输出帧 n=2.5 不存在）；用 n=3 → t=0.3，位于帧0/1 之间，权重 0.6
        row = r.rows[3]
        self.assertEqual(row.src_index, 0)
        self.assertEqual(row.src_index_2, 1)
        self.assertAlmostEqual(row.blend_weight, 0.6)
        # 中点 t=0.5 与帧 1 精确对齐
        row_mid = r.rows[5]
        self.assertEqual(row_mid.src_index, 1)
        self.assertEqual(row_mid.blend_weight, 0.0)


class TestInverseIndex(unittest.TestCase):
    def test_src_to_out_coverage(self):
        r = build_mapping(24, 24, 30, method="nearest")
        # 每个源帧至少被一个输出帧引用（24→30 无丢帧）
        self.assertEqual(sorted(r.src_to_out), list(range(24)))
        self.assertEqual(r.src_to_out[1], [1])
        self.assertEqual(r.src_to_out[2], [2, 3])  # 源帧 2 被输出帧 2、3 引用

    def test_jump_back_positions(self):
        r = build_mapping(30, 30, 60, method="nearest")
        # 给定输出帧 5，可反查源帧位置
        row = r.rows[5]
        self.assertIn(5, r.src_to_out[row.src_index])


class TestValidation(unittest.TestCase):
    def test_bad_method(self):
        with self.assertRaises(ValueError):
            build_mapping(30, 10, 30, method="weave")

    def test_bad_params(self):
        with self.assertRaises(ValueError):
            build_mapping(30, 0, 30)
        with self.assertRaises(ValueError):
            build_mapping(30, 10, 0)
        with self.assertRaises(ValueError):
            build_mapping(30, 10, 30, speed=0)


if __name__ == "__main__":
    unittest.main()
