#!/usr/bin/env python3
"""生成示例 .cube 颜色表与损坏样本，供测试和手动检查使用。

运行：
    python examples/make_samples.py
输出目录：examples/samples/
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np

from lut_tool.cube import CubeLUT, write_cube

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "samples")


def identity_1d(size: int = 33) -> CubeLUT:
    t = np.repeat(np.linspace(0, 1, size)[:, None], 3, axis=1)
    return CubeLUT("1D", size, np.zeros(3), np.ones(3), t, title="identity_1d")


def identity_3d(size: int = 17) -> CubeLUT:
    g = np.linspace(0, 1, size)
    r, gg, b = np.meshgrid(g, g, g, indexing="ij")
    t = np.stack([r, gg, b], axis=-1)
    return CubeLUT("3D", size, np.zeros(3), np.ones(3), t, title="identity_3d")


def warm_skin_shift_3d(size: int = 17) -> CubeLUT:
    """灰色基本不动、但暖区（肤色）明显偏色的问题表。

    对中性灰 (R≈G≈B) 影响接近 0；在 R>G>B 的暖色调里抬 R 压 B，
    模拟剪辑现场反馈的“灰色没事、一上肤色就偏”。
    """
    g = np.linspace(0, 1, size)
    r, gg, b = np.meshgrid(g, g, g, indexing="ij")
    warmth = np.clip(r - 0.5 * (gg + b), 0, 1)  # 暖度权重，灰区≈0
    out = np.stack(
        [
            np.clip(r + 0.22 * warmth, 0, 1),
            np.clip(gg + 0.05 * warmth, 0, 1),
            np.clip(b - 0.25 * warmth, 0, 1),
        ],
        axis=-1,
    )
    return CubeLUT("3D", size, np.zeros(3), np.ones(3), out,
                   title="warm_skin_shift_PROBLEM")


def channel_swap_3d(size: int = 9) -> CubeLUT:
    """R/B 通道整体互换：用于通道串换检测。"""
    g = np.linspace(0, 1, size)
    r, gg, b = np.meshgrid(g, g, g, indexing="ij")
    t = np.stack([b, gg, r], axis=-1)
    return CubeLUT("3D", size, np.zeros(3), np.ones(3), t,
                   title="rb_swap_PROBLEM")


def banded_1d(size: int = 33) -> CubeLUT:
    """带阶梯突变的 1D 曲线：连续几段被压成平台后突然跳变。"""
    x = np.linspace(0, 1, size)
    y = np.round(x * 8) / 8  # 8 级量化 => 明显 banding
    t = np.repeat(y[:, None], 3, axis=1)
    return CubeLUT("1D", size, np.zeros(3), np.ones(3), t,
                   title="banded_1d_PROBLEM")


def domain_scaled_1d(size: int = 17) -> CubeLUT:
    """声明窄输入域 [0.05, 0.95] 的表，用于范围外标记验证。"""
    t = np.repeat(np.linspace(0, 1, size)[:, None], 3, axis=1)
    return CubeLUT(
        "1D", size,
        np.full(3, 0.05), np.full(3, 0.95), t,
        title="narrow_domain_1d",
    )


def write_broken_files() -> None:
    # 行数对不上：声明 3D 5^3=125，只给 10 行。
    with open(os.path.join(OUT, "broken_wrong_rows.cube"), "w", encoding="utf-8") as fh:
        fh.write('TITLE "wrong rows"\nLUT_3D_SIZE 5\n')
        for _ in range(10):
            fh.write("0.5 0.5 0.5\n")

    # 坏 token，并给出所在行。
    with open(os.path.join(OUT, "broken_bad_token.cube"), "w", encoding="utf-8") as fh:
        fh.write("LUT_1D_SIZE 4\n0.0 0.0 0.0\n")
        fh.write("0.33 nope 0.33\n")
        fh.write("0.67 0.67 0.67\n1.0 1.0 1.0\n")

    # 数据行不是三列。
    with open(os.path.join(OUT, "broken_bad_arity.cube"), "w", encoding="utf-8") as fh:
        fh.write("LUT_1D_SIZE 3\n0.0 0.0\n0.5 0.5 0.5\n1.0 1.0 1.0\n")


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    samples = [
        identity_1d(),
        identity_3d(),
        warm_skin_shift_3d(),
        channel_swap_3d(),
        banded_1d(),
        domain_scaled_1d(),
    ]
    for lut in samples:
        path = os.path.join(OUT, lut.title + ".cube")
        write_cube(lut, path)
        print("written", path)
    write_broken_files()
    print("broken samples written to", OUT)


if __name__ == "__main__":
    main()
