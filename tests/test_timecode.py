"""时间码与帧吸附单元测试。"""

import unittest

from proxylink.errors import CalibrationError
from proxylink.timecode import (
    format_smpte,
    parse_timecode,
    snap_to_frame,
)


class TestTimecode(unittest.TestCase):

    def test_seconds_and_clock(self):
        self.assertAlmostEqual(parse_timecode("12.5"), 12.5)
        self.assertAlmostEqual(parse_timecode("1:12.5"), 72.5)
        self.assertAlmostEqual(parse_timecode("00:01:12.500"), 72.5)

    def test_frame_timecode(self):
        # 24fps，第 12 帧 = 0.5s
        self.assertAlmostEqual(parse_timecode("00:00:00:12", fps=24), 0.5)
        self.assertAlmostEqual(parse_timecode("00:00:01:00", fps=24), 1.0)

    def test_frame_timecode_requires_fps(self):
        with self.assertRaises(CalibrationError):
            parse_timecode("00:00:01:00")

    def test_invalid_frame_number(self):
        with self.assertRaises(CalibrationError):
            parse_timecode("00:00:00:24", fps=24)

    def test_negative_rejected(self):
        with self.assertRaises(CalibrationError):
            parse_timecode(-1)
        with self.assertRaises(CalibrationError):
            parse_timecode("not-a-time")

    def test_snap_and_smpte_roundtrip(self):
        self.assertAlmostEqual(snap_to_frame(1.01, 24), round(1.01 * 24) / 24)
        self.assertEqual(format_smpte(0.5, 24), "00:00:00:12")
        self.assertEqual(format_smpte(3661.0, 24), "01:01:01:00")


if __name__ == "__main__":
    unittest.main()
