#!/usr/bin/env python3
"""无头验证:用合成原图定量验证干扰下降与有用线条损失。

  python validate.py            # 灰度场景
  python validate.py --color    # 彩色场景(额外检查颜色条纹)
"""
import argparse
import json
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from ptool import core, metrics, synth


def run_case(color: bool, outdir: str):
    scene = synth.synth_scene(color=color)
    clean, corrupted = scene["clean"], scene["corrupted"]
    truth = scene["truth_peaks"]

    gray = corrupted if corrupted.ndim == 2 else corrupted.mean(axis=2)
    detected = core.detect_peaks(gray, n_peaks=8, thresh_rel=0.15)

    # 用真值峰做抑制(验证算法本身),同时报告自动检测命中情况
    result = core.suppress(corrupted, truth, radius_frac=0.008, depth=1.0)

    # 局部处理验证:只处理中央区域,检查边界无明显框
    h, w = gray.shape
    region = (h // 4, w // 4, 3 * h // 4, 3 * w // 4)
    result_local = core.suppress(corrupted, truth, radius_frac=0.008, depth=1.0,
                                 region=region, feather=40)
    y0, x0, y1, x1 = region
    # 边界两侧(羽化带之外)像素应与原图一致
    edge_row = result_local[y0 - 3, x0:x1] - corrupted[y0 - 3, x0:x1]
    edge_ok = bool(np.allclose(edge_row, 0, atol=1e-6))

    rep = {
        "color": color,
        "shape": list(corrupted.shape),
        "detected_peaks": [{k: round(float(v), 4) for k, v in p.items()} for p in detected],
        "truth_peaks": [{k: round(float(v), 4) for k, v in p.items()} for p in truth],
        "periodic_strength": {
            "before": metrics.periodic_strength(corrupted, truth),
            "after": metrics.periodic_strength(result, truth),
        },
        "psnr_vs_clean": {
            "before": metrics.psnr(corrupted, clean),
            "after": metrics.psnr(result, clean),
        },
        "interference_residual_ratio": metrics.interference_residual(result, clean, scene["interference"]),
        "grid_signal_loss_ratio": metrics.signal_loss(result, clean, scene["grid_mask"]),
        "local_region_outside_untouched": edge_ok,
    }
    if color:
        rep["color_fringe"] = {
            "before": metrics.color_fringe(corrupted, clean),
            "after": metrics.color_fringe(result, clean),
        }

    # 图: 原图 / 污染 / 结果 / 残差放大
    fig, axes = plt.subplots(1, 4, figsize=(18, 5))
    kw = dict(cmap="gray", vmin=0, vmax=1)
    axes[0].imshow(clean, **kw); axes[0].set_title("clean")
    axes[1].imshow(corrupted, **kw); axes[1].set_title("corrupted")
    axes[2].imshow(np.clip(result, 0, 1), **kw); axes[2].set_title("suppressed")
    resid = (result if result.ndim == 2 else result.mean(axis=2)) - \
            (clean if clean.ndim == 2 else clean.mean(axis=2))
    axes[3].imshow(resid, cmap="RdBu", vmin=-0.1, vmax=0.1)
    axes[3].set_title("residual vs clean")
    for a in axes:
        a.axis("off")
    fig.tight_layout()
    fig.savefig(os.path.join(outdir, f"validate_{'color' if color else 'gray'}.png"), dpi=110)
    plt.close(fig)
    return rep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--color", action="store_true")
    args = ap.parse_args()

    outdir = "output"
    os.makedirs(outdir, exist_ok=True)
    cases = [False] + ([True] if args.color else [])
    reports = [run_case(c, outdir) for c in cases]
    path = os.path.join(outdir, "validate_report.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(reports, f, ensure_ascii=False, indent=2)
    print(json.dumps(reports, ensure_ascii=False, indent=2))
    print(f"\n报告与对比图已写入 {outdir}/")


if __name__ == "__main__":
    main()
