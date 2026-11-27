"""核心逻辑单元测试, 纯无头: python -I bwc/tests/test_core.py"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import numpy as np

from bwc import export as exp
from bwc import morphology as morph
from bwc.pipeline import (
    NoMergeConstraint,
    Project,
    Step,
    StepKind,
    evaluate_constraints,
)
from bwc.sample import make_sample


class TestLabeling(unittest.TestCase):
    def test_basic_components(self):
        mask = np.zeros((10, 10), dtype=bool)
        mask[1:3, 1:3] = True          # 4px 块
        mask[8, 8] = True              # 1px 块
        labels, n = morph.label_components(mask, 8)
        self.assertEqual(n, 2)
        self.assertEqual(set(np.unique(labels)), {0, 1, 2})
        self.assertEqual(int((labels == 1).sum()), 4)
        self.assertEqual(int((labels == 2).sum()), 1)

    def test_diagonal_4_vs_8(self):
        mask = np.zeros((5, 5), dtype=bool)
        mask[1, 1] = True
        mask[2, 2] = True              # 仅对角接触
        _, n4 = morph.label_components(mask, 4)
        _, n8 = morph.label_components(mask, 8)
        self.assertEqual(n4, 2)
        self.assertEqual(n8, 1)

    def test_labels_scan_order_stable(self):
        mask = make_sample() <= 128
        l1, n1 = morph.label_components(mask, 8)
        l2, n2 = morph.label_components(mask, 8)
        self.assertEqual(n1, n2)
        np.testing.assert_array_equal(l1, l2)

    def test_background_same_connectivity(self):
        # 三个对角相接的背景点被墨迹夹住: 4-连通是三个孔, 8-连通合成一个
        mask = np.ones((7, 7), dtype=bool)
        mask[2, 2] = False
        mask[3, 3] = False
        mask[4, 4] = False
        _, h4, _ = morph.find_holes(mask, 4)
        _, h8, stats8 = morph.find_holes(mask, 8)
        self.assertEqual(h4, 3)
        self.assertEqual(h8, 1)
        self.assertEqual(stats8[1]["area"], 3)

    def test_border_background_is_not_hole(self):
        mask = np.zeros((6, 6), dtype=bool)
        mask[1:5, 1:5] = True          # 实心块, 背景全在边缘
        _, n_holes, _ = morph.find_holes(mask, 8)
        self.assertEqual(n_holes, 0)

    def test_enclosed_hole_count(self):
        mask = np.ones((9, 9), dtype=bool)
        mask[3:6, 3:6] = False         # 3x3 封闭孔
        labels, n_holes, stats = morph.find_holes(mask, 8)
        self.assertEqual(n_holes, 1)
        self.assertEqual(stats[1]["area"], 9)
        self.assertEqual(int(labels[4, 4]), 1)


class TestMorphology(unittest.TestCase):
    def test_opening_removes_burr(self):
        mask = np.zeros((9, 9), dtype=bool)
        mask[2:7, 2:7] = True
        mask[1, 4] = True             # 单像素毛刺
        out = morph.opening(mask, 1, 8)
        self.assertFalse(out[1, 4])
        self.assertTrue(out[4, 4])    # 主体保留

    def test_closing_bridges_gap(self):
        mask = np.zeros((9, 9), dtype=bool)
        mask[:, 2:4] = True
        mask[:, 5:7] = True           # 列 4 是 1px 缝隙
        out = morph.closing(mask, 1, 8)
        self.assertTrue(out[:, 4].all())

    def test_remove_small(self):
        mask = np.zeros((10, 10), dtype=bool)
        mask[1:5, 1:5] = True         # 16px
        mask[8, 8] = True             # 1px 孤岛
        out, removed = morph.remove_small_components(mask, 5, 8)
        self.assertFalse(out[8, 8])
        self.assertTrue(out[3, 3])
        self.assertEqual(int(removed[8, 8]), int(morph.label_components(mask, 8)[0][8, 8]))

    def test_radius_zero_is_copy(self):
        mask = np.zeros((4, 4), dtype=bool)
        mask[1, 1] = True
        np.testing.assert_array_equal(morph.opening(mask, 0, 8), mask)
        np.testing.assert_array_equal(morph.closing(mask, 0, 4), mask)

    def test_large_radius_shrinks_and_fills(self):
        # 大半径下: 小实心块被开运算彻底蚀没; 1px 缝隙被闭运算补上
        small = np.zeros((20, 20), dtype=bool)
        small[8:12, 8:12] = True            # 4x4 块
        self.assertFalse(morph.opening(small, 6, 8).any())

        gap = np.zeros((20, 20), dtype=bool)
        gap[:, 5:8] = True
        gap[:, 9:12] = True                # 列 8 是 1px 缝
        self.assertTrue(morph.closing(gap, 3, 8)[5:15, 8].all())
        # 全白输入不会被凭空填上前景
        white = np.zeros((10, 10), dtype=bool)
        self.assertFalse(morph.closing(white, 8, 8).any())

        # 对偶性(图像内部, 不受边界填充影响):
        # 开运算的补 = 对补集做闭运算
        rng = np.random.default_rng(0)
        m = rng.random((20, 20)) > 0.5
        inner = (slice(3, -3), slice(3, -3))
        np.testing.assert_array_equal(
            morph.opening(m, 2, 8)[inner],
            (~morph.closing(~m, 2, 8))[inner])


class TestPipeline(unittest.TestCase):
    def setUp(self):
        self.gray = make_sample()

    def test_threshold_changes_base(self):
        p = Project(self.gray, 128, 8)
        ink_128 = p.current.ink_pixels
        p.set_threshold(50)           # 更严格: 灰色像素不再算黑
        self.assertLessEqual(p.current.ink_pixels, ink_128)
        self.assertEqual(p.cursor, 0)

    def test_connectivity_toggle_changes_counts(self):
        p4 = Project(self.gray, 128, 4)
        p8 = Project(self.gray, 128, 8)
        self.assertNotEqual(p4.current.n_components, p8.current.n_components)
        # 切换后所有版本用新连通性重算
        p4.set_connectivity(8)
        self.assertEqual(p4.current.n_components, p8.current.n_components)

    def test_step_order_changes_result(self):
        steps_a = [Step(StepKind.REMOVE_SMALL, min_size=20),
                   Step(StepKind.CLOSING, radius=1)]
        steps_b = list(reversed(steps_a))
        pa, pb = Project(self.gray, 128, 8), Project(self.gray, 128, 8)
        for s in steps_a:
            pa.add_step(s)
        for s in steps_b:
            pb.add_step(s)
        self.assertNotEqual(pa.current.ink_pixels, pb.current.ink_pixels)

    def test_rollback_restores_stats(self):
        p = Project(self.gray, 128, 8)
        base_n = p.current.n_components
        p.add_step(Step(StepKind.CLOSING, radius=2))
        p.add_step(Step(StepKind.OPENING, radius=1))
        p.rollback(1)
        self.assertEqual(len(p.steps), 1)
        self.assertEqual(p.cursor, 1)
        p.rollback(0)
        self.assertEqual(p.current.n_components, base_n)
        # 撤回后加新步骤会截断旧未来
        p.add_step(Step(StepKind.REMOVE_SMALL, min_size=10))
        self.assertEqual(len(p.versions), 2)

    def test_move_step_replays(self):
        p = Project(self.gray, 128, 8)
        p.add_step(Step(StepKind.OPENING, radius=1))
        p.add_step(Step(StepKind.CLOSING, radius=1))
        first = p.steps[0].kind
        p.move_step(0, 1)
        self.assertNotEqual(p.steps[0].kind, first)
        self.assertEqual(p.cursor, len(p.versions) - 1)

    def test_changed_pixels_consistency(self):
        p = Project(self.gray, 128, 8)
        base = p.current.mask.copy()
        p.add_step(Step(StepKind.CLOSING, radius=1))
        changed = p.current.changed_from_prev
        np.testing.assert_array_equal(changed, p.current.mask != base)
        self.assertEqual(p.current.changed_count, int(changed.sum()))


class TestConstraints(unittest.TestCase):
    def setUp(self):
        self.gray = make_sample()
        self.p = Project(self.gray, 128, 4)
        labels = self.p.current.labels
        # 对角块两块的代表像素(样例中心 140,60 附近)
        self.a = int(labels[135, 55])
        self.b = int(labels[146, 66])
        self.assertTrue(self.a and self.b and self.a != self.b)

    def test_no_merge_violation_after_closing(self):
        self.p.add_no_merge(self.a, self.b)
        self.assertEqual(evaluate_constraints(self.p.current,
                                              self.p.constraints), [])
        self.p.set_connectivity(8)    # 对角算连上 -> 立即合并
        violations = self.p.violations_at()
        self.assertTrue(any(v.kind == "merged" for v in violations))
        v = next(v for v in violations if v.kind == "merged")
        self.assertEqual(len(v.locations), 2)

    def test_vanished_component(self):
        # 选一个 1px 孤岛做禁并, 开运算后它消失
        labels = self.p.current.labels
        ys, xs = np.nonzero(labels > 0)
        one_px = next(
            st["label"] for st in self.p.current.component_stats[1:]
            if st["area"] == 1)
        self.p.add_no_merge(self.a, one_px)
        self.p.add_step(Step(StepKind.OPENING, radius=1))
        kinds = {v.kind for v in self.p.violations_at()}
        self.assertIn("vanished", kinds)

    def test_preserve_hole(self):
        self.p.add_preserve_hole((43, 43, 61, 61))
        self.assertEqual(self.p.violations_at(), [])
        self.p.add_step(Step(StepKind.CLOSING, radius=8))
        violations = self.p.violations_at()
        self.assertTrue(any(v.kind == "hole_filled" for v in violations))
        v = next(v for v in violations if v.kind == "hole_filled")
        self.assertIsNotNone(v.rect)
        self.assertGreater(len(v.locations), 0)

    def test_constraint_survives_threshold_change(self):
        self.p.add_no_merge(self.a, self.b)
        n_before = len(self.p.constraints)
        self.p.set_threshold(100)
        self.assertEqual(len(self.p.constraints), n_before)


class TestExportRoundtrip(unittest.TestCase):
    def test_roundtrip_identical(self):
        p = Project(make_sample(), 128, 8)
        p.add_step(Step(StepKind.OPENING, radius=1))
        p.add_step(Step(StepKind.CLOSING, radius=1))
        p.add_step(Step(StepKind.REMOVE_SMALL, min_size=20))
        with tempfile.TemporaryDirectory() as d:
            base = os.path.join(d, "out")
            paths = exp.export_all(p, base)
            self.assertTrue(all(os.path.exists(x) for x in paths.values()))
            report = exp.verify_roundtrip(p, paths["clean"])
            self.assertTrue(report["ok"], report["mismatches"])
            # 回读统计逐项核对
            rb = report["readback"]
            self.assertEqual(rb["n_components"], p.current.n_components)
            self.assertEqual(rb["ink_pixels"], p.current.ink_pixels)
            for st in p.current.component_stats[1:]:
                self.assertEqual(rb["component_stats"][st["label"]]["area"],
                                 st["area"])

    def test_roundtrip_4_connectivity(self):
        p = Project(make_sample(), 128, 4)
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "c4.png")
            exp.export_clean(p.current, path)
            report = exp.verify_roundtrip(p, path)
            self.assertTrue(report["ok"], report["mismatches"])

    def test_export_is_pure_black_white(self):
        p = Project(make_sample(), 128, 8)
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "pure.png")
            exp.export_clean(p.current, path)
            from PIL import Image
            arr = np.asarray(Image.open(path).convert("L"))
            self.assertEqual(set(np.unique(arr)), {0, 255})


if __name__ == "__main__":
    unittest.main(verbosity=2)
