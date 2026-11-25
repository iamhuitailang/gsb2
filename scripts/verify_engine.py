#!/usr/bin/env python3
"""引擎正确性数值验证(不经过 HTTP):

- 三个示例的事件检测符合合成时写入的脚本;
- 已知纯平移序列的轨迹恢复相关系数 ≈ 1, 稳定后对基准残差 < 1px;
- 不处理区间矩阵为单位阵;
- 导出片重新分析, 抖动运动量显著下降;
- 预览 / 导出共用渲染函数, 同帧结果逐字节一致(确定性)。

用法: python3 scripts/verify_engine.py
"""

from __future__ import annotations

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

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"[{'PASS' if ok else 'FAIL'}] {name} {detail}")
    if not ok:
        failures.append(name)


def ensure_samples() -> None:
    if not (ROOT / "samples" / "sample_shake.mp4").exists():
        subprocess.run([sys.executable, str(ROOT / "make_samples.py")], check=True)


def test_event_detection() -> None:
    shake = analyze_video(ROOT / "samples" / "sample_shake.mp4")
    check("shake: 无误报切换", shake["cut_frames"] == [])

    cuts = analyze_video(ROOT / "samples" / "sample_cuts.mp4")
    got = cuts["cut_frames"]
    ok = len(got) == 3 and all(abs(g - t) <= 2 for g, t in zip(got, [60, 120, 180]))
    check("cuts: 三个切换点定位到 ±2 帧", ok, f"got={got}")

    pan = analyze_video(ROOT / "samples" / "sample_pan.mp4")
    pf = pan["pan_frames"]
    check("pan: 检测到成组摇摄帧(>=12)", len(pf) >= 12,
          f"count={len(pf)} range=({min(pf) if pf else '-'},{max(pf) if pf else '-'})")
    if pf:
        check("pan: 摇摄帧落在合成区间 50-110",
              45 <= min(pf) and max(pf) <= 115)


def test_known_translation() -> None:
    cap = cv2.VideoCapture(str(ROOT / "samples" / "sample_shake.mp4"))
    ok, base = cap.read()
    cap.release()
    assert ok
    h, w = base.shape[:2]
    n = 60
    js = np.array([10 * np.sin(i * 0.9) + 3 * np.sin(i * 2.3) for i in range(n)])

    with tempfile.TemporaryDirectory() as td:
        clip = Path(td) / "unit.mp4"
        cmd = [
            "ffmpeg", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-s", f"{w}x{h}", "-r", "30", "-i", "-",
            "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", str(clip),
        ]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for i in range(n):
            m = np.float32([[1, 0, js[i]], [0, 1, 0]])
            f = cv2.warpAffine(base, m, (w, h), borderMode=cv2.BORDER_REFLECT)
            proc.stdin.write(f.tobytes())
        proc.stdin.close()
        proc.wait()

        a = analyze_video(clip)
        st = Stabilizer(a, {
            "strength": 1.0, "crop_mode": "manual", "crop_zoom": 1.0,
            "adaptive_pan": False, "smooth_sec": 1.5,
        })
        p = np.asarray(a["trajectory"])[:, 0]
        corr = float(np.corrcoef(p, js - js[0])[0, 1])
        check("known translation: 轨迹恢复相关 >0.99", corr > 0.99, f"corr={corr:.4f}")

        cap = cv2.VideoCapture(str(clip))
        residuals = []
        for i in range(6, n - 6):
            cap.set(cv2.CAP_PROP_POS_FRAMES, i)
            ok, fr = cap.read()
            out = st.render_stabilized(fr, i)
            g1 = cv2.cvtColor(out, cv2.COLOR_BGR2GRAY).astype(np.float32)
            g2 = cv2.cvtColor(base, cv2.COLOR_BGR2GRAY).astype(np.float32)
            (dx, dy), _ = cv2.phaseCorrelate(g1, g2)
            residuals.append((dx, dy))
        cap.release()
    r = np.asarray(residuals)
    med = np.median(np.abs(r), axis=0)
    check("known translation: 稳定后对基准中位残差 <1px",
          med[0] < 1.0 and med[1] < 1.0, f"median|dx,dy|={med.round(3)}")


def test_exclusion_identity_and_consistency() -> None:
    a = analyze_video(ROOT / "samples" / "sample_shake.mp4")
    st = Stabilizer(a, {"exclusions": [{"start": 10, "end": 20}]})
    m = st.matrix_at(15)
    identity = np.allclose(m, [[1, 0, 0], [0, 1, 0]], atol=1e-6)
    check("exclusion: 区间内矩阵严格单位阵", identity)

    cap = st._ensure_capture()
    cap.set(cv2.CAP_PROP_POS_FRAMES, 42)
    ok, frame = cap.read()
    f1 = st.render_stabilized(frame, 42)
    f2 = st.render_stabilized(frame.copy(), 42)
    check("render: 同帧同输入结果一致", np.array_equal(f1, f2))


def test_export_reduces_motion() -> None:
    src = ROOT / "samples" / "sample_shake.mp4"
    before = analyze_video(src)
    med_before = float(np.median(before["motion"]))
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "stable.mp4"
        st = Stabilizer(before, {"strength": 1.0, "crop_mode": "auto"})
        export_video(st, out)
        check("export: 文件生成且 >100KB", out.exists() and out.stat().st_size > 100_000,
              f"{out.stat().st_size / 1024:.0f}KB")
        after = analyze_video(out)
        med_after = float(np.median(after["motion"]))
    ratio = med_after / max(med_before, 1e-6)
    check("export: 中位运动量下降 >=35%", ratio < 0.65,
          f"{med_before:.2f} -> {med_after:.2f} (ratio {ratio:.2f})")


def main() -> int:
    ensure_samples()
    test_event_detection()
    test_known_translation()
    test_exclusion_identity_and_consistency()
    test_export_reduces_motion()
    print()
    if failures:
        print(f"{len(failures)} FAILURES: {failures}")
        return 1
    print("ALL ENGINE CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
