#!/usr/bin/env python3
"""补充检查:
1) 三个示例在默认参数 + 自动裁切下, 所有导出帧边缘无连续露黑;
2) 给视频人造一条音轨后导出, 成品仍含 AAC 音轨(音轨保留路径)。
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from vstab.engine import Stabilizer, analyze_video  # noqa: E402
from vstab.exporter import export_video  # noqa: E402

fails: list[str] = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name} {detail}")
    if not ok:
        fails.append(name)


def count_uncovered_pixels(st: Stabilizer, frame, i: int) -> int:
    """用品红作为越界填充色; 出现“精确”品红像素即说明矩阵覆盖不足。

    必须精确相等: 阈值匹配会与合成布景中的紫色 / 品红形状撞色,
    而 H264 解码后的真实内容几乎不可能恰好是 BGR(255,0,255)。
    """
    out = cv2.warpAffine(
        frame, st.matrix_at(i), (st.width, st.height),
        flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT,
        borderValue=(255, 0, 255),
    )
    mask = ((out[:, :, 0] == 255) & (out[:, :, 1] == 0)
            & (out[:, :, 2] == 255))
    return int(mask.sum())


def test_no_black_corners() -> None:
    for name in ("shake", "pan", "cuts"):
        src = ROOT / "samples" / f"sample_{name}.mp4"
        a = analyze_video(src)
        st = Stabilizer(a)  # 默认 auto crop

        # 1) 精确几何判据: 每一帧的矩阵四角都覆盖源画面
        not_covered = [i for i in range(a["frame_count"])
                       if not st.matrix_covers(st.matrix_at(i))]
        check(f"{name}: 几何覆盖判据全部帧通过", not not_covered,
              f"bad={not_covered[:5]} zoom={st.params['crop_zoom']}")

        # 2) 像素哨兵端到端复核
        cap = cv2.VideoCapture(str(src))
        total_uncovered = 0
        worst_frame = 0
        for i in range(a["frame_count"]):
            ok, fr = cap.read()
            if not ok:
                continue
            uncovered = count_uncovered_pixels(st, fr, i)
            if uncovered > total_uncovered:
                worst_frame, total_uncovered = i, uncovered
        cap.release()
        check(
            f"{name}: 全部 {a['frame_count']} 帧像素哨兵无越界填充",
            total_uncovered == 0,
            f"worst frame={worst_frame} sentinel_px={total_uncovered} "
            f"zoom={st.params['crop_zoom']}",
        )


def test_audio_passthrough() -> None:
    src = ROOT / "samples" / "sample_shake.mp4"
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        with_audio = td / "with_audio.mp4"
        # 追加 3 秒 440Hz 正弦音轨
        cmd = [
            "ffmpeg", "-y", "-i", str(src),
            "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
            "-c:v", "copy", "-c:a", "aac", "-shortest", str(with_audio),
        ]
        r = subprocess.run(cmd, capture_output=True)
        check("构造带音轨测试片", r.returncode == 0)
        if r.returncode != 0:
            print(r.stderr.decode()[-800:])
            return

        probe = json.loads(subprocess.run(
            ["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(with_audio)],
            capture_output=True, text=True).stdout)
        check("测试片含音轨", any(s["codec_type"] == "audio" for s in probe["streams"]))

        a = analyze_video(with_audio)
        check("分析识别 has_audio=True", a["has_audio"] is True)
        out = td / "stable_audio.mp4"
        st = Stabilizer(a)
        export_video(st, out)
        probe2 = json.loads(subprocess.run(
            ["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(out)],
            capture_output=True, text=True).stdout)
        aud = [s for s in probe2["streams"] if s["codec_type"] == "audio"]
        vid = [s for s in probe2["streams"] if s["codec_type"] == "video"]
        check("导出片含 1 条视频流", len(vid) == 1)
        check("导出片保留音轨(AAC)", len(aud) == 1 and aud[0].get("codec_name") == "aac",
              str([s.get("codec_name") for s in aud]))


if __name__ == "__main__":
    test_no_black_corners()
    test_audio_passthrough()
    print()
    if fails:
        print("FAILS:", fails)
        raise SystemExit(1)
    print("EXTRA CHECKS PASSED")
