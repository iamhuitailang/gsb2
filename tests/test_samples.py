import os
import tempfile
import unittest

from rawframe.model import FrameParams
from rawframe.rawio import RawFile
from rawframe.samples import generate_all, BAR_RGB, PAD_BYTE
from rawframe.render import render_frame, mean_abs_diff
from rawframe.layout import frame_size


class TestSamples(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.specs = generate_all(cls.tmp)
        cls.by_key = {s.key: s for s in cls.specs}

    def _path(self, key):
        return os.path.join(self.tmp, self.by_key[key].filename)

    def test_bars_all_formats_scan_clean(self):
        for key in ("bars_i420", "bars_nv12", "bars_rgba"):
            s = self.by_key[key]
            with RawFile(self._path(key), s.params) as rf:
                self.assertEqual(rf.scan.complete_frames, s.frames)
                self.assertEqual(rf.scan.leftover, 0)
                self.assertIsNone(rf.scan.partial)

    def test_same_bars_render_identically_across_layouts(self):
        """同一彩条的 i420/nv12 物理布局渲染结果应一致（YUV 取整误差内）。"""
        renders = []
        for key in ("bars_i420", "bars_nv12"):
            s = self.by_key[key]
            with RawFile(self._path(key), s.params) as rf:
                rgb = render_frame(s.params, rf.read_planes(0))
                renders.append(rgb)
        self.assertLess(mean_abs_diff(renders[0], renders[1]), 1.0)

    def test_chroma_swap_is_visible(self):
        """把 i420 按 nv12 解释、nv12 按 i420 解释，标记处颜色必须明显跑掉。"""
        # i420 文件被当成 NV12：U/V 平面被当作交错 UV 对，标记邻域严重变色
        s = self.by_key["marker_i420"]
        p_wrong = FrameParams(s.params.width, s.params.height, "nv12")
        with RawFile(self._path("marker_i420"), s.params) as rf:
            good = render_frame(s.params, rf.read_planes(0))
        with RawFile(self._path("marker_i420"), p_wrong) as rf:
            bad = render_frame(p_wrong, rf.read_planes(0))
        self.assertGreater(mean_abs_diff(good, bad), 3.0)
        self.assertGreater(mean_abs_diff(good[2:4, 2:6], bad[2:4, 2:6]), 20.0)

        # 反向：NV12 文件被当成 i420，UV 交错对被拆成两个平面
        s2 = self.by_key["marker_nv12"]
        p_wrong2 = FrameParams(s2.params.width, s2.params.height, "i420")
        with RawFile(self._path("marker_nv12"), s2.params) as rf:
            good2 = render_frame(s2.params, rf.read_planes(0))
        with RawFile(self._path("marker_nv12"), p_wrong2) as rf:
            bad2 = render_frame(p_wrong2, rf.read_planes(0))
        self.assertGreater(mean_abs_diff(good2, bad2), 3.0)
        self.assertGreater(mean_abs_diff(good2[2:4, 2:6], bad2[2:4, 2:6]), 20.0)

    def test_odd_dimension_sample(self):
        s = self.by_key["bars_odd"]
        with RawFile(self._path("bars_odd"), s.params) as rf:
            planes = rf.read_planes(0)
            rgb = render_frame(s.params, planes)
            self.assertEqual(rgb.shape, (7, 15, 3))

    def test_padded_sample_and_wrong_stride_skew(self):
        s = self.by_key["padded_i420"]
        with RawFile(self._path("padded_i420"), s.params) as rf:
            self.assertEqual(rf.scan.complete_frames, 2)
            good = render_frame(s.params, rf.read_planes(0))
        # 故意忽略 stride（按无填充解释）：画面必然斜切、色差大
        p_wrong = FrameParams(s.params.width, s.params.height, "i420")
        with RawFile(self._path("padded_i420"), p_wrong) as rf:
            bad = render_frame(p_wrong, rf.read_planes(0))
        self.assertGreater(mean_abs_diff(good, bad), 5.0)

    def test_truncated_sample_diagnostics(self):
        s = self.by_key["truncated_i420"]
        with RawFile(self._path("truncated_i420"), s.params) as rf:
            scan = rf.scan
            self.assertEqual(scan.safe_frame_count, 3)
            self.assertIsNotNone(scan.partial)
            self.assertEqual(scan.partial.index, 3)
            self.assertEqual(scan.leftover, frame_size(s.params) // 2 + 8)

    def test_wrong_width_sample(self):
        s = self.by_key["wrongstride_nv12"]
        with RawFile(self._path("wrongstride_nv12"), s.params) as rf:
            good = render_frame(s.params, rf.read_planes(0))
        wrong = FrameParams(16, s.params.height, "nv12")
        with RawFile(self._path("wrongstride_nv12"), wrong) as rf:
            bad = render_frame(wrong, rf.read_planes(0))
        self.assertGreater(mean_abs_diff(good, bad), 5.0)

    def test_manifest_written(self):
        import json
        with open(os.path.join(self.tmp, "manifest.json"), encoding="utf-8") as f:
            manifest = json.load(f)
        self.assertEqual(len(manifest), len(self.specs))


if __name__ == "__main__":
    unittest.main()
