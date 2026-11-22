"""CLI 入口冒烟测试：退出码语义与完整命令链路。"""

import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO

from proxylink.cli import main
from proxylink.gen_media import generate_all

try:
    import subprocess
    subprocess.run(["ffprobe", "-version"], capture_output=True, check=True)
    HAVE_FFMPEG = True
except Exception:
    HAVE_FFMPEG = False


@unittest.skipUnless(HAVE_FFMPEG, "环境缺少 ffmpeg/ffprobe")
class CliSmokeTest(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="proxylink_cli_")
        self.media_dir = os.path.join(self.tmp, "media")
        self.paths = generate_all(self.media_dir, duration=3.0, fps=24,
                                  short_duration=2.0, head_shift=1.0)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_cli(self, *argv):
        out, err = StringIO(), StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            try:
                code = 0
                main(["-C", self.tmp, *argv])
            except SystemExit as exc:
                code = exc.code
        return code, out.getvalue(), err.getvalue()

    def test_full_command_chain_and_exit_codes(self):
        # 登记 + 挂接 + 标定
        code, out, _ = self.run_cli("register", self.paths["original"])
        self.assertEqual(code, 0)
        self.run_cli("register", self.paths["short"])
        code, out, _ = self.run_cli("media", "list")
        self.assertIn("original.mp4", out)

        import json
        state = json.load(open(os.path.join(self.tmp, ".proxylink", "state.json")))
        ids = list(state["media"])
        orig_id = next(i for i in ids if i.endswith("original.mp4"))
        short_id = next(i for i in ids if i.endswith("proxy_short.mp4"))

        code, out, _ = self.run_cli("link", orig_id, short_id)
        self.assertEqual(code, 0)
        code, out, _ = self.run_cli("links")
        self.assertEqual(code, 0)
        # 输出首行形如 "  link_xxxxxxxx  [未标定]"
        link_id = out.split()[0]

        self.run_cli("calibrate", link_id, "--anchor", "0=0")
        code, out, _ = self.run_cli("status", link_id)
        self.assertEqual(code, 0)
        self.assertIn("不可定位区间", out)

        # 越界 locate 退出码为 2
        code, _, err = self.run_cli("locate", link_id, "--side", "original", "2.5")
        self.assertEqual(code, 2)
        self.assertIn("停止", err)

        # 剪辑点与导出
        code, _, _ = self.run_cli("cut", "add", link_id, "1.0", "--label", "x")
        self.assertEqual(code, 0)
        code, out, _ = self.run_cli("export", "--format", "csv")
        self.assertEqual(code, 0)
        self.assertIn("original_filename", out)

        # 不存在的素材 -> 退出码 1
        code, _, err = self.run_cli("media", "show", "/no/such/file.mp4")
        self.assertEqual(code, 1)

    def test_persistence_via_cli_restart(self):
        self.run_cli("register", self.paths["original"])
        self.run_cli("register", self.paths["normal"])
        import json
        state = json.load(open(os.path.join(self.tmp, ".proxylink", "state.json")))
        ids = list(state["media"])
        self.run_cli("link", *ids)
        code, out, _ = self.run_cli("links")
        link_id = out.split()[0]
        self.run_cli("calibrate", link_id, "--anchor", "0=0")
        code, out, err = self.run_cli(
            "session", "seek", link_id, "1.0", "--side", "original")
        self.assertEqual(code, 0, err)

        # 重新构造进程视角：状态全部落盘
        state2 = json.load(open(os.path.join(self.tmp, ".proxylink", "state.json")))
        self.assertIsNotNone(state2["session"])
        self.assertAlmostEqual(state2["session"]["original_time"], 1.0, places=2)
        self.assertTrue(state2["links"][link_id]["calibration"]["anchors"])


if __name__ == "__main__":
    unittest.main()
