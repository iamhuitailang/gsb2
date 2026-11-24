#!/usr/bin/env python3
"""周期纹理抑制工具入口。

用法:
  python run_app.py                  # 合成灰度场景(细格线 + 多方向干扰)
  python run_app.py --synth color    # 合成彩色场景(检查颜色条纹)
  python run_app.py --image 图.png   # 打开本地灰度图/彩色图
"""
import argparse

import numpy as np
import matplotlib.image as mpimg

from ptool import app


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", help="本地图片路径(灰度或彩色)")
    ap.add_argument("--synth", choices=["gray", "color"], default="gray",
                    help="未指定 --image 时生成的合成场景类型")
    args = ap.parse_args()

    if args.image:
        img = mpimg.imread(args.image)
        if img.dtype != np.uint8:
            img = np.clip(img, 0, 1)
        app.run(img=img)
    else:
        app.run(synth_variant=args.synth)


if __name__ == "__main__":
    main()
