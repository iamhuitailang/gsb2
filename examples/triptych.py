"""无界面生成三联对比图：原图 / 结果 / 残差，共用同一缩放。

用于出报告或快速核对"按同一比例看"的效果，不依赖 Tk。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402

from blurlab.compare import ViewState, render_triptych  # noqa: E402
from blurlab.deblur import DeblurParams, deblur_image_region  # noqa: E402
from blurlab.image_io import load_image, save_image  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="生成同比例三联对比图")
    ap.add_argument("--image", required=True)
    ap.add_argument("--length", type=float, required=True)
    ap.add_argument("--angle", type=float, required=True)
    ap.add_argument("--rect", help="x0,y0,x1,y1，缺省为整图")
    ap.add_argument("--zoom", type=float, default=1.0)
    ap.add_argument("--pane", default="420x300")
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)

    img = load_image(args.image)
    h, w = img.shape[:2]
    rect = None
    if args.rect:
        rect = tuple(int(float(v)) for v in args.rect.split(","))
        x0, y0, x1, y1 = rect
    else:
        x0, y0, x1, y1 = 0, 0, w, h

    params = DeblurParams(length_px=args.length, angle_deg=args.angle)
    out_region, stats = deblur_image_region(img[y0:y1, x0:x1], params)
    result = img.copy()
    result[y0:y1, x0:x1] = out_region
    residual = img - result

    pw, ph = (int(v) for v in args.pane.lower().split("x"))
    view = ViewState()
    if rect:
        # 以选区中心为焦点
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        view.scale = args.zoom
        view.off_x = pw / 2 - cx * view.scale
        view.off_y = ph / 2 - cy * view.scale
    else:
        view.fit(w, h, pw, ph)
        view.scale *= args.zoom

    pil, _ = render_triptych(img, result, residual, view=view, pane_size=(pw, ph), rect=rect)
    save_image(args.out, np.asarray(pil, dtype=np.float32) / 255.0)
    print(f"已写出 {args.out}")
    print(
        f"噪声增益上限 {params.noise_gain} -> 实际峰值 {stats.effective_noise_gain:.2f}，"
        f"λ={stats.lambda_used:.3e}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
