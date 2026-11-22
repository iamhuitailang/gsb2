"""mp4matrix 读写测试 + 旋转约定端到端核对 (依赖 ffmpeg)。

这些测试会生成临时 MP4, 写入 tkhd 矩阵, 再用 ffprobe/ffmpeg 读回,
确保"矩阵值 -> ffprobe rotation -> autorotate 实际方向"三者自洽。
"""

import json
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from aspect_tool import mp4matrix  # noqa: E402
from aspect_tool.geometry import build_display_transform  # noqa: E402

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")


@unittest.skipUnless(FFMPEG and FFPROBE, "需要 ffmpeg/ffprobe")
class TestMatrixRoundTrip(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.mp4 = Path(self.tmp.name) / "m.mp4"
        # 1 秒黑场 H.264
        subprocess.run(
            [FFMPEG, "-y", "-loglevel", "error", "-f", "lavfi",
             "-i", "color=c=red:size=320x240:rate=25:duration=1",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", str(self.mp4)],
            check=True, capture_output=True)

    def tearDown(self):
        self.tmp.cleanup()

    def _rotation_ccw(self, path: Path) -> float:
        out = subprocess.run(
            [FFPROBE, "-v", "error", "-select_streams", "v",
             "-show_entries", "side_data=rotation", "-of", "json", str(path)],
            check=True, capture_output=True, text=True).stdout
        data = json.loads(out)
        sdl = data["streams"][0].get("side_data_list", [])
        for sd in sdl:
            if "rotation" in sd:
                return float(sd["rotation"])
        return 0.0

    def test_clear_is_identity(self):
        mp4matrix.write_rotation(str(self.mp4), 90)
        self.assertNotEqual(self._rotation_ccw(self.mp4), 0.0)
        mp4matrix.clear_matrix(str(self.mp4))
        self.assertEqual(self._rotation_ccw(self.mp4), 0.0)

    def test_cw90_matches_ffprobe_minus90(self):
        mp4matrix.write_rotation(str(self.mp4), 90)
        self.assertAlmostEqual(self._rotation_ccw(self.mp4), -90.0)

    def test_cw270_matches_ffprobe_plus90(self):
        mp4matrix.write_rotation(str(self.mp4), 270)
        self.assertAlmostEqual(self._rotation_ccw(self.mp4), 90.0)

    def test_geometry_interprets_ffprobe_rotation(self):
        mp4matrix.write_rotation(str(self.mp4), 90)
        dt = build_display_transform(
            320, 240, Fraction(1), self._rotation_ccw(self.mp4))
        self.assertEqual(dt.cw_deg, 90)
        self.assertEqual((dt.dw, dt.dh), (240, 320))

    def test_autorotate_swaps_dimensions(self):
        mp4matrix.write_rotation(str(self.mp4), 90)
        png = Path(self.tmp.name) / "f.png"
        subprocess.run(
            [FFMPEG, "-y", "-loglevel", "error", "-i", str(self.mp4),
             "-frames:v", "1", str(png)], check=True, capture_output=True)
        with __import__("PIL.Image", fromlist=["open"]).open(png) as im:
            self.assertEqual(im.size, (240, 320))


if __name__ == "__main__":
    unittest.main(verbosity=2)
