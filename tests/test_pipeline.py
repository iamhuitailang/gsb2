"""端到端冒烟测试: 生成 -> 校准 -> 转换 -> 对比 -> 批量 -> 重放。"""
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from neg2pos.cli import main
from neg2pos.core import FrameAdjust, RollCalib, convert_image, load_frame_params
from neg2pos.imgio import load_image
from neg2pos.simulate import BASES, expose, make_scene


class PipelineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)
        main(["gen", "--out", str(cls.dir), "--frames", "3", "--base", "orange", "--stains", "4"])
        main(["calibrate", "--image", str(cls.dir / "frame_00.png"),
              "--base-rect", "2,2,18,18", "--base-rect", "618,2,18,18",
              "--base-rect", "2,458,18,18", "--base-rect", "618,458,18,18",
              "--gray-rect", "44,304,72,72", "--film-gamma", "1.6",
              "--out", str(cls.dir / "calib.json")])

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_calib_values(self):
        roll = RollCalib.load(self.dir / "calib.json")
        self.assertTrue(np.allclose(roll.base_rgb, BASES["orange"], atol=0.01))
        # 灰块三通道密度接近(色罩被分别记录)
        dg = roll.gray_densities()
        self.assertLess(float(dg.max() - dg.min()), 0.05)

    def test_roundtrip_accuracy(self):
        main(["convert", "--image", str(self.dir / "frame_01.png"),
              "--calib", str(self.dir / "calib.json"), "--exposure", "0.7",
              "--out", str(self.dir / "pos_01.png")])
        main(["chart", "--positive", str(self.dir / "pos_01.png"),
              "--targets", str(self.dir / "targets.json"),
              "--report", str(self.dir / "report.json")])
        rep = json.loads((self.dir / "report.json").read_text())
        by_name = {p["name"]: p for p in rep["patches"]}
        self.assertLess(by_name["ref_gray"]["err_norm"], 0.03)
        self.assertLess(by_name["red"]["err_norm"], 0.05)
        self.assertLess(rep["gray_spread_worst"], 0.1)  # 灰阶基本中性

    def test_replay_identical(self):
        main(["convert", "--image", str(self.dir / "frame_02.png"),
              "--calib", str(self.dir / "calib.json"),
              "--exposure", "-0.3", "--black", "0.02", "--white", "0.95",
              "--out", str(self.dir / "a.png")])
        main(["convert", "--image", str(self.dir / "frame_02.png"),
              "--params", str(self.dir / "a.params.json"),
              "--out", str(self.dir / "b.png")])
        d = np.abs(load_image(self.dir / "a.png") - load_image(self.dir / "b.png")).max()
        self.assertEqual(float(d), 0.0)

    def test_batch_partial_failure(self):
        (self.dir / "broken.png").write_text("not an image")
        outdir = self.dir / "out"
        with self.assertRaises(SystemExit) as cm:
            main(["batch", "--indir", str(self.dir), "--calib", str(self.dir / "calib.json"),
                  "--out", str(outdir)])
        self.assertEqual(cm.exception.code, 1)
        results = json.loads((outdir / "batch_results.json").read_text())
        by_file = {e["file"]: e for e in results}
        self.assertEqual(by_file["broken.png"]["status"], "error")
        self.assertIn("cannot identify", by_file["broken.png"]["message"])
        # 已成功的正片和参数仍然可用
        ok = [e for e in results if e["status"] == "ok"]
        self.assertTrue(ok)
        for e in ok:
            self.assertTrue(Path(e["outputs"]["positive"]).exists())
            roll, adj = load_frame_params(e["outputs"]["params"])
            self.assertIsInstance(roll, RollCalib)

    def test_clipping_report(self):
        roll = RollCalib.load(self.dir / "calib.json")
        from neg2pos.analyze import clipping_report, region_masks
        img = load_image(self.dir / "frame_02.png")
        rep = clipping_report(img, roll)
        self.assertEqual(len(rep["channels"]), 3)
        for ch in rep["channels"]:
            self.assertIn("remaining_levels_8bit", ch)
            self.assertIn("density_headroom_stops", ch)
        masks = region_masks(img, roll)
        self.assertGreater(masks["near_base"].mean(), 0.05)  # 片边应被标出


class ModelTest(unittest.TestCase):
    def test_exact_inverse(self):
        """无噪声时, 校准参数与模拟参数一致应精确还原场景。"""
        pos, _ = make_scene()
        base = BASES["cool"]
        neg = expose(pos, base, ev=0.0, noise=0.0, stains=0)
        gray_scene = np.array([0.18, 0.18, 0.18])
        t_gray = (1 - gray_scene) ** 1.6
        roll = RollCalib(base_rgb=list(base), gray_rgb=list(np.array(base) * t_gray),
                         film_gamma=1.6)
        out = convert_image(neg, roll, FrameAdjust())
        inner = np.s_[100:400, 100:500]
        err = np.abs(out[inner] - pos[inner]).max()
        self.assertLess(float(err), 0.02)


if __name__ == "__main__":
    unittest.main()
