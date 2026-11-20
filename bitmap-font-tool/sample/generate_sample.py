#!/usr/bin/env python3
"""生成示例字形图集素材：用本机系统字体渲染一批字形 PNG + 字符映射表。

包含：大小写拉丁字母片段、标点、空格、宽窄差异字符（i/l 与 W/M/中文）。

用法：
    python3 generate_sample.py [输出目录]

输出：
    glyphs/*.png    每个字符一张透明底 PNG（已裁掉透明边）
    mapping.json    字符 -> 文件名 的映射表
    sample.txt      可用于预览的示例短句
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

# 示例字符集：标点、空格、窄字符(i l ! .)、宽字符(W M 中文)
LATIN = "Hellowrd,!" "Mil." "ABDEFGHIJKNOPQRSTUVWXYZ"  # 去重后使用
CJK = "你好世界，。！？宽窄字体测试国"
PUNCT = "，。！？,.!?'-:;\"()"

FONT_SIZE = 32

# 本机字体候选（macOS 系统字体，按优先级尝试）
LATIN_FONTS = [
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Geneva.ttf",
    "/System/Library/Fonts/Monaco.ttf",
]
CJK_FONTS = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
]


def load_font(candidates, size):
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    raise SystemExit("找不到可用的本机字体，请修改脚本中的字体路径")


def glyph_filename(ch):
    if ch == " ":
        return "space.png"
    if ch.isalnum() and ord(ch) < 128:
        return f"{ch}.png"
    return f"U+{ord(ch):04X}.png"


def render_glyph(ch, font, out_path):
    if ch == " ":
        # 空格：透明图，宽度取字体空格前进宽度
        advance = max(1, round(font.getlength(" ")))
        img = Image.new("RGBA", (advance, 4), (0, 0, 0, 0))
        img.save(out_path)
        return
    # 先画到大画布再裁透明边
    tmp = Image.new("RGBA", (FONT_SIZE * 3, FONT_SIZE * 3), (0, 0, 0, 0))
    d = ImageDraw.Draw(tmp)
    d.text((FONT_SIZE, FONT_SIZE), ch, font=font, fill=(255, 255, 255, 255))
    bbox = tmp.getbbox()
    if bbox is None:  # 完全空白（例如字体缺该字形）
        img = Image.new("RGBA", (max(1, round(font.getlength(ch))), 4), (0, 0, 0, 0))
        img.save(out_path)
        return
    tmp.crop(bbox).save(out_path)


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "out")
    glyphs_dir = os.path.join(out_dir, "glyphs")
    os.makedirs(glyphs_dir, exist_ok=True)

    latin_font = load_font(LATIN_FONTS, FONT_SIZE)
    cjk_font = load_font(CJK_FONTS, FONT_SIZE)

    chars = []
    for ch in LATIN + CJK + PUNCT + " ":
        if ch not in chars:
            chars.append(ch)

    mapping = {}
    for ch in chars:
        fname = glyph_filename(ch)
        font = cjk_font if ord(ch) > 0x2E7F else latin_font
        render_glyph(ch, font, os.path.join(glyphs_dir, fname))
        mapping[ch] = fname

    with open(os.path.join(out_dir, "mapping.json"), "w", encoding="utf-8") as f:
        json.dump(mapping, f, ensure_ascii=False, indent=2)

    with open(os.path.join(out_dir, "sample.txt"), "w", encoding="utf-8") as f:
        f.write("Hello, World! 你好，世界！\n"
                "宽 W M 国，窄 i l . 标点，。！？空格 换行测试\n")

    print(f"已生成 {len(mapping)} 个字形到 {glyphs_dir}")
    print(f"映射表：{os.path.join(out_dir, 'mapping.json')}")
    print("在工具中：先导入 mapping.json，再全选 glyphs/ 下的 PNG 导入即可")


if __name__ == "__main__":
    main()
