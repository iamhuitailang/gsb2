"""换档决策纯逻辑测试（不依赖 ffmpeg，用手工构造的 manifest）。"""

import unittest

from sebalign.switching import assert_no_replay, decide_switch

FPS = 10.0


def seg(seq, start, end, label=None, openable=True):
    return {
        "seq": seq,
        "source_start": float(start),
        "source_end": float(end),
        "frame_label": label or f"src1/f{int(start * FPS):03d}",
        "openable": openable,
        "file": f"tier/seg_{seq:03d}.mp4",
    }


def manifest_with(low_segs, high_segs):
    def tier(name, segs):
        return {"name": name, "segments": segs}
    return {
        "source_fps": FPS,
        "source_duration": 10.0,
        "tiers": [tier("low", low_segs), tier("high", high_segs)],
    }


class SwitchDecisionTest(unittest.TestCase):
    def setUp(self):
        # 两档共享 2s/4s/6s/8s 边界，首帧标签一致
        cuts = [0, 2, 4, 6, 8, 10]
        segs = [seg(i, a, b) for i, (a, b) in enumerate(zip(cuts, cuts[1:]))]
        self.m = manifest_with(segs, [dict(s, file=f"high/seg_{s['seq']:03d}.mp4") for s in segs])

    def test_switch_on_shared_boundary(self):
        d = decide_switch(self.m, "low", "high", 4.0)
        self.assertEqual(d.verdict, "switch_now")
        self.assertEqual(d.target_frame_label, "src1/f040")

    def test_switch_inside_segment_must_wait(self):
        d = decide_switch(self.m, "low", "high", 3.0)
        self.assertEqual(d.verdict, "wait")
        self.assertAlmostEqual(d.candidate_time, 4.0)
        self.assertAlmostEqual(d.wait_seconds, 1.0)

    def test_wait_points_at_nearest_forward_boundary(self):
        # 4.25 已超出一帧容差(0.15s)，不再算落在 4.0 边界上
        d = decide_switch(self.m, "low", "high", 4.25)
        self.assertEqual(d.verdict, "wait")
        self.assertAlmostEqual(d.candidate_time, 6.0)

    def test_no_shared_boundary_after_position_aborts(self):
        d = decide_switch(self.m, "low", "high", 9.5)
        self.assertEqual(d.verdict, "abort")

    def test_replay_is_rejected_when_target_boundary_starts_earlier(self):
        # 边界时间在一帧容差内对齐、首帧标签一致，但目标段记录的源起点
        # 早于当前位置（损坏/错配索引）：从段头开播就会重播，必须拒绝
        low = [seg(0, 0, 5), seg(1, 5, 10)]
        high = [
            seg(0, 0, 5),
            {**seg(1, 5, 10), "source_start": 4.9, "source_end": 10.0},
        ]
        m = manifest_with(low, high)
        d = decide_switch(m, "low", "high", 5.0)
        self.assertEqual(d.verdict, "abort")
        self.assertTrue(d.replay_rejected)

    def test_intra_segment_switch_is_not_mistaken_for_replay(self):
        # 档内时刻（非边界）目标段起点早于当前时间是正常的：seek 到段内偏移即可
        d = decide_switch(self.m, "low", "high", 3.0)
        self.assertEqual(d.verdict, "wait")
        self.assertFalse(d.replay_rejected)

    def test_unreadable_target_aborts(self):
        high = [dict(s, openable=False) if s["seq"] == 2 else s for s in self.m["tiers"][1]["segments"]]
        m = manifest_with(self.m["tiers"][0]["segments"], high)
        d = decide_switch(m, "low", "high", 4.0)  # 边界 4.0 对应 high seq 2
        self.assertEqual(d.verdict, "abort")
        self.assertIn("不可读", d.reason)

    def test_mismatched_boundaries_force_wait_or_abort(self):
        # low 每 2s 切，high 每 3s 切，没有任何共享边界
        low = [seg(i, a, b) for i, (a, b) in enumerate(zip([0, 2, 4, 6, 8], [2, 4, 6, 8, 10]))]
        high_cuts = [0, 3, 6, 9, 10]
        high = [seg(i, a, b, label=f"src1/f{int(a * FPS):03d}")
                for i, (a, b) in enumerate(zip(high_cuts, high_cuts[1:]))]
        m = manifest_with(low, high)
        d = decide_switch(m, "low", "high", 1.0)
        # 6.0 两边都有边界且标签一致 → 允许等待；其余点不行
        self.assertIn(d.verdict, {"wait", "abort"})

    def test_assert_no_replay_gate(self):
        reason = assert_no_replay(self.m, "high", 5.0, 3.0)
        self.assertIsNotNone(reason)
        self.assertIn("拒绝重播", reason)
        self.assertIsNone(assert_no_replay(self.m, "high", 5.0, 6.0))

    def test_frame_label_mismatch_on_shared_time_aborts(self):
        high = [dict(s) for s in self.m["tiers"][1]["segments"]]
        high[2]["frame_label"] = "src1/f039"  # 4.0s 处标签被改坏
        m = manifest_with(self.m["tiers"][0]["segments"], high)
        d = decide_switch(m, "low", "high", 4.0)
        self.assertEqual(d.verdict, "abort")


if __name__ == "__main__":
    unittest.main()
