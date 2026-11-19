#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pixel_verify.py — 对 test/pixel_verify.cjs 导出的图集做逐像素往返验证。

严格按 README「如何还原一张精灵」的步骤：
  1. 按 contentRect 从 atlas.png 取像素；
  2. rotated=true 时逆时针 90° 转回；
  3. 贴到 sourceSize 画布的 spriteSourceSize 位置，与原始 PNG 逐像素比对。
另验证：trim 透明边距、extrude 外扩像素与边缘同色、frame 边界。

运行：先 node test/pixel_verify.cjs，再 python3 -I test/pixel_verify.py
"""
import json
import os
import sys
from tempfile import gettempdir

from PIL import Image

OUT = os.path.join(gettempdir(), "atlas-pixel-verify")


def fail(msg):
    print("  ✗ " + msg)
    sys.exit(1)


def main():
    atlas = Image.open(os.path.join(OUT, "atlas.png")).convert("RGBA")
    with open(os.path.join(OUT, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    frames = manifest["frames"]
    assert len(frames) == 2, frames.keys()

    for name, frame in frames.items():
        src = Image.open(os.path.join(OUT, "sources", name)).convert("RGBA")
        cr = frame["contentRect"]
        # 1) contentRect 取像素
        piece = atlas.crop((cr["x"], cr["y"], cr["x"] + cr["w"], cr["y"] + cr["h"]))
        # 2) 旋转还原（PIL 正角度为逆时针）
        if frame["rotated"]:
            piece = piece.rotate(90, expand=True)
        sss = frame["spriteSourceSize"]
        # 3) 放回 sourceSize 画布
        rebuilt = Image.new("RGBA", (frame["sourceSize"]["w"], frame["sourceSize"]["h"]), (0, 0, 0, 0))
        rebuilt.paste(piece, (sss["x"], sss["y"]))

        if rebuilt.size != src.size:
            fail("%s 尺寸不一致 %s != %s" % (name, rebuilt.size, src.size))
        if rebuilt.tobytes() != src.tobytes():
            # 定位首个差异像素
            for y in range(src.height):
                for x in range(src.width):
                    if rebuilt.getpixel((x, y)) != src.getpixel((x, y)):
                        fail(
                            "%s 像素不一致，首个差异 (%d,%d): 重建=%s 原图=%s"
                            % (name, x, y, rebuilt.getpixel((x, y)), src.getpixel((x, y)))
                        )
        print("  ✓ %s 旋转=%s 逐像素还原与原图完全一致" % (name, frame["rotated"]))

        # 透明边距校验：trim 矩形之外应全透明
        px = src.load()
        for y in range(src.height):
            for x in range(src.width):
                in_trim = (
                    sss["x"] <= x < sss["x"] + sss["w"]
                    and sss["y"] <= y < sss["y"] + sss["h"]
                )
                if not in_trim and px[x, y][3] != 0:
                    fail("%s (%d,%d) 应在透明边距内却不透明" % (name, x, y))
        print("  ✓ %s 透明边距外全部 alpha=0（trim 正确）" % name)

        # extrude 校验：内容四侧紧邻的外扩像素应等于对应边缘像素
        if manifest["meta"]["settings"]["extrude"] > 0:
            e = manifest["meta"]["settings"]["extrude"]
            fr = frame["frame"]
            ap = atlas.load()
            # 物理内容左上角（旋转时 contentRect 即物理内容区）
            cx, cy = cr["x"], cr["y"]
            cw, ch = cr["w"], cr["h"]
            # 取内容中线处的边缘像素与外扩像素比较，避开四角
            mx, my = cx + cw // 2, cy + ch // 2
            checks = [
                ("上", (mx, cy - 1), (mx, cy)),
                ("下", (mx, cy + ch), (mx, cy + ch - 1)),
                ("左", (cx - 1, my), (cx, my)),
                ("右", (cx + cw, my), (cx + cw - 1, my)),
            ]
            for label, outer, inner in checks:
                if ap[outer] != ap[inner]:
                    fail("%s extrude%s: 外扩 %s != 边缘 %s" % (name, label, ap[outer], ap[inner]))
            print("  ✓ %s 四边 extrude 像素与内容边缘同色" % name)

        # frame 包含 padding/extrude 的几何一致性
        cell = frame["cell"]
        if not frame["rotated"]:
            assert (fr["w"], fr["h"]) == (cell["w"], cell["h"])
        else:
            assert (fr["w"], fr["h"]) == (cell["h"], cell["w"])
        print("  ✓ %s frame 与 cell 几何一致（含 padding/extrude）" % name)

    # 必须至少有一张发生旋转，否则本测试没覆盖到旋转分支
    assert any(f["rotated"] for f in frames.values()), "测试设计失效：没有旋转帧"
    print("\n像素级往返验证全部通过")


if __name__ == "__main__":
    main()
