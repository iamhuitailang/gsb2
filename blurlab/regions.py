"""多区域管理：各自参数、确定的叠加次序、实际生效范围。

次序规则（确定且可解释）
------------------------
1. 每个区域有整数 ``priority``（越小越先处理）和创建顺序 ``seq``；
2. 生效次序按 ``(priority, seq)`` 升序，**后处理者覆盖先处理者**；
3. 重叠像素的最终归属 = 该像素上次序最靠后的那个区域（在羽化区内按权重
   归一化混合，但归属明确）。
4. 合成时用归一化权重：``w_i = mask_i * Π_{j after i}(1 - mask_j)``，再做
   ``Σ w_i = 1`` 的归一化，因此不会出现"两次去模糊再平均"的重复处理，也
   不会在某些像素上权重和大于 1 导致过冲。

``coverage_map`` 给出每个像素实际应用了哪个区域（或 0 = 不处理），GUI 用它
渲染实际应用范围的彩色覆盖与逐像素覆盖计数。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .deblur import DeblurParams
from .estimate import BlurEstimate
from .synth import feather_mask


@dataclass
class Region:
    label: str
    rect: tuple[int, int, int, int]
    params: DeblurParams
    feather_px: float = 10.0
    priority: int = 0
    enabled: bool = True
    estimate: BlurEstimate | None = None
    seq: int = 0
    last_stats: dict | None = None

    def to_dict(self) -> dict:
        return {
            "label": self.label,
            "rect": [int(v) for v in self.rect],
            "feather_px": float(self.feather_px),
            "priority": int(self.priority),
            "seq": int(self.seq),
            "enabled": bool(self.enabled),
            "params": self.params.to_dict(),
            "estimate": self.estimate.to_dict() if self.estimate else None,
            "last_stats": self.last_stats,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Region":
        p = d["params"]
        return cls(
            label=d["label"],
            rect=tuple(int(v) for v in d["rect"]),
            params=DeblurParams(
                length_px=p["length_px"],
                angle_deg=p["angle_deg"],
                noise_gain=p.get("noise_gain", 4.0),
                regularization=p.get("regularization", 2.5),
                shadow_limit=p.get("shadow_limit", 0.18),
                overshoot=p.get("overshoot", 0.20),
            ),
            feather_px=d.get("feather_px", 10.0),
            priority=d.get("priority", 0),
            enabled=d.get("enabled", True),
            seq=d.get("seq", 0),
            last_stats=d.get("last_stats"),
        )


def normalize_rect(rect: tuple[float, float, float, float], w: int, h: int) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = [int(round(v)) for v in rect]
    x0, x1 = sorted((x0, x1))
    y0, y1 = sorted((y0, y1))
    x0 = max(0, min(x0, w - 1))
    y0 = max(0, min(y0, h - 1))
    x1 = max(x0 + 1, min(x1, w))
    y1 = max(y0 + 1, min(y1, h))
    return x0, y0, x1, y1


@dataclass
class RegionSet:
    width: int
    height: int
    regions: list[Region] = field(default_factory=list)
    _seq: int = 0

    def add(
        self,
        rect: tuple[float, float, float, float],
        params: DeblurParams,
        label: str | None = None,
        feather_px: float = 10.0,
        priority: int | None = None,
        estimate: BlurEstimate | None = None,
    ) -> Region:
        self._seq += 1
        rect_n = normalize_rect(rect, self.width, self.height)
        if label is None:
            label = f"R{self._seq}"
        if priority is None:
            priority = self._seq
        region = Region(
            label=label,
            rect=rect_n,
            params=params,
            feather_px=float(feather_px),
            priority=int(priority),
            estimate=estimate,
            seq=self._seq,
        )
        self.regions.append(region)
        return region

    def remove(self, region: Region) -> None:
        if region in self.regions:
            self.regions.remove(region)

    def ordered(self) -> list[Region]:
        """生效次序：priority 升序，同优先级按创建顺序。后者覆盖前者。"""
        return sorted([r for r in self.regions if r.enabled], key=lambda r: (r.priority, r.seq))

    def masks(self) -> list[np.ndarray]:
        out = []
        for r in self.ordered():
            out.append(feather_mask((self.height, self.width), r.rect, r.feather_px))
        return out

    def coverage_map(self) -> tuple[np.ndarray, np.ndarray]:
        """返回 (owner, count)。

        owner: (H,W) int，-1 表示不处理，否则为 ordered 中的下标；
        count: (H,W) int，该像素被多少个区域覆盖（羽化权重 > 0）。
        """
        ordered = self.ordered()
        owner = np.full((self.height, self.width), -1, dtype=np.int32)
        count = np.zeros((self.height, self.width), dtype=np.int32)
        for i, r in enumerate(ordered):
            m = feather_mask((self.height, self.width), r.rect, r.feather_px)
            hit = m > 1e-4
            count += hit.astype(np.int32)
            owner[hit] = i
        return owner, count

    def overlap_report(self) -> list[dict]:
        """两两区域的重叠像素数与重叠占比，用于 UI 显示次序影响。"""
        ordered = self.ordered()
        masks = self.masks()
        hits = [m > 1e-4 for m in masks]
        report = []
        for i in range(len(ordered)):
            for j in range(i + 1, len(ordered)):
                inter = int(np.count_nonzero(hits[i] & hits[j]))
                if inter == 0:
                    continue
                smaller = max(1, min(int(hits[i].sum()), int(hits[j].sum())))
                report.append(
                    {
                        "earlier": ordered[i].label,
                        "later": ordered[j].label,
                        "overlap_px": inter,
                        "overlap_fraction_of_smaller": inter / smaller,
                        "winner": ordered[j].label,
                    }
                )
        return report

    def blend(
        self,
        original: np.ndarray,
        processed: dict[str, np.ndarray],
    ) -> np.ndarray:
        """按确定次序合成。

        processed: label -> 已处理的全尺寸或区域尺寸图像（区域尺寸会贴回全图）。
        优先级靠后的区域在重叠处覆盖靠前的：权重按
        ``w_i = m_i · Π_{j>i}(1 - m_j)`` 计算，满足 ``Σ w_i ≤ 1``，
        未被覆盖的像素保留原图：

            out = original · (1 - Σw) + Σ img_i · w_i
        """
        h, w = original.shape[:2]
        ordered = self.ordered()
        if not ordered:
            return np.asarray(original, dtype=np.float32).copy()

        masks = [feather_mask((h, w), r.rect, r.feather_px) for r in ordered]
        n = len(ordered)
        weights: list[np.ndarray] = [np.zeros((h, w), dtype=np.float32)] * n
        survivor = np.ones((h, w), dtype=np.float32)
        for i in range(n - 1, -1, -1):
            weights[i] = masks[i] * survivor
            survivor = survivor * (1.0 - masks[i])

        total = np.sum(weights, axis=0)
        total = np.clip(total, 0.0, 1.0)
        out = np.asarray(original, dtype=np.float32) * (1.0 - total)[..., None]
        for r, wgt in zip(ordered, weights):
            img = processed.get(r.label)
            img = _fit_to_full(img if img is not None else original, r.rect, original)
            out = out + img * wgt[..., None]
        return np.clip(out, 0.0, 1.0).astype(np.float32)


def _fit_to_full(img: np.ndarray, rect: tuple[int, int, int, int], full: np.ndarray) -> np.ndarray:
    """把区域尺寸的结果贴回全图，其余像素填原图。"""
    a = np.asarray(img, dtype=np.float32)
    h, w = full.shape[:2]
    if a.shape[:2] == (h, w):
        return a
    x0, y0, x1, y1 = rect
    canvas = np.asarray(full, dtype=np.float32).copy()
    canvas[y0:y1, x0:x1] = a
    return canvas


def coverage_overlay(
    original: np.ndarray,
    region_set: RegionSet,
    mode: str = "owner",
    alpha: float = 0.45,
) -> np.ndarray:
    """把实际生效范围画成彩色覆盖层。

    mode="owner": 每个区域一种颜色，重叠处显示最终归属（后处理者）；
    mode="count": 覆盖计数热力图（1=单层，>1=重叠）。
    """
    h, w = original.shape[:2]
    base = np.asarray(original, dtype=np.float32)
    owner, count = region_set.coverage_map()
    overlay = base.copy()

    if mode == "count":
        heat = np.clip(count, 0, 3) / 3.0
        color = np.stack(
            [heat, np.zeros_like(heat), 1.0 - heat], axis=-1
        ).astype(np.float32)
        active = count > 0
    else:
        palette = np.array(
            [
                [0.95, 0.35, 0.25],
                [0.25, 0.65, 0.95],
                [0.35, 0.85, 0.40],
                [0.95, 0.80, 0.25],
                [0.75, 0.40, 0.90],
                [0.20, 0.85, 0.80],
            ],
            dtype=np.float32,
        )
        color = np.zeros_like(base)
        active = owner >= 0
        np.clip(owner, 0, None, out=owner)
        # 按区域下标取模调色板，区域多于此也能区分相邻区域
        idx = np.where(active, owner % len(palette), 0)
        color[active] = palette[idx[active]]

    overlay[active] = (1.0 - alpha) * base[active] + alpha * color[active]
    return np.clip(overlay, 0.0, 1.0).astype(np.float32)
