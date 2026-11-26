"""公共测试夹具。"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from blurlab import synth  # noqa: E402


@pytest.fixture(scope="session")
def board():
    img, meta = synth.generate_board(640, 460, seed=7)
    return img, meta


@pytest.fixture(scope="session")
def blurred_board(board):
    img, meta = board
    out = synth.kernel.blur_image(img, length_px=11.0, angle_deg=30.0, sigma=0.6)
    return synth.add_capture_noise(out, 0.008, seed=3)


@pytest.fixture()
def tmp_samples(tmp_path):
    paths = synth.save_sample_suite(
        tmp_path / "samples",
        width=520,
        height=380,
        seed=11,
        noise_sigma=0.01,
        variants=[(30.0, 9.0), (120.0, 15.0)],
    )
    return paths


def straight_edge_image(
    length_px: float,
    angle_deg: float,
    normal_deg: float,
    shape: tuple[int, int] = (160, 220),
    noise: float = 0.0,
    seed: int = 0,
) -> tuple[np.ndarray, np.ndarray]:
    """构造一条理想直边，沿 normal_deg 方向看是阶跃，再做拖影。"""
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    a = np.radians(normal_deg)
    nx, ny = np.cos(a), -np.sin(a)
    u = (xx - w / 2) * nx + (yy - h / 2) * ny
    clean = np.where(u > 0, 0.85, 0.15).astype(np.float32)
    clean = np.repeat(clean[..., None], 3, axis=2)
    blurred = synth.kernel.blur_image(clean, length_px, angle_deg, sigma=0.5)
    if noise > 0:
        blurred = synth.add_capture_noise(blurred, noise, seed=seed)
    return clean, blurred
