"""ffmpeg 命令构建测试（不实际执行转码，只校验滤镜链与音画同步参数）。"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from framelab.core.ffmpeg_tools import _atempo_chain, build_convert_command


class TestCommandBuilder(unittest.TestCase):
    def test_nearest_video_chain(self):
        cmd = build_convert_command("in.mp4", "out.mp4", 60, 1.0,
                                    "nearest", True, False)
        vf = cmd[cmd.index("-vf") + 1]
        self.assertIn("fps=fps=60:round=near", vf)
        self.assertNotIn("minterpolate", vf)
        self.assertIn("-an", cmd)  # 无音频

    def test_blend_video_chain(self):
        cmd = build_convert_command("in.mp4", "out.mp4", 30, 1.0,
                                    "blend", True, True)
        vf = cmd[cmd.index("-vf") + 1]
        self.assertIn("minterpolate=fps=30:mi_mode=blend", vf)

    def test_speedup_setpts_direction(self):
        # 2 倍速：setpts 系数应为 0.5（缩短时长）
        cmd = build_convert_command("in.mp4", "out.mp4", 30, 2.0,
                                    "nearest", True, False)
        vf = cmd[cmd.index("-vf") + 1]
        self.assertIn("setpts=PTS*0.500000", vf)

    def test_slowdown_setpts_direction(self):
        # 0.5 倍速：setpts 系数应为 2.0（拉长时长）
        cmd = build_convert_command("in.mp4", "out.mp4", 30, 0.5,
                                    "nearest", True, False)
        vf = cmd[cmd.index("-vf") + 1]
        self.assertIn("setpts=PTS*2.000000", vf)

    def test_keep_pitch_uses_atempo(self):
        cmd = build_convert_command("in.mp4", "out.mp4", 30, 2.0,
                                    "nearest", True, True)
        af = cmd[cmd.index("-af") + 1]
        self.assertIn("atempo=0.500000", af)
        self.assertNotIn("asetrate", af)

    def test_pitch_shift_uses_asetrate(self):
        cmd = build_convert_command("in.mp4", "out.mp4", 30, 2.0,
                                    "nearest", False, True)
        af = cmd[cmd.index("-af") + 1]
        self.assertIn("asetrate=44100*2.000000", af)

    def test_atempo_chain_splits_extreme_rates(self):
        # tempo=5 超出单段 2.0 上限，应串联
        chain = _atempo_chain(5.0)
        self.assertEqual(chain, "atempo=2.0,atempo=2.0,atempo=1.250000")
        # tempo=0.2 低于 0.5 下限
        chain = _atempo_chain(0.2)
        self.assertEqual(chain, "atempo=0.5,atempo=0.5,atempo=0.800000")

    def test_shortest_only_with_audio(self):
        cmd_audio = build_convert_command("in.mp4", "o.mp4", 30, 1,
                                          "nearest", True, True)
        cmd_silent = build_convert_command("in.mp4", "o.mp4", 30, 1,
                                           "nearest", True, False)
        self.assertIn("-shortest", cmd_audio)
        self.assertNotIn("-shortest", cmd_silent)


if __name__ == "__main__":
    unittest.main()
