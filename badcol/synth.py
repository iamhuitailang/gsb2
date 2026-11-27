"""生成带已知坏列的模拟面阵扫描图。

每张图的背景与图案都不同(可检验算法不会把随帧变化的正常内容误判为坏列),
另外注入:
- persistent:  每帧都存在的固定坏列
- intermittent: 只在指定帧出现的竖线
- 三种注入形态: 固定偏置(offset) / 死列(dead) / 噪声列(noisy)
同时输出未注入缺陷的干净参考帧, 供 report 对比"真恢复"与"误删"。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .io_utils import save_image

RNG = np.random.default_rng


@dataclass
class DefectSpec:
    """一列坏线的注入规格。"""

    col: int
    kind: str = "offset"  # offset | dead | noisy
    frames: list[int] | None = None  # None 表示所有帧
    value: float = 60.0  # offset: 偏置; dead: 死列值; noisy: 噪声幅度

    def active_in(self, frame_index: int) -> bool:
        return self.frames is None or frame_index in self.frames


@dataclass
class SynthConfig:
    """合成参数。"""

    n_frames: int = 8
    height: int = 220
    width: int = 300
    seed: int = 42
    background_scale: float = 26.0
    noise_sigma: float = 3.0
    n_bands: int = 14  # 每帧随机竖带(正常内容)的数量
    n_lines: int = 6  # 每帧随机正常竖栏线的数量
    defects: list[DefectSpec] = field(default_factory=list)


def default_config(n_frames: int = 8, seed: int = 42) -> SynthConfig:
    """一份带代表性缺陷的默认配置: 固定坏列、相邻坏列、边沿坏列、偶发竖线。"""
    w = 300
    defects = [
        DefectSpec(col=37, kind="offset", value=70.0),            # 固定偏置列
        DefectSpec(col=38, kind="offset", value=55.0),            # 相邻坏列(连续 2 列)
        DefectSpec(col=2, kind="dead", value=8.0),                # 左沿死列
        DefectSpec(col=w - 1, kind="offset", value=-55.0),        # 右沿坏列
        DefectSpec(col=120, kind="noisy", value=45.0),            # 固定噪声列
        DefectSpec(col=210, kind="offset", frames=[2], value=65.0),   # 只在第 3 帧出现
        DefectSpec(col=255, kind="dead", frames=[0, 5], value=10.0),  # 只在两帧出现
    ]
    return SynthConfig(n_frames=n_frames, seed=seed, defects=defects)


def _clean_frame(rng: np.random.Generator, cfg: SynthConfig, f: int) -> np.ndarray:
    h, w = cfg.height, cfg.width
    # 缓慢变化的背景, 每张不同
    yy, xx = np.mgrid[0:h, 0:w]
    base = (
        110.0
        + cfg.background_scale * np.sin(xx / 38.0 + f * 0.9)
        + cfg.background_scale * 0.6 * np.cos(yy / 31.0 - f * 0.5)
        + rng.normal(0, 6.0, size=(h, w))
    )
    # 随机灰度竖带 —— 随帧变化的正常结构
    bands = rng.integers(0, w, size=cfg.n_bands)
    widths = rng.integers(6, 22, size=cfg.n_bands)
    shades = rng.normal(0, 22.0, size=cfg.n_bands)
    for c, bw, shade in zip(bands, widths, shades):
        lo, hi = max(0, c - bw // 2), min(w, c + bw // 2)
        base[:, lo:hi] += shade
    # 随机正常竖栏线 —— 单帧里可能与坏线形态相似, 用来考验检测
    line_cols = rng.integers(0, w, size=cfg.n_lines)
    line_vals = rng.normal(0, 35.0, size=cfg.n_lines)
    for c, v in zip(line_cols, line_vals):
        base[:, c] += v
    base += rng.normal(0, cfg.noise_sigma, size=(h, w))
    return np.clip(base, 0.0, 255.0)


def _apply_defect(
    frame: np.ndarray, spec: DefectSpec, f: int, rng: np.random.Generator
) -> None:
    if not spec.active_in(f):
        return
    col = frame[:, spec.col]
    if spec.kind == "offset":
        col += spec.value
    elif spec.kind == "dead":
        col[:] = spec.value
    elif spec.kind == "noisy":
        col[:] = np.clip(col, 0, 255).mean() + rng.normal(
            0.0, spec.value, size=col.shape
        )
    else:
        raise ValueError(f"未知缺陷类型: {spec.kind}")
    frame[:, spec.col] = np.clip(col, 0.0, 255.0)


def generate_batch(cfg: SynthConfig) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    """生成一个批次。

    返回:
        clean:    (N,H,W) 干净参考帧
        defective:(N,H,W) 注入坏线后的帧
        manifest: 每帧实际注入的列, 便于测试核对
    """
    rng = RNG(cfg.seed)
    clean, defective, manifest = [], [], []
    for f in range(cfg.n_frames):
        frame = _clean_frame(rng, cfg, f)
        clean.append(frame.copy())
        active = []
        for spec in cfg.defects:
            if spec.active_in(f):
                _apply_defect(frame, spec, f, rng)
                active.append(
                    {"col": spec.col, "kind": spec.kind, "value": spec.value}
                )
        defective.append(frame)
        manifest.append(active)
    return np.stack(clean), np.stack(defective), manifest


def write_batch(
    out_dir: str | Path,
    cfg: SynthConfig,
    defective: np.ndarray,
    clean: np.ndarray | None = None,
) -> dict:
    """把合成结果写到磁盘: defective/ 为输入帧, clean/ 为参考帧。"""
    out_dir = Path(out_dir)
    d_dir, c_dir = out_dir / "defective", out_dir / "clean"
    for f in range(cfg.n_frames):
        save_image(d_dir / f"frame_{f:03d}.png", defective[f])
        if clean is not None:
            save_image(c_dir / f"frame_{f:03d}.png", clean[f])
    return {
        "defective_dir": str(d_dir),
        "clean_dir": str(c_dir) if clean is not None else None,
        "manifest": [
            {
                "frame": f,
                "defects": [
                    {
                        "col": s.col,
                        "kind": s.kind,
                        "frames": list(range(cfg.n_frames))
                        if s.frames is None
                        else s.frames,
                        "value": s.value,
                    }
                    for s in cfg.defects
                ],
            }
            for f in range(cfg.n_frames)
        ],
        "height": cfg.height,
        "width": cfg.width,
        "n_frames": cfg.n_frames,
    }
