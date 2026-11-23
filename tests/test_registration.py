import cv2
import numpy as np
import pytest

from focus_stack.registration import (
    STATUS_FAIL,
    STATUS_OK,
    RegistrationConfig,
    align_images,
    edge_overlay,
    register_images,
)


def _structured_scene(rng, h=160, w=200):
    img = np.full((h, w), 40, np.uint8)
    cv2.rectangle(img, (25, 30), (80, 110), 210, -1)
    cv2.circle(img, (140, 90), 30, 160, -1)
    for _ in range(60):
        x, y = rng.integers(0, (w - 10, h - 10))
        cv2.line(img, (x, y), (x + 9, y + 4), 130, 1)
    return cv2.GaussianBlur(img, (3, 3), 0)


def _make_stack(rng, breathe=True):
    base = _structured_scene(rng)
    imgs = [base]
    h, w = base.shape
    for k in range(1, 4):
        t = k / 3
        if breathe:
            s = 1 + 0.025 * t
            m = np.array([[s, 0, 3 * t], [0, s, -2 * t]], np.float32)
        else:
            m = np.eye(2, 3, dtype=np.float32)
        imgs.append(cv2.warpAffine(base, m, (w, h)))
    return imgs


def test_registration_recovers_breathe_transform():
    rng = np.random.default_rng(1)
    imgs = _make_stack(rng)
    reg = register_images(imgs)
    assert all(it.status == STATUS_OK for it in reg.items)
    # 配准后各图与参考帧的差异应显著小于未配准时
    aligned = align_images(imgs, reg)
    for i in range(1, 4):
        err = np.abs(aligned[i].astype(int) - aligned[0].astype(int)).mean()
        raw = np.abs(imgs[i].astype(int) - imgs[0].astype(int)).mean()
        assert err < raw


def test_registration_flags_large_displacement():
    rng = np.random.default_rng(2)
    imgs = _make_stack(rng)
    h, w = imgs[0].shape
    # 最后一张：15% 缩放 + 12° 旋转 + 大平移
    angle = np.radians(12)
    cx, cy = w / 2, h / 2
    a, b = 1.15 * np.cos(angle), -1.15 * np.sin(angle)
    c, d = 1.15 * np.sin(angle), 1.15 * np.cos(angle)
    m = np.array([[a, b, cx - a * cx - b * cy + 0.12 * w],
                  [c, d, cy - c * cx - d * cy + 0.1 * h]], np.float32)
    imgs[-1] = cv2.warpAffine(imgs[-1], m, (w, h))
    reg = register_images(imgs)
    assert reg.items[-1].status == STATUS_FAIL
    assert not reg.items[-1].usable
    # 失败信息包含具体超阈项
    assert ("缩放" in reg.items[-1].message or "旋转" in reg.items[-1].message
            or "平移" in reg.items[-1].message)


def test_edge_overlay_shape_and_colors():
    rng = np.random.default_rng(3)
    imgs = _make_stack(rng)
    reg = register_images(imgs)
    overlay = edge_overlay(imgs, reg)
    assert overlay.shape == (*reg.ref_shape, 3)
    assert overlay.sum() > 0


def test_warn_thresholds_configurable():
    rng = np.random.default_rng(4)
    imgs = _make_stack(rng)
    # 配准后相关系数在 0.9995 上下，把警告线抬到 0.9999 应触发 warn/fail
    strict = RegistrationConfig(cc_warn=0.9999, cc_fail=0.99985)
    reg = register_images(imgs, cfg=strict)
    assert any(it.status != STATUS_OK for it in reg.items[1:])
