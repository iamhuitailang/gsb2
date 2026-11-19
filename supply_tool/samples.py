# -*- coding: utf-8 -*-
"""生成两份样例供应单 PDF(带文字层)。

样例一 sample1.pdf (A 版「供应单」):
  三条明细 12.50 / 20.00 / 7.50, 合计 40.00;
  第 2 条跨页 —— 第 1 页页尾只有行号+品名, 数量和金额在第 2 页开头;
  第 2 页重印表头, 不计入明细。

样例二 sample2.pdf (B 版「供货清单」):
  两条明细 30.00 / 36.00, 合计 66.00;
  第 1 条品名在同一页内断成两行, 用于演示校对并重新核对。
"""
import os

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

FONT = "STSong-Light"
pdfmetrics.registerFont(UnicodeCIDFont(FONT))

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES_DIR = os.path.join(HERE, "..", "samples")


def _text(c, x, y, s, size=11):
    c.setFont(FONT, size)
    c.drawString(x, y, s)


def make_sample1(path):
    c = canvas.Canvas(path, pagesize=A4)
    # ---- 第 1 页 ----
    _text(c, 260, 800, "供应单", 16)
    _text(c, 60, 770, "单号：GD2026-001")
    _text(c, 300, 770, "日期：2026-11-16")
    _text(c, 60, 750, "供应商：示例果业公司")
    # 表头
    _text(c, 60, 700, "行号")
    _text(c, 110, 700, "品名")
    _text(c, 260, 700, "数量")
    _text(c, 320, 700, "金额(元)")
    # 第 1 条
    _text(c, 60, 675, "1")
    _text(c, 110, 675, "苹果")
    _text(c, 260, 675, "5")
    _text(c, 320, 675, "12.50")
    # 第 2 条: 页尾只有行号+品名
    _text(c, 60, 80, "2")
    _text(c, 110, 80, "进口香蕉")
    c.showPage()
    # ---- 第 2 页: 重印表头 ----
    _text(c, 60, 800, "行号")
    _text(c, 110, 800, "品名")
    _text(c, 260, 800, "数量")
    _text(c, 320, 800, "金额(元)")
    # 第 2 条的数量和金额
    _text(c, 260, 775, "10")
    _text(c, 320, 775, "20.00")
    # 第 3 条
    _text(c, 60, 750, "3")
    _text(c, 110, 750, "橙子")
    _text(c, 260, 750, "4")
    _text(c, 320, 750, "7.50")
    # 合计
    _text(c, 60, 700, "合计：40.00 元")
    c.showPage()
    c.save()


def make_sample2(path):
    c = canvas.Canvas(path, pagesize=A4)
    _text(c, 260, 800, "供货清单", 16)
    _text(c, 60, 770, "单号：GH2026-002")
    _text(c, 300, 770, "日期：2026-11-17")
    _text(c, 60, 750, "供应商：示例干货商行")
    # 表头
    _text(c, 60, 700, "序号")
    _text(c, 110, 700, "商品名称")
    _text(c, 300, 700, "数量")
    _text(c, 350, 700, "单价")
    _text(c, 410, 700, "金额(元)")
    # 第 1 条: 品名断成两行
    _text(c, 60, 675, "1")
    _text(c, 110, 675, "特级红富士苹")
    _text(c, 300, 675, "2")
    _text(c, 350, 675, "15.00")
    _text(c, 410, 675, "30.00")
    _text(c, 110, 658, "果 5kg装")
    # 第 2 条
    _text(c, 60, 635, "2")
    _text(c, 110, 635, "新疆灰枣 1kg")
    _text(c, 300, 635, "3")
    _text(c, 350, 635, "12.00")
    _text(c, 410, 635, "36.00")
    # 合计
    _text(c, 60, 590, "合计：66.00 元")
    c.showPage()
    c.save()


def ensure_samples():
    os.makedirs(SAMPLES_DIR, exist_ok=True)
    p1 = os.path.join(SAMPLES_DIR, "sample1.pdf")
    p2 = os.path.join(SAMPLES_DIR, "sample2.pdf")
    if not os.path.exists(p1):
        make_sample1(p1)
    if not os.path.exists(p2):
        make_sample2(p2)
    return p1, p2


if __name__ == "__main__":
    for p in ensure_samples():
        print("生成:", p)
