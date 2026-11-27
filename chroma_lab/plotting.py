"""matplotlib 公共设置: 中文字体回退链。"""
from __future__ import annotations

import matplotlib


def setup_cjk_font():
    matplotlib.rcParams["font.sans-serif"] = [
        "PingFang SC", "Hiragino Sans GB", "Arial Unicode MS",
        "Microsoft YaHei", "Noto Sans CJK SC", "DejaVu Sans",
    ]
    matplotlib.rcParams["axes.unicode_minus"] = False
