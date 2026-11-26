import unittest

from rawframe.model import FrameParams
from rawframe.layout import (planes_of, frame_size, trace_pixel,
                             chroma_coverage, describe_location,
                             diagnose_partial)


class TestLayout(unittest.TestCase):
    def test_i420_geometry_even(self):
        p = FrameParams(4, 4, "i420")
        ys, us, vs = planes_of(p)
        self.assertEqual((ys.offset, ys.size), (0, 16))
        self.assertEqual((us.offset, us.size, us.cols, us.rows), (16, 4, 2, 2))
        self.assertEqual((vs.offset, vs.size), (20, 4))
        self.assertEqual(frame_size(p), 24)

    def test_nv12_geometry_and_interleave(self):
        p = FrameParams(4, 4, "nv12")
        y, uv = planes_of(p)
        self.assertEqual((y.offset, uv.offset, uv.bpp, uv.stride),
                         (0, 16, 2, 4))
        self.assertEqual(frame_size(p), 16 + 2 * 2 * 2)

    def test_rgba_geometry(self):
        p = FrameParams(4, 2, "rgba")
        g = planes_of(p)[0]
        self.assertEqual((g.stride, g.bpp, g.size), (16, 4, 32))

    def test_odd_dimensions_chroma(self):
        p = FrameParams(15, 7, "i420")
        geoms = planes_of(p)
        self.assertEqual((geoms[1].cols, geoms[1].rows), (8, 4))
        # 最右色度采样只覆盖 1 列亮度，最下只覆盖 1 行
        self.assertEqual(chroma_coverage(p, 7, 3), (14, 6, 15, 7))
        self.assertEqual(chroma_coverage(p, 0, 0), (0, 0, 2, 2))

    def test_stride_padding(self):
        p = FrameParams(4, 2, "i420", stride_y=6, stride_uv=4)
        y, u, v = planes_of(p)
        self.assertEqual(y.row_padding, 2)
        self.assertEqual(u.row_padding, 2)
        # 行尾填充位置的人类可读描述
        desc = describe_location(p, 4)  # Y 平面第一行第一个填充字节
        self.assertIn("行尾填充", desc)
        self.assertIn("平面 Y", desc)

    def test_trace_i420(self):
        p = FrameParams(4, 4, "i420")
        entries = trace_pixel(p, 3, 2)
        labels = [e.label for e in entries]
        self.assertEqual(labels, ["Y", "U", "V"])
        self.assertEqual(entries[0].frame_rel_offset, 2 * 4 + 3)
        self.assertEqual(entries[1].frame_rel_offset, 16 + 1 * 2 + 1)
        self.assertEqual(entries[1].coverage, (2, 2, 4, 4))

    def test_trace_nv12_interleaved_pair(self):
        p = FrameParams(4, 4, "nv12")
        entries = trace_pixel(p, 2, 0)
        self.assertEqual(len(entries), 2)
        uv = entries[1]
        self.assertEqual(uv.length, 2)
        self.assertEqual(uv.sub_offsets, (0, 1))
        self.assertEqual(uv.frame_rel_offset, 16 + 0 * 4 + 1 * 2)

    def test_trace_rgba(self):
        p = FrameParams(4, 2, "rgba")
        e = trace_pixel(p, 1, 1)[0]
        self.assertEqual((e.length, e.frame_rel_offset), (4, 1 * 16 + 4))

    def test_stride_validation(self):
        with self.assertRaises(ValueError):
            FrameParams(8, 8, "i420", stride_y=4).validate()
        with self.assertRaises(ValueError):
            FrameParams(8, 8, "rgba", stride_y=8).validate()

    def test_diagnose_partial_all_padding(self):
        # 只缺行尾填充 → 图像仍然完整
        p = FrameParams(4, 2, "i420", stride_y=6, stride_uv=4)
        fs = frame_size(p)  # 12 + 8 + 8 = 28
        pa = diagnose_partial(p, 0, fs - 2, fs)  # 缺最后 2 字节（V 末行填充）
        self.assertTrue(pa.image_valid_complete)
        self.assertIn("行尾填充", pa.location)


if __name__ == "__main__":
    unittest.main()
