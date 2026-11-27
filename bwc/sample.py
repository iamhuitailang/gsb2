"""程序化生成带典型缺陷的黑白模板样例(灰度图)。

包含的典型结构
--------------
* 两个实心主块, 其中一个内部有纯白封闭孔洞
* 细线, 线端带单像素/双像素毛刺
* 只在角上对角相接的两个方块(4-连通=2 块, 8-连通=1 块)
* 1px 窄缝隙(闭运算可补)
* 小孤岛(1px、3px、24px 三档, 给"移除小孤岛"不同阈值试)
* 顺序敏感结构: 贴着主块、只隔 1px 的小孤岛——先补短缝(闭)
  会把它并进主块, 先去毛刺(开)会先把它蚀掉, 两条顺序结果不同
* 若干灰色像素, 用来预览阈值怎么把灰度切成黑白

所有结构都是确定性的, 统计数字可复现。
"""

from __future__ import annotations

import numpy as np

BLACK = 0
WHITE = 255


def _rect(img: np.ndarray, y0: int, x0: int, y1: int, x1: int,
          value: int = BLACK) -> None:
    img[max(0, y0):y1 + 1, max(0, x0):x1 + 1] = value


def _diag_pair(img: np.ndarray, cy: int, cx: int, size: int = 18) -> None:
    """两个只在角上对角接触的方块(共享一个对角顶点, 不共享边)。"""
    half = size // 2
    _rect(img, cy - half, cx - half, cy, cx)
    _rect(img, cy + 1, cx + 1, cy + 1 + half, cx + 1 + half)


def make_sample(seed: int = 7, h: int = 240, w: int = 280) -> np.ndarray:
    """返回 uint8 灰度图, 黑(0)=墨迹, 白(255)=纸张。"""
    img = np.full((h, w), WHITE, dtype=np.uint8)

    # 1) 主块 A(左上方), 内部挖一个纯白封闭孔洞
    _rect(img, 25, 25, 80, 90)
    _rect(img, 42, 42, 62, 62, WHITE)          # 纯白孔, 被黑环完整包围

    # 2) 主块 A 上方一根细线, 末端带毛刺
    for y in range(8, 25):
        img[y, 55] = BLACK
    img[10, 56] = BLACK                        # 单像素毛刺
    img[11, 57] = BLACK                        # 斜向两像素毛刺
    img[14, 54] = BLACK

    # 3) 主块 B(右上方), 右侧伸出带毛刺的细柄
    _rect(img, 30, 160, 95, 225)
    for x in range(226, 250):
        img[62, x] = BLACK
    img[61, 233] = BLACK
    img[60, 234] = BLACK
    img[63, 240] = BLACK

    # 4) 对角相接块
    _diag_pair(img, 140, 60, size=18)

    # 5) 1px 窄缝隙: 两个方块中间留一列缝, 闭运算 r=1 可补上
    _rect(img, 115, 160, 165, 183)
    _rect(img, 115, 185, 165, 210)             # 列 184 是 1px 缝隙

    # 6) 顺序敏感结构: 主块 C 旁边隔 1px 放一个 3x3 小孤岛(9px)。
    #    先"移除小孤岛"(阈值20): 9<20 被删, 之后补短缝没东西可并;
    #    先"补短缝"(闭 r=1): 缝隙列被填, 孤岛并进主块, 再也删不掉。
    _rect(img, 185, 30, 220, 70)               # 主块 C
    _rect(img, 197, 72, 199, 74)               # 3x3 孤岛, 与 C 隔列 71(1px)

    # 7) 独立小孤岛三档
    img[205, 120] = BLACK                      # 1px
    img[214, 130] = BLACK                      # 3px L 形
    img[215, 130] = BLACK
    img[215, 131] = BLACK
    _rect(img, 200, 200, 205, 203)             # 6x4 = 24px

    # 8) 另一处对角斜线(8-连通下连成一个细块)
    img[120, 110] = BLACK
    img[121, 111] = BLACK
    img[122, 112] = BLACK

    # 9) 灰色像素: 阈值在它们附近调整时, 归黑/归白会变化
    gray_spots = [
        (20, 110, 90), (21, 111, 160), (70, 120, 200),
        (100, 30, 120), (101, 31, 70), (175, 100, 150),
        (210, 160, 100), (45, 140, 180), (150, 240, 110),
    ]
    for y, x, gv in gray_spots:
        img[y, x] = gv

    return img


SAMPLES = {
    "default": make_sample,
}


def make_sample_named(name: str = "default", seed: int = 7) -> np.ndarray:
    return SAMPLES[name](seed=seed)
