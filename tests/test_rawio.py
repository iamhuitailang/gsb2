import os
import tempfile
import unittest

import numpy as np

from rawframe.model import FrameParams
from rawframe.layout import frame_size
from rawframe.rawio import RawFile


def write_bytes(tmp: str, name: str, data: bytes) -> str:
    path = os.path.join(tmp, name)
    with open(path, "wb") as f:
        f.write(data)
    return path


class TestRawIO(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.p = FrameParams(4, 4, "i420")  # 帧大小 24
        self.fs = frame_size(self.p)

    def test_complete_frames_and_trailer(self):
        # 多余字节既可能是尾部垃圾，也可能是截断的下一帧；
        # 工具统一报告“完整帧数 + 部分帧诊断”，交由用户结合位置判断
        path = write_bytes(self.tmp, "a.raw", b"\x00" * (self.fs * 3 + 7))
        with RawFile(path, self.p) as rf:
            self.assertEqual(rf.scan.complete_frames, 3)
            self.assertEqual(rf.scan.leftover, 7)
            self.assertIsNotNone(rf.scan.partial)
            self.assertEqual(rf.scan.partial.index, 3)

    def test_truncated_last_frame(self):
        path = write_bytes(self.tmp, "b.raw", b"\x00" * (self.fs * 2 + 10))
        with RawFile(path, self.p) as rf:
            scan = rf.scan
            self.assertEqual(scan.safe_frame_count, 2)
            pa = scan.partial
            self.assertIsNotNone(pa)
            self.assertEqual(pa.index, 2)
            self.assertEqual(pa.present_bytes, 10)
            self.assertEqual(pa.first_missing_abs, 2 * self.fs + 10)
            self.assertFalse(pa.image_valid_complete)

    def test_read_planes_shapes_and_zero_fill(self):
        path = write_bytes(self.tmp, "c.raw", b"\x11" * (self.fs + 5))
        with RawFile(path, self.p) as rf:
            planes = rf.read_planes(1)  # 截断帧：只有 5/24 字节，落在 Y 平面
            self.assertEqual(planes["Y"].shape, (4, 4))
            self.assertEqual(planes["U"].shape, (2, 2))
            present = planes["_present"]
            self.assertEqual(int(present["Y"].sum()), 5)
            self.assertFalse(present["U"].any())        # U 平面整体缺失
            self.assertFalse(present["V"].any())        # V 平面整体缺失
            self.assertEqual(int(planes["V"][0, 0]), 0)  # 零填充

    def test_trace_values_and_missing(self):
        path = write_bytes(self.tmp, "d.raw", bytes(range(self.fs)))
        with RawFile(path, self.p) as rf:
            from rawframe.layout import trace_pixel
            reads = rf.read_trace(0, trace_pixel(self.p, 0, 0))
            self.assertEqual([r["values"][0] for r in reads], [0, 16, 20])
        # 截断帧上溯源：超出文件的值为 None
        path2 = write_bytes(self.tmp, "e.raw", bytes(range(self.fs + 18)))
        with RawFile(path2, self.p) as rf:
            reads = rf.read_trace(1, trace_pixel(self.p, 3, 3))
            self.assertIsNone(reads[2]["values"][0])  # V 采样缺失

    def test_stride_padding_excluded_from_planes(self):
        p = FrameParams(4, 2, "i420", stride_y=6, stride_uv=4)
        # 手工写一帧：有效字节 0x20，填充 0xEE
        buf = bytearray()
        for _ in range(2):
            buf += b"\x20" * 4 + b"\xee\xee"
        for _ in range(2):  # U 两行
            buf += b"\x20" * 2 + b"\xee\xee"
        for _ in range(2):  # V 两行
            buf += b"\x20" * 2 + b"\xee\xee"
        path = write_bytes(self.tmp, "f.raw", bytes(buf))
        with RawFile(path, p) as rf:
            planes = rf.read_planes(0)
            self.assertTrue((planes["Y"] == 0x20).all())
            self.assertTrue(planes["_present"]["Y"].all())

    def test_source_never_modified(self):
        data = os.urandom(self.fs * 2 + 3)
        path = write_bytes(self.tmp, "g.raw", data)
        before = open(path, "rb").read()
        with RawFile(path, FrameParams(8, 8, "nv12")) as rf:
            self.assertEqual(rf.scan.complete_frames, 0)  # 故意错参数
            rf.read_planes(0)
        with RawFile(path, FrameParams(4, 4, "rgba")) as rf:
            rf.read_planes(0)
        after = open(path, "rb").read()
        self.assertEqual(before, after)

    def test_sha256_stable(self):
        path = write_bytes(self.tmp, "h.raw", b"\x00" * self.fs)
        with RawFile(path, self.p) as rf:
            h1 = rf.sha256()
        with RawFile(path, self.p) as rf:
            h2 = rf.sha256()
        self.assertEqual(h1, h2)


if __name__ == "__main__":
    unittest.main()
