import json
import os
import tempfile
import unittest

import numpy as np

from rawframe.model import FrameParams
from rawframe.rawio import RawFile
from rawframe.samples import generate_all
from rawframe.config import (export_png_sequence, verify_export,
                             save_config, load_config)
from rawframe.png import encode_png
from rawframe.render import render_crop


class TestExport(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src_dir = tempfile.mkdtemp()
        cls.specs = {s.key: s for s in generate_all(cls.src_dir)}
        cls.out_dir = tempfile.mkdtemp()

    def _src(self, key):
        return os.path.join(self.src_dir, self.specs[key].filename)

    def test_png_roundtrip_pixel_identical(self):
        s = self.specs["bars_i420"]
        res = export_png_sequence(
            self._src("bars_i420"), s.params,
            os.path.join(self.out_dir, "seq1"), [0, 1])
        self.assertEqual(len(res.png_files), 2)
        report = verify_export(res.config_path)
        self.assertTrue(report["ok"], report)
        self.assertEqual(report["checked"], [0, 1])

    def test_padding_never_enters_png(self):
        s = self.specs["padded_i420"]
        out = os.path.join(self.out_dir, "seq_pad")
        res = export_png_sequence(
            self._src("padded_i420"), s.params, out, [0])
        cfg = load_config(res.config_path)
        self.assertGreater(cfg["params"].stride_y, cfg["params"].width)
        # PNG 尺寸只反映有效像素
        report = verify_export(res.config_path)
        self.assertTrue(report["ok"])

    def test_crop_export_and_reload_same_pixels(self):
        s = self.specs["bars_odd"]
        box = (3, 1, 11, 6)  # 含奇数起点/末尾宽度
        out = os.path.join(self.out_dir, "seq_crop")
        res = export_png_sequence(
            self._src("bars_odd"), s.params, out, [0], crop=box)
        report = verify_export(res.config_path)
        self.assertTrue(report["ok"])
        with RawFile(self._src("bars_odd"), s.params) as rf:
            rgb, _, size = render_crop(s.params, rf.read_planes(0), box)
        self.assertEqual(size, (8, 5))

    def test_refuse_exporting_partial_frame(self):
        s = self.specs["truncated_i420"]
        with self.assertRaises(ValueError):
            export_png_sequence(
                self._src("truncated_i420"), s.params,
                os.path.join(self.out_dir, "bad"), [3])

    def test_config_save_load(self):
        p = FrameParams(20, 10, "nv12", stride_y=24, stride_uv=24)
        path = os.path.join(self.out_dir, "cfg.json")
        save_config(path, "/tmp/x.raw", p, crop=(1, 2, 9, 8))
        cfg = load_config(path)
        self.assertEqual(cfg["params"].to_dict(), p.to_dict())
        self.assertEqual(cfg["crop"], [1, 2, 9, 8])

    def test_png_encoder_header(self):
        rgb = np.zeros((2, 3, 3), np.uint8)
        data = encode_png(rgb)
        self.assertTrue(data.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertIn(b"IHDR", data)


if __name__ == "__main__":
    unittest.main()
