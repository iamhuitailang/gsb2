"""端到端管线：读图 → 配准 → 清晰度 → 选择 → 融合。

GUI 和测试都走这条管线，保证行为一致。
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from .fusion import FusionResult, fuse, inspect_point
from .geometry import identity
from .registration import (
    Registration,
    RegistrationConfig,
    align_images,
    edge_overlay,
    register_images,
)
from .selection import (
    PinSet,
    SelectionConfig,
    compute_labels,
    failed_sources,
    ghost_map,
    ghost_summary,
    soft_weights,
)
from .sharpness import SharpnessConfig, sharpness_maps


@dataclass
class PipelineResult:
    images: list[np.ndarray]          # 原图（用户顺序）
    aligned: list[np.ndarray]         # 配准到参考帧
    registration: Registration
    scores: np.ndarray                # (N,H,W)
    labels: np.ndarray                # (H,W)
    weights: np.ndarray               # (N,H,W)
    ghost: np.ndarray                 # (H,W)
    ghost_stats: dict
    fusion: FusionResult
    pins: PinSet
    valid_mask: np.ndarray
    usable: list[int]
    temperature: float = 8.0
    sel_cfg: SelectionConfig = field(default_factory=SelectionConfig)


def load_images(paths: list[str]) -> list[np.ndarray]:
    imgs = []
    for p in paths:
        img = cv2.imread(p, cv2.IMREAD_COLOR)
        if img is None:
            raise FileNotFoundError(f"无法读取图像: {p}")
        imgs.append(img)
    return imgs


def run_pipeline(images: list[np.ndarray],
                 pins: PinSet | None = None,
                 reg_cfg: RegistrationConfig | None = None,
                 sharp_cfg: SharpnessConfig | None = None,
                 sel_cfg: SelectionConfig | None = None,
                 temperature: float = 8.0,
                 fusion_mode: str = "soft",
                 coverage_mode: str = "keep",
                 existing_reg: Registration | None = None,
                 progress=None) -> PipelineResult:
    """跑完整管线。

    existing_reg: 工程重开时复用已保存的配准（pin 是矢量的，配准不变就不用重算）。
    progress(done, total, phase): 简单进度回调。
    """
    pins = pins or PinSet()
    sharp_cfg = sharp_cfg or SharpnessConfig()
    sel_cfg = sel_cfg or SelectionConfig()

    def _prog(d, t, phase):
        if progress:
            progress(d, t, phase)

    _prog(0, 4, "配准")
    if existing_reg is None:
        reg = register_images(images, 0, reg_cfg)
    else:
        reg = existing_reg
        # 重算覆盖掩码（加载工程时未恢复）；ECC 矩阵是 ref->src，取逆得 src->ref
        for it in reg.items:
            if it.coverage is None:
                from .geometry import coverage_mask, invert_affine
                m = identity() if it.index == reg.ref_index else invert_affine(it.matrix)
                it.coverage = coverage_mask(
                    m, images[it.index].shape[:2], reg.ref_shape)
        if reg.common_mask is None:
            from .geometry import common_coverage
            reg.common_mask = common_coverage(
                [it.coverage for it in reg.items if it.usable])

    _prog(1, 4, "对齐")
    aligned = align_images(images, reg)
    usable = reg.usable_indices()
    valid = reg.common_mask

    _prog(2, 4, "清晰度")
    scores = sharpness_maps(aligned, sharp_cfg)
    # 失败源不参与：把其分数压到最低
    for idx in failed_sources(reg):
        scores[idx] = -1.0

    _prog(3, 4, "选择与融合")
    labels = compute_labels(scores, valid, usable, pins, sel_cfg)
    weights = soft_weights(scores, labels, usable, temperature)
    ghost = ghost_map(aligned, labels, usable, sel_cfg)
    gstats = ghost_summary(ghost, labels, sel_cfg)
    fusion = fuse(aligned, labels, weights, valid, fusion_mode, coverage_mode)

    _prog(4, 4, "完成")
    return PipelineResult(
        images=images, aligned=aligned, registration=reg, scores=scores,
        labels=labels, weights=weights, ghost=ghost, ghost_stats=gstats,
        fusion=fusion, pins=pins, valid_mask=valid, usable=usable,
        temperature=temperature, sel_cfg=sel_cfg)  # 复用同一 PinSet 实例，
        # 调用方（AppState）后续增量加 pin 时结果立即可见


def refusion_only(result: PipelineResult,
                  temperature: float | None = None,
                  fusion_mode: str | None = None,
                  coverage_mode: str | None = None,
                  sel_cfg: SelectionConfig | None = None) -> PipelineResult:
    """只重算选择/融合（增删 pin 后调用），配准与清晰度复用，其他 pin 保留。"""
    if temperature is None:
        temperature = result.temperature
    fusion_mode = fusion_mode or result.fusion.mode
    coverage_mode = coverage_mode or (
        "crop" if result.fusion.bbox is not None else "keep")
    cfg = sel_cfg or result.sel_cfg
    labels = compute_labels(result.scores, result.valid_mask,
                            result.usable, result.pins, cfg)
    weights = soft_weights(result.scores, labels, result.usable, temperature)
    ghost = ghost_map(result.aligned, labels, result.usable, cfg)
    gstats = ghost_summary(ghost, labels, cfg)
    fusion = fuse(result.aligned, labels, weights, result.valid_mask,
                  fusion_mode, coverage_mode)
    result.labels = labels
    result.weights = weights
    result.ghost = ghost
    result.ghost_stats = gstats
    result.fusion = fusion
    result.temperature = temperature
    return result


def point_info(result: PipelineResult, x: int, y: int) -> dict:
    """点击回看。裁剪模式下自动把显示坐标换算回全帧坐标。"""
    bbox = result.fusion.bbox
    if bbox is not None:
        x += bbox[0]
        y += bbox[1]
    return inspect_point(x, y, result.labels, result.scores,
                         result.usable, result.aligned, result.registration)


def overlay_edges(result: PipelineResult) -> np.ndarray:
    return edge_overlay(result.images, result.registration)
