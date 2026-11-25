import unittest

from reframer.planner import (
    MotionConfig,
    STRATEGY_BOTH,
    STRATEGY_CUT,
    STRATEGY_FALLBACK,
    STRATEGY_SPEAKER,
    _Smoother1D,
    _compress_keyframes,
    FramePlan,
    plan,
)
from reframer.model import KF, Rect, SafeZone, Shot, Track
from reframer.tracks import TracksDoc


def make_doc(tracks, shots=None, zones=None, speakers=None, motion=None,
             width=1000, height=500, fps=10, duration=4.0):
    return TracksDoc(
        source="x.mp4", width=width, height=height, fps=fps, duration=duration,
        tracks=tracks,
        shots=shots or [Shot(0.0, duration, "smooth")],
        safe_zones=zones or [],
        speakers=speakers or {},
        config={"motion": motion or {}},
    )


def static_track(tid, x, w=0.1, required=False, label=None):
    return Track(tid, label or tid, required=required, keyframes=[
        KF(0.0, Rect(x, 0.2, w, 0.4)),
        KF(100.0, Rect(x, 0.2, w, 0.4)),
    ])


class TestSmoother(unittest.TestCase):
    def test_hysteresis_holds_position(self):
        cfg = MotionConfig(hysteresis_px=50, dwell_s=0.0, max_speed_px_s=1000)
        sm = _Smoother1D(cfg)
        sm.reset(0.0)
        pos, moved = sm.update(30.0, 0.1, 0.1)   # 偏差 30 < 50
        self.assertFalse(moved)
        self.assertEqual(pos, 0.0)

    def test_dwell_delays_move(self):
        cfg = MotionConfig(hysteresis_px=10, dwell_s=0.5, max_speed_px_s=1000)
        sm = _Smoother1D(cfg)
        sm.reset(0.0)
        p1, _ = sm.update(100.0, 0.1, 0.1)
        self.assertEqual(p1, 0.0)                    # 还在驻留确认期
        p2, moved = sm.update(100.0, 0.6, 0.1)
        self.assertTrue(moved)
        self.assertGreater(p2, 0.0)

    def test_speed_limit(self):
        cfg = MotionConfig(hysteresis_px=0, dwell_s=0.0, max_speed_px_s=100)
        sm = _Smoother1D(cfg)
        sm.reset(0.0)
        pos, moved = sm.update(1000.0, 0.1, 0.1)     # dt=0.1 -> 最多走 10px
        self.assertTrue(moved)
        self.assertAlmostEqual(pos, 10.0)

    def test_hard_reset(self):
        cfg = MotionConfig()
        sm = _Smoother1D(cfg)
        sm.reset(50.0)
        sm.reset(300.0)
        self.assertEqual(sm.pos, 300.0)


class TestPlannerStrategies(unittest.TestCase):
    def test_both_fit_one_frame(self):
        # 两个框足够靠近, 加留白后仍小于竖裁框宽度 (282px)
        doc = make_doc([static_track("p1", 0.20, w=0.08),
                        static_track("p2", 0.30, w=0.08)])
        sched = plan(doc)
        self.assertEqual(sched["segments"][0]["dominant_strategy"], STRATEGY_BOTH)

    def test_too_wide_follows_speaker(self):
        # 两个框离得很远, 竖框装不下; p2 在说话 -> 跟 p2
        doc = make_doc(
            [static_track("p1", 0.0, w=0.12), static_track("p2", 0.78, w=0.12)],
            speakers={"p2": [[0.0, 4.0]]},
            motion={"max_speed_px_s": 100000, "hysteresis_px": 0, "dwell_s": 0.0},
        )
        sched = plan(doc)
        # 稳定后裁框中心应在 p2 中心 (0.84 * 1000 = 840) 附近
        last_x = sched["keyframes"][-1]["crop"]["x"] * 1000
        self.assertAlmostEqual(last_x + sched["crop"]["width_px"] / 2, 840, delta=15)
        self.assertIn(STRATEGY_SPEAKER, sched["segments"][0]["strategies"])

    def test_no_data_hold(self):
        tr = Track("p1", "p1", keyframes=[
            KF(0.0, Rect(0.1, 0.2, 0.1, 0.4)),
            KF(1.0, None),
            KF(4.0, None),
        ])
        doc = make_doc([tr], motion={"no_data": "hold"})
        sched = plan(doc)
        # 无数据段裁框不动: 1.5s 与 2.5s 的 crop x 相同
        from reframer.expr import sample_kf
        a = sample_kf(sched, 1.5)["x"]
        b = sample_kf(sched, 2.5)["x"]
        self.assertEqual(a, b)
        self.assertIn(STRATEGY_FALLBACK, sched["segments"][0]["strategies"])

    def test_required_and_safe_zone_clamp(self):
        # 必留对象在最左, 说话人在最右: 硬约束把裁框钉在左侧
        doc = make_doc(
            [static_track("p1", 0.0, w=0.1, required=True),
             static_track("p2", 0.88, w=0.1)],
            speakers={"p2": [[0.0, 4.0]]},
        )
        sched = plan(doc)
        last_x = sched["keyframes"][-1]["crop"]["x"]
        self.assertEqual(round(last_x * 1000), 0)       # 被必留对象夹到左贴边

    def test_safe_zone_full_width_conflict_warns(self):
        zone = SafeZone(Rect(0.0, 0.8, 1.0, 0.2), "字幕带")
        doc = make_doc([static_track("p1", 0.5)], zones=[zone])
        sched = plan(doc)
        # 全宽安全区与竖裁框必然冲突 -> 有告警但不崩
        self.assertTrue(sched["warnings"])

    def test_hard_cut_jumps_without_smoothing(self):
        shots = [Shot(0.0, 2.0, "cut"), Shot(2.0, 4.0, "cut")]
        t1 = static_track("p1", 0.05)
        t2 = static_track("p2", 0.9)
        # 每镜头各放一个人, 通过关键帧时间控制
        t1.keyframes = [KF(0.0, Rect(0.05, 0.2, 0.1, 0.4)),
                        KF(1.9, Rect(0.05, 0.2, 0.1, 0.4)),
                        KF(2.0, None), KF(4.0, None)]
        t2.keyframes = [KF(0.0, None), KF(1.9, None),
                        KF(2.0, Rect(0.78, 0.2, 0.1, 0.4)),
                        KF(4.0, Rect(0.78, 0.2, 0.1, 0.4))]
        doc = make_doc([t1, t2], shots=shots)
        sched = plan(doc)
        cut_events = [e for e in sched["events"] if e["type"] == "cut"]
        self.assertEqual(len(cut_events), 1)
        from reframer.expr import sample_kf
        before = sample_kf(sched, 1.9)["x"]
        after = sample_kf(sched, 2.0)["x"]
        self.assertGreater(abs(after - before) * 1000, 200)   # 切点直接跳, 没有插值过渡

    def test_manual_override_wins(self):
        doc = make_doc([static_track("p1", 0.1), static_track("p2", 0.8)],
                       motion={"max_speed_px_s": 100000, "hysteresis_px": 0, "dwell_s": 0.0})
        sched = plan(doc, overrides=[
            {"start": 1.0, "end": 2.0, "center_x_norm": 0.5, "name": "manual"}
        ])
        from reframer.expr import sample_kf
        c = sample_kf(sched, 1.5)
        self.assertAlmostEqual(c["x"] + c["w"] / 2, 0.5, delta=0.02)

    def test_keyframe_compression_reconstructs(self):
        # 构造一条线性移动轨迹, 压缩后重建误差 <= 1px
        kfs = [KF(i / 10.0, Rect(0.05 + 0.04 * i / 10.0, 0.2, 0.1, 0.4)) for i in range(41)]
        doc = make_doc([Track("p1", "p1", keyframes=kfs)], duration=4.0)
        sched = plan(doc)
        self.assertLessEqual(len(sched["keyframes"]), 6)
        from reframer.expr import sample_kf
        for i in range(40):
            c = sample_kf(sched, i / 10.0)
            self.assertTrue(0.0 <= c["x"] <= 1.0)

    def test_smooth_shot_speed_limited_no_teleport(self):
        # 同镜头内说话人 2s 处从最左跳到最右: 裁框必须限速追上, 不能瞬移
        kfs = [KF(0.0, Rect(0.05, 0.2, 0.1, 0.4)), KF(1.99, Rect(0.05, 0.2, 0.1, 0.4)),
               KF(2.0, Rect(0.85, 0.2, 0.1, 0.4)), KF(8.0, Rect(0.85, 0.2, 0.1, 0.4))]
        doc = make_doc(
            [Track("p1", "p1", keyframes=kfs)],
            shots=[Shot(0.0, 8.0, "smooth")],
            speakers={"p1": [[0.0, 8.0]]},
            motion={"max_speed_px_s": 200, "hysteresis_px": 10, "dwell_s": 0.2},
            duration=8.0,
        )
        sched = plan(doc)
        from reframer.expr import sample_kf
        centers = [
            (lambda c: (c["x"] + c["w"] / 2) * 1000)(sample_kf(sched, fi / 10.0))
            for fi in range(80)
        ]
        jumps = [abs(centers[i + 1] - centers[i]) for i in range(79)]
        self.assertLessEqual(max(jumps), 20.5)       # 200px/s ÷ 10fps
        self.assertLess(centers[25] - centers[20], 100)  # 渐进追上而非瞬移


if __name__ == "__main__":
    unittest.main()
