"""集中配置 matplotlib 中文字体与样式，避免中文显示成方框。"""

from __future__ import annotations

import matplotlib
from matplotlib import font_manager


def configure_fonts() -> None:
    # macOS 常见中文字体，按优先级探测；找不到就回退默认（中文可能缺字但不报错）
    candidates = [
        "PingFang SC", "Hiragino Sans GB", "Heiti SC",
        "STHeiti", "Songti SC", "Arial Unicode MS",
    ]
    available = {f.name for f in font_manager.fontManager.ttflist}
    chosen = [name for name in candidates if name in available]
    family = chosen + ["DejaVu Sans"]
    matplotlib.rcParams["font.sans-serif"] = family
    matplotlib.rcParams["axes.unicode_minus"] = False
    matplotlib.rcParams["figure.facecolor"] = "white"
    matplotlib.rcParams["axes.facecolor"] = "white"
