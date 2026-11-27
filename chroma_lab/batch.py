"""批量生成对比图: 每种测试图 x 每种约定组合, 附整体色偏和边缘偏移指标。"""
from __future__ import annotations

import json
import os

import numpy as np

from . import core, metrics, plotting, testimages

plotting.setup_cjk_font()

# (压缩约定, 还原约定): 前三个一致, 后三个故意用错
COMBOS = [
    ("center", "center"),
    ("left", "left"),
    ("topleft", "topleft"),
    ("left", "center"),
    ("center", "left"),
    ("topleft", "center"),
]


def run(outdir: str) -> dict:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    os.makedirs(outdir, exist_ok=True)
    all_metrics: dict[str, list] = {}

    for name, img in testimages.make_set().items():
        h, w = img.shape[:2]
        ncols = len(COMBOS) + 1
        fig, axes = plt.subplots(2, ncols, figsize=(2.6 * ncols, 5.6),
                                 num=name)
        axes[0, 0].imshow(img / 255, interpolation="nearest")
        axes[0, 0].set_title(f"原图\n{w}x{h}", fontsize=9)
        axes[1, 0].imshow(np.abs(img - img).max(axis=-1), cmap="hot",
                          vmin=0, vmax=64, interpolation="nearest")
        axes[1, 0].set_title("误差图基准", fontsize=9)

        table = []
        for j, (down, up) in enumerate(COMBOS, start=1):
            res = core.pipeline(img, down, up)
            recon = res["recon"]
            err = np.abs(recon - img).max(axis=-1)
            axes[0, j].imshow(recon / 255, interpolation="nearest")
            axes[0, j].set_title(f"{down} -> {up}", fontsize=9)
            axes[1, j].imshow(err, cmap="hot", vmin=0, vmax=64,
                              interpolation="nearest")
            axes[1, j].set_title("误差 (上限64)", fontsize=9)
            m = metrics.compare(img, recon)
            m["combo"] = f"{down}->{up}"
            table.append(m)

        for ax in axes.ravel():
            ax.set_xticks([])
            ax.set_yticks([])
        fig.suptitle(f"chroma_lab 批量对比: {name}")
        fig.tight_layout()
        fig.savefig(os.path.join(outdir, f"batch_{name}.png"), dpi=110)
        plt.close(fig)
        all_metrics[name] = table

    with open(os.path.join(outdir, "metrics.json"), "w",
              encoding="utf-8") as f:
        json.dump(all_metrics, f, ensure_ascii=False, indent=2)

    _print_summary(all_metrics)
    print(f"\n对比图与指标已写入 {outdir}/")
    return all_metrics


def _print_summary(all_metrics: dict):
    header = (f"{'测试图':<22}{'组合':<18}{'MAE':>7}{'最大误差':>8}"
              f"{'色偏R':>7}{'色偏G':>7}{'色偏B':>7}"
              f"{'偏移X':>7}{'偏移Y':>7}")
    print(header)
    print("-" * len(header))
    for name, table in all_metrics.items():
        for m in table:
            b = m["bias_rgb"]
            print(f"{name:<22}{m['combo']:<18}{m['mae']:>7.2f}"
                  f"{m['max_err']:>8.1f}{b[0]:>7.2f}{b[1]:>7.2f}"
                  f"{b[2]:>7.2f}{m['shift_x']:>7.2f}{m['shift_y']:>7.2f}")
