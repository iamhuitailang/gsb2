"""核心管线测试。直接用程序生成的受控图，不依赖外部素材。"""

import os
import tempfile

import cv2
import numpy as np
import pytest

from sketchclean.batch import run_batch
from sketchclean.params import ProcessParams, Region
from sketchclean.pipeline import (detect_breaks, estimate_background,
                                  find_small_dots, flat_field_correct,
                                  process_array, process_file, roi_to_pixels,
                                  to_gray)


def make_image(shadow=True, faint_lines=True, solid_block=True, seed=0):
    """构造带已知内容的测试图：渐变阴影 + 浅线 + 实黑块 + 噪点。"""
    rng = np.random.default_rng(seed)
    h, w = 600, 800
    img = np.full((h, w), 235.0, np.float32)
    img += rng.normal(0, 2.0, (h, w))
    if shadow:
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        shade = 1.0 - 0.4 * np.clip(1.0 - xx / w - yy / h, 0, 1) ** 2
        img *= shade
    if faint_lines:
        cv2.line(img, (120, 300), (680, 300), 205, 2, cv2.LINE_AA)
        cv2.line(img, (400, 120), (400, 480), 200, 1, cv2.LINE_AA)
    if solid_block:
        cv2.rectangle(img, (550, 420), (720, 540), 20, -1)
    for _ in range(30):  # 传感器小点
        x, y = int(rng.integers(20, w - 20)), int(rng.integers(20, h - 20))
        cv2.circle(img, (x, y), int(rng.integers(1, 2)),
                   float(rng.integers(60, 140)), -1)
    return np.clip(img, 0, 255).astype(np.uint8)


# ---------------------------------------------------------- 背景校正

def test_background_is_smooth_no_hard_edges():
    img = make_image()
    bg, _ = estimate_background(img, ProcessParams())
    gx = np.abs(np.diff(bg.astype(np.int16), axis=1))
    gy = np.abs(np.diff(bg.astype(np.int16), axis=0))
    # 平滑场相邻像素差极小，不会制造粗黑边。
    assert gx.max() <= 2 and gy.max() <= 2


def test_shadow_is_flattened():
    img = make_image()
    p = ProcessParams()
    res = process_array(img, p)
    # 原图暗角与亮部差距大，清理后纸面亮度趋同（忽略实黑块区域）。
    corner = res.cleaned[:120, :120]
    bright = res.cleaned[60:180, 600:720]
    assert abs(corner.mean() - bright.mean()) < 18
    assert res.cleaned.mean() > img.mean() + 8


def test_solid_black_preserved():
    img = make_image()
    res = process_array(img, ProcessParams())
    block = res.cleaned[420:540, 550:720]
    assert block.mean() < 45          # 实黑没有被摊平
    # 暗像素总量比例基本保留（允许去点带来的微小变化）。
    assert abs((res.cleaned < 60).mean() - (img < 60).mean()) < 0.005


def test_faint_lines_survive():
    img = make_image()
    res = process_array(img, ProcessParams())
    line = res.cleaned[296:305, 200:600]
    paper = res.cleaned[180:260, 200:600]
    # 浅线处仍比周围纸面暗，且不是二值硬切。
    assert line.mean() < paper.mean() - 6
    assert len(np.unique(line)) > 20


def test_no_binary_thresholding_keeps_continuous_tone():
    img = make_image()
    res = process_array(img, ProcessParams())
    vals = np.unique(res.cleaned)
    # 连续灰阶输出：不同灰阶值远多于二值化结果，且浅线区间存在中间调。
    assert len(vals) > 40
    midtone = res.cleaned[(res.cleaned > 120) & (res.cleaned < 220)]
    assert midtone.size > 200


# ---------------------------------------------------------- 去点与检查

def test_despeckle_keeps_long_thin_lines():
    img = make_image()
    p = ProcessParams()
    res = process_array(img, p)
    # 水平浅线横跨 560px，去点后仍连续存在。
    strip = res.cleaned[295:306, 150:650]
    assert (strip.min(axis=0) < 215).sum() > 400


def test_dots_are_compact_only():
    img = make_image()
    p = ProcessParams()
    res = process_array(img, p)
    # 被标记的小点外接框填充率都应满足近圆判据。
    dark = (res.cleaned < p.ink_threshold).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(dark, 8)
    from sketchclean.pipeline import _area_threshold
    min_area = _area_threshold(min(img.shape), p)
    for lab in range(1, n):
        area = stats[lab, cv2.CC_STAT_AREA]
        if area < min_area and res.small_dot_mask[labels == lab].any():
            bw = max(1, stats[lab, cv2.CC_STAT_WIDTH])
            bh = max(1, stats[lab, cv2.CC_STAT_HEIGHT])
            assert area / (bw * bh) >= 0.45


def test_break_detection_finds_gap_but_not_polyline_corner():
    h, w = 400, 600
    img = np.full((h, w), 240, np.uint8)
    # 真实断线：两段直线中间空 8px。
    cv2.line(img, (100, 120), (250, 120), 60, 3)
    cv2.line(img, (258, 120), (420, 120), 60, 3)
    # 尖角折线（实体相连），不应被当成断裂。
    pts = np.array([[(100, 300), (220, 220), (340, 320), (480, 250)]], np.int32)
    cv2.polylines(img, pts, False, 60, 3, cv2.LINE_AA)
    p = ProcessParams()
    mask = detect_breaks(img, p)
    assert mask[116:125, 250:260].any()        # 断口被标出
    assert not mask[210:330, 200:360].any()    # 折线尖角无误报


# ---------------------------------------------------------- 分辨率一致性

def test_preview_and_full_res_equivalent_meaning():
    img = make_image()
    h, w = img.shape
    small = cv2.resize(img, (w // 2, h // 2), interpolation=cv2.INTER_AREA)
    p = ProcessParams()
    r_full = process_array(img, p)
    r_small = process_array(small, p)
    # 两分辨率输出的纸面亮度与对比度统计应接近（同一参数、同一管线）。
    assert abs(r_full.cleaned.mean() - r_small.cleaned.mean()) < 6
    full_iqr = np.percentile(r_full.cleaned, 90) - np.percentile(r_full.cleaned, 10)
    small_iqr = np.percentile(r_small.cleaned, 90) - np.percentile(r_small.cleaned, 10)
    assert abs(full_iqr - small_iqr) < 12


def test_roi_and_regions_use_normalized_coords():
    img = make_image()
    p = ProcessParams(roi=(0.1, 0.1, 0.9, 0.9))
    res = process_array(img, p)
    x0, y0, x1, y1 = res.roi_px
    assert (x1 - x0, y1 - y0) == (img.shape[1] * 0.8, img.shape[0] * 0.8)

    p2 = ProcessParams(regions=[Region(
        id="r1", points=[(0.0, 0.0), (0.4, 0.0), (0.4, 0.4), (0.0, 0.4)],
        mode="exclude")])
    res2 = process_array(img, p2)
    # 排除区域保留原图亮度（未被拉白）。
    excluded = res2.cleaned[10:120, 10:200]
    assert excluded.mean() < res2.cleaned.mean()


# ---------------------------------------------------------- 彩色输入

def test_color_input_supported():
    rng = np.random.default_rng(1)
    rgb = np.stack([make_image(seed=1)] * 3, axis=-1)
    rgb[..., 2] = np.clip(rgb[..., 2] + 20, 0, 255)  # 偏蓝
    gray = to_gray(rgb)
    assert gray.ndim == 2 and gray.dtype == np.uint8
    res = process_array(gray, ProcessParams())
    assert res.cleaned.shape == gray.shape


# ---------------------------------------------------------- 批量容错

def test_batch_isolates_failures(tmp_path):
    good = tmp_path / "good.png"
    cv2.imwrite(str(good), make_image())
    broken = tmp_path / "broken.png"
    broken.write_bytes(b"not an image")
    missing = tmp_path / "nope.png"  # 不存在的路径直接传给 batch
    out = tmp_path / "out"
    report = run_batch([str(good), str(broken)], str(out), ProcessParams())
    assert len(report.succeeded) == 1
    assert len(report.failed) == 1
    assert os.path.exists(os.path.join(out, "good.cleaned.png"))
    assert os.path.exists(os.path.join(out, "good.params.json"))
    assert os.path.exists(os.path.join(out, "batch_report.json"))
    # 失败项带原因，成功项不受影响。
    assert "error" in report.failed[0]

    with pytest.raises(FileNotFoundError):
        run_batch([str(missing)], str(out / "x"), ProcessParams())


def test_process_file_missing_raises():
    with pytest.raises(Exception):
        process_file("/nonexistent/xxx.png", ProcessParams())
