"""导出还原图 + 原始通道阵列, 以及重新打开阵列核对取样位置和尺寸标记。"""
from __future__ import annotations

import json
import os

import numpy as np

from . import core, plotting

plotting.setup_cjk_font()


def export_bundle(rgb: np.ndarray, down_siting: str, up_siting: str,
                  method: str, outdir: str) -> str:
    """导出: 原图、还原图、通道阵列 (.npz) 和清单 (.json)。"""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from PIL import Image

    os.makedirs(outdir, exist_ok=True)
    h, w = rgb.shape[:2]
    cw, ch = core.chroma_size(w, h)
    res = core.pipeline(rgb, down_siting, up_siting, method)

    Image.fromarray(rgb.astype(np.uint8)).save(
        os.path.join(outdir, "original.png"))
    Image.fromarray(res["recon"].astype(np.uint8)).save(
        os.path.join(outdir, "reconstructed.png"))

    np.savez_compressed(os.path.join(outdir, "channels.npz"),
                        Y=res["Y"], Cb=res["Cb"], Cr=res["Cr"])

    dx, dy = core.SITINGS[down_siting]
    manifest = {
        "width": w, "height": h,
        "chroma_width": cw, "chroma_height": ch,
        "down_siting": down_siting, "up_siting": up_siting,
        "method": method,
        "sample_offset": [dx, dy],
        "sample_position_rule": "色度样本 (i,j) 位于亮度坐标 (2*i+dx, 2*j+dy)",
        "odd_size_note": "奇数宽/高时最后一列/行样本覆盖复制出的边缘像素",
    }
    with open(os.path.join(outdir, "channels.json"), "w",
              encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    # 阵列预览图: 直接核对取样位置和尺寸标记
    fig, axes = plt.subplots(1, 3, figsize=(15, 5))
    axes[0].imshow(res["Y"], cmap="gray", vmin=0, vmax=255,
                   interpolation="nearest")
    axes[0].set_title(f"Y  {w}x{h}")
    for ax, name in ((axes[1], "Cr"), (axes[2], "Cb")):
        arr = res[name]
        ax.imshow(arr, cmap="RdBu_r", vmin=0, vmax=255,
                  interpolation="nearest",
                  extent=(dx - 1, 2 * (cw - 1) + dx + 1,
                          2 * (ch - 1) + dy + 1, dy - 1))
        xs, ys = core.sample_positions(cw, ch, down_siting)
        gx, gy = np.meshgrid(xs, ys)
        ax.scatter(gx.ravel(), gy.ravel(), s=6, c="k", marker=".")
        ax.set_title(f"{name}  {cw}x{ch}  取样点 (2i+{dx}, 2j+{dy})")
        _mark_last_edges(ax, w, h, cw, ch, dx, dy)
    fig.suptitle(f"通道阵列核对图  压缩={down_siting} 还原={up_siting}")
    fig.savefig(os.path.join(outdir, "channels_preview.png"), dpi=110)
    plt.close(fig)

    print(f"已导出到 {outdir}/")
    print(f"  original.png / reconstructed.png")
    print(f"  channels.npz  (Y {w}x{h}, Cr/Cb {cw}x{ch})")
    print(f"  channels.json / channels_preview.png")
    return outdir


def _mark_last_edges(ax, w, h, cw, ch, dx, dy):
    """奇数尺寸时用红框标出覆盖复制边缘的最后一列/行样本。"""
    import matplotlib.patches as mpatches
    if w & 1:
        ax.add_patch(mpatches.Rectangle(
            (2 * (cw - 1) + dx - 1, dy - 1), 2, 2 * ch, fill=False,
            edgecolor="red", lw=1.5))
    if h & 1:
        ax.add_patch(mpatches.Rectangle(
            (dx - 1, 2 * (ch - 1) + dy - 1), 2 * cw, 2, fill=False,
            edgecolor="red", lw=1.5))


def show_bundle(path: str):
    """重新打开导出的阵列, 核对取样位置和尺寸标记。"""
    import matplotlib.pyplot as plt

    if os.path.isdir(path):
        base = path
    else:
        base = os.path.dirname(path) or "."
    npz_path = os.path.join(base, "channels.npz")
    json_path = os.path.join(base, "channels.json")

    with open(json_path, encoding="utf-8") as f:
        manifest = json.load(f)
    data = np.load(npz_path)

    print("== 清单 ==")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    w, h = manifest["width"], manifest["height"]
    cw, ch = manifest["chroma_width"], manifest["chroma_height"]
    print("== 阵列实际尺寸 ==")
    for name in ("Y", "Cb", "Cr"):
        print(f"  {name}: {data[name].shape}")
    assert data["Y"].shape == (h, w), "Y 尺寸与清单不符!"
    assert data["Cb"].shape == (ch, cw), "Cb 尺寸与清单不符!"
    assert data["Cr"].shape == (ch, cw), "Cr 尺寸与清单不符!"
    print("尺寸核对通过。")

    siting = manifest["down_siting"]
    dx, dy = manifest["sample_offset"]
    fig, axes = plt.subplots(1, 3, figsize=(15, 5),
                             num="chroma_lab 阵列核对")
    axes[0].imshow(data["Y"], cmap="gray", vmin=0, vmax=255,
                   interpolation="nearest")
    axes[0].set_title(f"Y  {w}x{h}")
    for ax, name in ((axes[1], "Cr"), (axes[2], "Cb")):
        ax.imshow(data[name], cmap="RdBu_r", vmin=0, vmax=255,
                  interpolation="nearest",
                  extent=(dx - 1, 2 * (cw - 1) + dx + 1,
                          2 * (ch - 1) + dy + 1, dy - 1))
        xs, ys = core.sample_positions(cw, ch, siting)
        gx, gy = np.meshgrid(xs, ys)
        ax.scatter(gx.ravel(), gy.ravel(), s=6, c="k", marker=".")
        ax.set_title(f"{name}  {cw}x{ch}  取样点 (2i+{dx}, 2j+{dy})")
        _mark_last_edges(ax, w, h, cw, ch, dx, dy)
    fig.suptitle(f"阵列核对  压缩={siting} 还原={manifest['up_siting']}")
    plt.show()
