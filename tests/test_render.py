import unittest

import numpy as np

from rawframe.model import FrameParams
from rawframe.color import yuv_to_rgb, rgb_to_yuv_limited
from rawframe.render import (render_frame, missing_mask, render_crop,
                             mean_abs_diff)
from rawframe.rawio import RawFile
from rawframe.layout import frame_size
import os
import tempfile


class TestColor(unittest.TestCase):
    def test_limited_range_gray_neutral(self):
        # 灰阶：U=V=128 时 RGB 三通道相等
        y = np.full((1, 1), 128, np.uint8)
        u = np.full((1, 1), 128, np.uint8)
        rgb = yuv_to_rgb(y, u, u, "limited")
        self.assertTrue((rgb[0, 0] == rgb[0, 0][0]).all())

    def test_full_range_black_white(self):
        y0 = np.zeros((1, 1), np.uint8)
        y255 = np.full((1, 1), 255, np.uint8)
        c = np.full((1, 1), 128, np.uint8)
        black = yuv_to_rgb(y0, c, c, "full")
        white = yuv_to_rgb(y255, c, c, "full")
        self.assertTrue((black[0, 0] == 0).all())
        self.assertTrue((white[0, 0] == 255).all())

    def test_rgb_yuv_roundtrip_approx(self):
        # limited range 色度只有 224/255 量化级，饱和色往返误差最大约 12
        for rgb0 in ((255, 0, 0), (0, 255, 0), (0, 0, 255), (192, 192, 0)):
            y, u, v = rgb_to_yuv_limited(*rgb0)
            back = yuv_to_rgb(
                np.array([[y]], np.uint8), np.array([[u]], np.uint8),
                np.array([[v]], np.uint8), "limited")[0, 0]
            for a, b in zip(rgb0, back):
                self.assertLess(abs(int(a) - int(b)), 16)
        # 中性色（无色度量化损失）应精确往返
        for rgb0 in ((0, 0, 0), (255, 255, 255), (100, 100, 100)):
            y, u, v = rgb_to_yuv_limited(*rgb0)
            back = yuv_to_rgb(
                np.array([[y]], np.uint8), np.array([[u]], np.uint8),
                np.array([[v]], np.uint8), "limited")[0, 0]
            for a, b in zip(rgb0, back):
                self.assertLess(abs(int(a) - int(b)), 2)


class TestRender(unittest.TestCase):
    def test_rgba_passthrough(self):
        tmp = tempfile.mkdtemp()
        p = FrameParams(2, 2, "rgba")
        img = np.array([[[10, 20, 30, 255]] * 2] * 2, np.uint8)
        path = os.path.join(tmp, "x.raw")
        with open(path, "wb") as f:
            f.write(img.tobytes())
        with RawFile(path, p) as rf:
            rgb = render_frame(p, rf.read_planes(0))
        self.assertTrue((rgb == img[:, :, :3]).all())

    def test_missing_mask_on_truncated(self):
        tmp = tempfile.mkdtemp()
        p = FrameParams(4, 4, "i420")  # 24 字节/帧：Y=16, U=4, V=4
        path = os.path.join(tmp, "t.raw")

        # 情形 1：只缺 V 平面（帧内 20 字节）。V 覆盖全部 2x2 块 → 掩码全 True
        with open(path, "wb") as f:
            f.write(b"\x80" * frame_size(p) + b"\x80" * 20)
        with RawFile(path, p) as rf:
            mask = missing_mask(p, rf.read_planes(1))
        self.assertTrue(mask.all())

        # 情形 2：Y/U/V 都完整（恰好 24 字节）→ 无缺失
        with open(path, "wb") as f:
            f.write(b"\x80" * frame_size(p) * 2)
        with RawFile(path, p) as rf:
            mask = missing_mask(p, rf.read_planes(1))
        self.assertFalse(mask.any())

        # 情形 3：NV12 缺 UV 平面的第二色度行 → 仅亮度底行受影响
        pn = FrameParams(4, 4, "nv12")  # Y=16, UV=8
        with open(path, "wb") as f:
            f.write(b"\x80" * frame_size(pn) + b"\x80" * (16 + 4))
        with RawFile(path, pn) as rf:
            mask = missing_mask(pn, rf.read_planes(1))
        self.assertFalse(mask[:2, :].any())
        self.assertTrue(mask[2:, :].all())

    def test_crop_validation(self):
        from rawframe.render import crop_params
        p = FrameParams(4, 4, "i420")
        with self.assertRaises(ValueError):
            crop_params(p, 2, 0, 1, 4)
        # 合法裁剪不报错
        crop_params(p, 1, 1, 3, 3)

    def test_diff_zero_for_equal(self):
        a = np.zeros((4, 4, 3), np.uint8)
        self.assertEqual(mean_abs_diff(a, a.copy()), 0.0)


if __name__ == "__main__":
    unittest.main()
