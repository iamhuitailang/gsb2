"""单元测试：python3 -m unittest discover -s tests"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np

from slicer.detection import (ABSENT, PRESENT, UNCERTAIN, DetectionResult,
                              EdgeSeg)
from slicer.geometry import (RotationInfo, original_to_rectified,
                             rectified_to_original)
from slicer.grid import GridModel


def make_seg(state, confidence="high", support=0.9, gap=0):
    return EdgeSeg(state, confidence, support, gap)


def make_detection(n_rows=3, n_cols=3, absent_edges=None):
    """构造一个 n_rows x n_cols 的检测结果，absent_edges 指定无边段。"""
    absent_edges = absent_edges or set()
    xs = [float(c * 100) for c in range(n_cols + 1)]
    ys = [float(r * 80) for r in range(n_rows + 1)]
    det = DetectionResult(xs=xs, ys=ys, table_bbox=(0, 0, xs[-1], ys[-1]))
    for iy in range(n_rows + 1):
        for j in range(n_cols):
            key = ("h", iy, j)
            st = ABSENT if key in absent_edges else PRESENT
            det.h_segs[(iy, j)] = make_seg(st)
    for i in range(n_rows):
        for jx in range(n_cols + 1):
            key = ("v", i, jx)
            st = ABSENT if key in absent_edges else PRESENT
            det.v_segs[(i, jx)] = make_seg(st)
    return det


class TestGridMerge(unittest.TestCase):
    def test_no_merges_all_single_cells(self):
        model = GridModel(make_detection())
        self.assertEqual(len(model.cells), 9)
        for cell in model.cells:
            self.assertEqual(cell.span, (1, 1))

    def test_horizontal_merge(self):
        # 第 1 行（i=0）竖线 jx=1 无边 -> R1C1 与 R1C2 合并
        det = make_detection(absent_edges={("v", 0, 1)})
        model = GridModel(det)
        anchor = next(c for c in model.cells if c.anchor == (0, 0))
        self.assertEqual(anchor.span, (1, 2))
        self.assertEqual(anchor.code, "R1C1")
        # 总槽位 9，合并后格子数 8
        self.assertEqual(len(model.cells), 8)
        # 被覆盖槽位标记
        cov = model.slot_coverage()
        self.assertEqual(cov[(0, 1)], "covered:R1C1")

    def test_two_by_two_merge(self):
        # R2C2..R3C3 2x2：内部两条竖边、两条横边全 absent
        absent = {("v", 1, 2), ("v", 2, 2), ("h", 2, 1), ("h", 2, 2)}
        model = GridModel(make_detection(absent_edges=absent))
        anchor = next(c for c in model.cells if c.anchor == (1, 1))
        self.assertEqual(anchor.span, (2, 2))
        self.assertEqual(len(model.cells), 9 - 3)  # 4 槽位合成 1 格

    def test_uncertain_defaults_to_closed(self):
        # uncertain 边默认当有边，不会擅自合并
        det = make_detection()
        det.v_segs[(0, 1)] = make_seg(UNCERTAIN, "low", support=0.3)
        model = GridModel(det)
        self.assertEqual(len(model.cells), 9)

    def test_manual_override_then_reset(self):
        model = GridModel(make_detection())
        model.set_edge_override("v", 0, 1, ABSENT)
        self.assertEqual(len(model.cells), 8)
        model.set_edge_override("v", 0, 1, None)
        self.assertEqual(len(model.cells), 9)

    def test_confirm_merge_and_unmerge(self):
        model = GridModel(make_detection())
        model.confirm_merge(0, 1, 0, 1)  # R1C1..R2C2 2x2
        anchor = next(c for c in model.cells if c.anchor == (0, 0))
        self.assertEqual(anchor.span, (2, 2))
        model.unmerge_at(1, 1)
        self.assertEqual(len(model.cells), 9)


class TestNumbering(unittest.TestCase):
    def test_codes_stable_and_position_based(self):
        # 即使有合并，锚点编号仍按空间槽位，不被前移
        absent = {("v", 0, 1), ("h", 1, 2)}  # R1C1 横并 + R?C3 纵并
        model = GridModel(make_detection(absent_edges=absent))
        codes = {c.code for c in model.cells}
        # R1C2 槽位被覆盖，不产生 R1C2 锚点；但 R1C3 编号仍在
        self.assertNotIn("R1C2", codes)
        self.assertIn("R1C3", codes)
        self.assertIn("R3C3", codes)
        # seq 顺序按行列
        seqs = [c.code for c in model.cells]
        self.assertEqual(seqs, sorted(seqs, key=lambda s: (
            int(s.split("C")[0][1:]), int(s.split("C")[1]))))

    def test_blank_or_missing_does_not_shift(self):
        model = GridModel(make_detection())
        # 标记某格空白，编号集合不变
        model.cell_notes["R2C2"] = ["空白格（墨迹低于阈值）"]
        model.rebuild()
        codes = {c.code for c in model.cells}
        self.assertIn("R2C2", codes)
        self.assertEqual(len(codes), 9)


class TestLineEdits(unittest.TestCase):
    def test_add_remove_vline(self):
        model = GridModel(make_detection(n_rows=2, n_cols=2))
        self.assertEqual(model.n_cols, 2)
        idx = model.add_vline(150.0)  # xs=[0,100,200,300]，150 落在索引 2
        self.assertEqual(idx, 2)
        self.assertEqual(model.n_cols, 3)
        self.assertEqual(len(model.det.xs), 4)
        # 新线各段是 present
        for i in range(2):
            self.assertEqual(model.edge_state("v", i, idx), PRESENT)
        # 新增线不应改变既有格子的合并状态
        self.assertEqual(len(model.cells), 6)
        model.remove_vline(idx)
        self.assertEqual(model.n_cols, 2)
        self.assertEqual(len(model.cells), 4)

    def test_cannot_remove_outer_frame(self):
        model = GridModel(make_detection())
        with self.assertRaises(ValueError):
            model.remove_vline(0)
        with self.assertRaises(ValueError):
            model.remove_hline(len(model.det.ys) - 1)

    def test_override_keys_shift_on_line_insert(self):
        model = GridModel(make_detection())
        model.set_edge_override("v", 0, 2, ABSENT)
        model.add_vline(150.0)  # 新线索引 1，旧 jx=2 应变成 3
        self.assertEqual(model.overrides.get("v:0,3"), ABSENT)
        self.assertNotIn("v:0,2", model.overrides)

    def test_roundtrip_serialization(self):
        model = GridModel(make_detection(absent_edges={("v", 0, 1)}))
        model.set_edge_override("h", 1, 0, ABSENT)
        data = model.to_dict()
        restored = GridModel.from_dict(data)
        self.assertEqual(restored.n_rows, model.n_rows)
        self.assertEqual(restored.n_cols, model.n_cols)
        self.assertEqual(restored.overrides, model.overrides)
        self.assertEqual([c.code for c in restored.cells],
                         [c.code for c in model.cells])


class TestGeometryRoundTrip(unittest.TestCase):
    def test_rectified_original_roundtrip(self):
        info = RotationInfo(
            angle=1.8, original_shape=(700, 940),
            rotated_shape=(729, 961), crop_x=111, crop_y=115,
            width=740, height=500)
        pts = np.array([[0.0, 0.0], [123.5, 456.7], [739.0, 499.0]])
        orig = rectified_to_original(pts, info)
        back = original_to_rectified(orig, info)
        np.testing.assert_allclose(back, pts, atol=1e-9)

    def test_zero_angle_identity_offset(self):
        info = RotationInfo(
            angle=0.0, original_shape=(100, 120),
            rotated_shape=(100, 120), crop_x=10, crop_y=5,
            width=90, height=80)
        back = original_to_rectified(
            rectified_to_original(np.array([[20.0, 30.0]]), info), info)
        np.testing.assert_allclose(back, [[20.0, 30.0]], atol=1e-9)


if __name__ == "__main__":
    unittest.main(verbosity=2)
