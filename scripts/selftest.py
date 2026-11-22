#!/usr/bin/env python3
"""端到端自检: 生成自带素材 -> 诊断 -> 两种模式转换 -> 复检 -> 圆度/方向核对。

对应需求 6: 自带一段有方向字样的旋转视频和一段拉伸显示的测试图视频,
验证转换后结果。退出码 0 表示全部通过。

用法: PYTHONPATH=src python3 scripts/selftest.py
"""

from __future__ import annotations

import sys
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import numpy as np
from PIL import Image

from aspect_tool import ffmpeg, fixtures
from aspect_tool.compare import compare_sampled
from aspect_tool.normalize import NormalizeRequest, run_normalize
from aspect_tool.probe import probe

WORK = Path("workdir/selftest")
PASS, FAIL = "PASS", "FAIL"
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = ""):
    results.append((name, ok, detail))
    print(f"  [{PASS if ok else FAIL}] {name}" + (f" — {detail}" if detail else ""))


def is_red(rgb) -> bool:
    return rgb[0] > 150 and rgb[1] < 100 and rgb[2] < 100


def is_blue(rgb) -> bool:
    return rgb[2] > 120 and rgb[0] < 100 and rgb[1] < 100


def circle_axis_ratio(png: str, color: str) -> float:
    a = np.asarray(Image.open(png).convert("RGB")).astype(int)
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    if color == "orange":
        m = (r > 200) & (g > 110) & (g < 200) & (b < 110)
    else:
        m = (g > 140) & (r < 90) & (b > 70) & (b < 170)
    ys, xs = np.nonzero(m)
    bw, bh = xs.max() - xs.min() + 1, ys.max() - ys.min() + 1
    return min(bw, bh) / max(bw, bh)


def main() -> int:
    WORK.mkdir(parents=True, exist_ok=True)
    print("== 1. 生成自带测试素材 ==")
    paths = fixtures.generate(WORK / "samples")
    rot, ana = paths["rotated"], paths["anamorphic"]

    print("\n== 2. 诊断信息核对 ==")
    info_rot = probe(rot)
    check("旋转素材识别为顺时针90", info_rot.display.cw_deg == 90,
          f"cw={info_rot.display.cw_deg}")
    check("旋转素材显示尺寸 240x320",
          (info_rot.display_width, info_rot.display_height) == (240, 320),
          f"{info_rot.display_width}x{info_rot.display_height}")
    check("旋转素材无歧义", not info_rot.ambiguous)

    info_ana = probe(ana)
    check("拉伸素材 SAR=4:3", info_ana.sar == Fraction(4, 3),
          f"SAR={info_ana.sar}")
    check("拉伸素材显示宽 428 (320*4/3 偶数对齐)",
          info_ana.display_width == 428, str(info_ana.display_width))

    print("\n== 3. 旋转素材 fit 转换 + 方向核对 ==")
    out_fit = str(WORK / "rot_fit.mp4")
    req = NormalizeRequest(rot, out_fit, mode="fit", target=(360, 640))
    res = run_normalize(req)
    check("fit 复检全部通过", res.verification["ok"])
    ffmpeg.frame_at_index(out_fit, 0, str(WORK / "rot_fit.png"),
                          autorotate=True)
    im = Image.open(WORK / "rot_fit.png").convert("RGB")
    # fit 上下有黑边, 在有效区 (active_box) 内部取顶/底边颜色
    ax0, ay0, ax1, ay1 = [int(round(v)) for v in
                          res.pipeline.plan.active_box]
    cx = (ax0 + ax1) // 2
    top_rgb = im.load()[cx, ay0 + 2]
    bot_rgb = im.load()[cx, ay1 - 2]
    check("有效区顶部为红边(TOP)", is_red(top_rgb), str(top_rgb))
    check("有效区底部为蓝边(BOTTOM)", is_blue(bot_rgb), str(bot_rgb))
    check("输出无旋转残留", res.verification["items"][0]["ok"])

    print("\n== 4. 旋转素材 crop 转换 + 标记点映射核对 ==")
    out_crop = str(WORK / "rot_crop.mp4")
    # 存储帧上左右两侧各取一点; crop 到 9:16 时一侧应被裁掉
    req2 = NormalizeRequest(rot, out_crop, mode="crop", target=(360, 640),
                            marker_points=[(55, 60), (185, 260)])
    res2 = run_normalize(req2)
    check("crop 复检全部通过", res2.verification["ok"])
    visibles = [p.visible for p in res2.mapped_points]
    check("crop 至少一个标记点被裁掉", False in visibles, str(visibles))
    check("crop 输出铺满无黑边", not res2.pipeline.plan.letterbox)
    # 反查一致性
    p0 = res2.mapped_points[0]
    sx, sy = res2.pipeline.map_point_o_to_s(p0.ox, p0.oy)
    check("标记点 O->S 反查一致",
          abs(sx - p0.sx) < 0.01 and abs(sy - p0.sy) < 0.01,
          f"({sx:.2f},{sy:.2f}) vs ({p0.sx:.2f},{p0.sy:.2f})")

    print("\n== 5. 拉伸素材方形化 + 圆度核对 ==")
    out_ana = str(WORK / "ana_square.mp4")
    req3 = NormalizeRequest(ana, out_ana, mode="fit", target=(640, 360))
    res3 = run_normalize(req3)
    check("方形化复检全部通过", res3.verification["ok"])
    check("输出 SAR=1", res3.verification["items"][1]["ok"])
    ffmpeg.frame_at_index(ana, 0, str(WORK / "ana_in.png"), autorotate=True)
    ffmpeg.frame_at_index(out_ana, 0, str(WORK / "ana_out.png"),
                          autorotate=True)
    ratio_in = circle_axis_ratio(str(WORK / "ana_in.png"), "orange")
    ratio_out = circle_axis_ratio(str(WORK / "ana_out.png"), "orange")
    check("输入圆为椭圆(轴比<0.9)", ratio_in < 0.9, f"ratio={ratio_in:.3f}")
    check("方形化后圆保持圆形(轴比>0.95)", ratio_out > 0.95,
          f"ratio={ratio_out:.3f}")

    print("\n== 6. 同时间点逐帧比较 ==")
    diffs = compare_sampled(rot, out_fit, str(WORK / "cmp"), samples=3)
    check("逐帧比较抽到 3 个时间点", len(diffs) == 3, str(len(diffs)))
    check("各时间点输入输出尺寸均已探测",
          all(d.size_in and d.size_out for d in diffs))

    print("\n== 汇总 ==")
    n_fail = sum(1 for _, ok, _ in results if not ok)
    for name, ok, detail in results:
        if not ok:
            print(f"  FAIL: {name} {detail}")
    print(f"\n共 {len(results)} 项, 通过 {len(results) - n_fail}, 失败 {n_fail}")
    return 1 if n_fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
