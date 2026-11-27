"""端到端测试：多组合成图 -> 检测 -> 自检，并校验关键缺陷语义。"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cv2

from slicer.detection import ABSENT, PRESENT, UNCERTAIN, detect_lines
from slicer.exporter import export_cells
from slicer.geometry import deskew
from slicer.grid import GridModel
from slicer.synth import SynthSpec, generate
from slicer.verify import verify


class TestEndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="slicer_e2e_")
        self.tmp = Path(self.tmp)

    def _run(self, spec):
        img_path = self.tmp / f"seed{spec.seed}.png"
        truth = generate(spec, img_path)
        image = cv2.imread(str(img_path))
        deskewed, rot = deskew(image)
        det = detect_lines(deskewed)
        model = GridModel(det)
        report = verify(model, rot, img_path.with_name(img_path.stem + ".truth.json"))
        return truth, model, det, deskewed, report

    def test_default_spec_passes_verify(self):
        truth, model, det, deskewed, report = self._run(SynthSpec(
            n_rows=5, n_cols=4,
            merges=[(0, 0, 1, 2), (1, 2, 0, 0), (2, 3, 2, 3)],
            faint_segments=[("h", 4, 1), ("v", 0, 3), ("h", 1, 0)],
            gaps=[("h", 0, 2, 0.18), ("v", 4, 0, 0.15)],
            rotation_deg=1.8, seed=42))
        self.assertTrue(report["ok"], report["errors"])
        self.assertEqual(len(model.cells), len(truth["cells"]))
        self.assertLessEqual(report["crop_error_px"]["max"], 6.0)

    def test_multiple_seeds(self):
        for seed in (1, 99, 2024):
            spec = SynthSpec(
                n_rows=4, n_cols=3,
                merges=[(0, 0, 0, 1), (2, 3, 2, 2)],
                faint_segments=[("h", 2, 0)],
                gaps=[("v", 3, 1, 0.12)],
                rotation_deg=(-1.5 if seed % 2 else 2.2),
                seed=seed)
            _, model, _, _, report = self._run(spec)
            self.assertTrue(report["ok"], f"seed={seed}: {report['errors']}")
            self.assertEqual(report["checks"][0]["passed"], True)

    def test_merged_inner_edges_not_fabricated(self):
        # 合并格 R2C2..R3C3（0 基 r2-3,c2-3）：内部无边是 jx=3 的两段竖边
        # 与 iy=3 的两段横边；jx=2 是合并格左边框，本就应为实线。
        spec = SynthSpec(
            n_rows=4, n_cols=4,
            merges=[(1, 2, 1, 2)],   # R2C2..R3C3 2x2
            faint_segments=[], gaps=[], rotation_deg=0.5, seed=7)
        _, model, det, _, _ = self._run(spec)
        # 内部竖边 (v, i=1/2, jx=2) 不得被补成实线
        for i in (1, 2):
            self.assertNotEqual(det.v_segs[(i, 2)].state, PRESENT,
                                f"合并内部竖边被误补为实线 i={i}")
        # 内部横边 (h, iy=2, j=1/2) 不得被补成实线
        for j in (1, 2):
            self.assertNotEqual(det.h_segs[(2, j)].state, PRESENT,
                                f"合并内部横边被误补为实线 j={j}")
        # 合并格左边框 jx=1 必须仍是实线
        for i in (1, 2):
            self.assertEqual(det.v_segs[(i, 1)].state, PRESENT,
                             "合并格外边框被误判为无边")

    def test_short_gap_on_outer_frame_is_bridged_or_flagged(self):
        # 外框短缺口：必须仍识别为实线（连续或桥接），最差也要进低可信清单，
        # 绝不允许静默丢失导致表格残缺。
        spec = SynthSpec(
            n_rows=3, n_cols=3, merges=[],
            faint_segments=[], gaps=[("h", 0, 1, 0.15)],
            rotation_deg=0.0, seed=3)
        _, model, det, _, _ = self._run(spec)
        seg = det.h_segs[(0, 1)]
        self.assertIn(seg.state, (PRESENT, UNCERTAIN))
        if seg.state == PRESENT:
            # 识别成实线即可：高游程连续或显式桥接都算正确补全
            self.assertTrue(seg.bridged or seg.support >= 0.7)
        else:
            # 没把握也必须暴露给人工，而不是悄悄丢掉
            self.assertEqual(seg.confidence, "low")

    def test_export_manifest_and_blank_shorthand(self):
        spec = SynthSpec(n_rows=3, n_cols=3, merges=[],
                         faint_segments=[], gaps=[], rotation_deg=0.0, seed=11)
        _, model, _, deskewed, _ = self._run(spec)
        out = self.tmp / "export"
        res = export_cells(deskewed, model, out, "x.png")
        manifest = __import__("json").loads(
            (res.manifest_path).read_text(encoding="utf-8"))
        self.assertEqual(manifest["n_cells"], res.n_cells)
        # 每个槽位编号都在，seq 连续
        seqs = [c["seq"] for c in manifest["cells"]]
        self.assertEqual(seqs, list(range(1, len(seqs) + 1)))
        codes = [c["code"] for c in manifest["cells"]]
        self.assertEqual(len(codes), len(set(codes)))
        # 小图文件都存在
        for c in manifest["cells"]:
            if c["status"] != "missing":
                self.assertTrue((out / c["file"]).exists())

    def test_stamp_on_line_does_not_destroy_detection(self):
        # 印章压住合并内边：不得误补成实线；判不准要进低可信清单，
        # 人工确认合并后关系成立。
        spec = SynthSpec(n_rows=4, n_cols=4,
                         merges=[(2, 3, 2, 3)],
                         faint_segments=[], gaps=[],
                         rotation_deg=1.0, stamp=True, seed=55)
        _, model, det, _, report = self._run(spec)
        # 内边（jx=3 两段竖边、iy=3 两段横边）没有一个被误判成实线
        inner = [det.v_segs[(2, 3)], det.v_segs[(3, 3)],
                 det.h_segs[(3, 2)], det.h_segs[(3, 3)]]
        self.assertTrue(all(s.state != PRESENT for s in inner),
                        "印章压过的无边被误补成实线")
        # 至少有遮挡段进入低可信清单
        self.assertGreaterEqual(len(det.low_confidence), 1)
        # 人工确认合并范围后，应得到与真值一致的 13 格
        model.confirm_merge(2, 3, 2, 3)
        anchor = next(c for c in model.cells if c.anchor == (2, 2))
        self.assertEqual(anchor.span, (2, 2))
        # 4x4=16 槽，2x2 合并少 3 格 -> 13
        self.assertEqual(len(model.cells), 13)


if __name__ == "__main__":
    unittest.main(verbosity=2)
