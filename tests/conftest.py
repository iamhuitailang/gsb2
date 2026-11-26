"""pytest 公共夹具：小型合成场景，几秒内可跑完。"""

import math

import cv2
import numpy as np
import pytest

from markfinder.matching import warp_pose
from markfinder.synthetic import render_shape
from markfinder.template import Template


@pytest.fixture(scope="session")
def arrow_template() -> Template:
    return render_shape("arrow", size=80)


@pytest.fixture(scope="session")
def asym_template() -> Template:
    """非对称形状（L 形带单方向钩），水平翻面在外观上可区分。"""
    return render_shape("asym", size=96)


@pytest.fixture()
def scene_with_marks(arrow_template):
    """一张图里放 5 个不同角度/缩放的箭头，外加 1 个星形干扰。"""
    rng = np.random.default_rng(7)
    h, w = 640, 800
    scene = np.full((h, w, 3), 232, np.uint8)
    instances = [
        (150, 140, 15.0, 1.0, False),
        (420, 130, 95.0, 0.85, False),
        (650, 220, 200.0, 1.15, False),
        (250, 460, 300.0, 0.95, False),
        (560, 480, 70.0, 1.1, False),
    ]
    for cx, cy, ang, sc, flip in instances:
        warped, wmask, _, s = warp_pose(arrow_template, ang, sc, flip)
        top, left = int(cy - s / 2), int(cx - s / 2)
        sub = scene[max(top, 0):top + s, max(left, 0):left + s]
        m = wmask[max(-top, 0):sub.shape[0] + max(-top, 0),
                  max(-left, 0):sub.shape[1] + max(-left, 0)] > 0
        sub[m] = warped[max(-top, 0):sub.shape[0] + max(-top, 0),
                        max(-left, 0):sub.shape[1] + max(-left, 0)][m]

    # 干扰项：星形，不应被箭头模板高分匹配
    star = render_shape("star", size=80, color=(40, 130, 90))
    warped, wmask, _, s = warp_pose(star, 40.0, 1.0, False)
    top, left = 70, 680 - s // 2
    sub = scene[top:top + s, left:left + s]
    m = wmask[:sub.shape[0], :sub.shape[1]] > 0
    sub[m] = warped[:sub.shape[0], :sub.shape[1]][m]
    return scene, instances
