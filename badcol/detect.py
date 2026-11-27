"""逐帧列剖面分析与坏列检测。

思路:
1. 对每个像素用同帧相邻列(默认左右各 2 列)的逐行中位数做基线, 得到残差;
2. 两遍扫描: 第一遍找出明显异常列, 第二遍把这些列从邻居基线里剔除,
   避免连续坏列互相"参考"; 没有可用邻居时标记 reliable_baseline=False;
3. 每列每帧同时看残差中位数(偏置/死列)与残差稳健标准差(噪声列);
4. 按命中帧数区分 persistent(总是异常) 与 intermittent(少数帧异常),
   全部证据(命中帧、残差、方向、分数)随结果返回, 支持手动补选/排除。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class DetectConfig:
    neighbor_radius: int = 2
    z_thresh: float = 4.5          # 偏置/死列判定阈值(以全局稳健噪声为单位)
    z_noise_thresh: float = 3.5    # 噪声列判定阈值
    min_abs: float = 8.0           # 偏置残差的最小绝对灰度门限
    min_sd: float = 10.0           # 残差标准差的最小门限
    persist_ratio: float = 0.8     # 命中比例达到该值视为固定坏列
    rough_hit_ratio: float = 0.3   # 两遍扫描中, 列被剔出邻居基线的命中比例门限


@dataclass
class ColumnEvidence:
    """单列在整个批次上的证据。"""

    col: int
    hits: int
    frames: list[int]
    persistence: float
    mean_residual: float       # 命中帧残差中位数的平均(带符号)
    mean_abs_resid: float
    max_abs_resid: float
    residual_sd: float         # 命中帧逐行残差稳健标准差的平均
    kind_hint: str             # offset | noisy
    direction: str             # bright | dark | mixed
    score: float
    reliable_baseline: bool
    confidence: str            # strong: 多帧复现; weak: 仅少数帧, 需人工确认

    def label(self, persist_ratio: float) -> str:
        if self.persistence >= persist_ratio:
            return "persistent"
        return "intermittent"

    def to_dict(self) -> dict:
        return {
            "col": self.col,
            "hits": self.hits,
            "frames": self.frames,
            "persistence": round(self.persistence, 4),
            "mean_residual": round(self.mean_residual, 3),
            "mean_abs_resid": round(self.mean_abs_resid, 3),
            "max_abs_resid": round(self.max_abs_resid, 3),
            "residual_sd": round(self.residual_sd, 3),
            "kind_hint": self.kind_hint,
            "direction": self.direction,
            "score": round(self.score, 3),
            "reliable_baseline": self.reliable_baseline,
            "confidence": self.confidence,
        }


@dataclass
class DetectionResult:
    height: int
    width: int
    n_frames: int
    config: DetectConfig
    noise_per_frame: list[float]
    evidences: list[ColumnEvidence]
    # 每帧每列的残差中位数/稳健标准差, 供剖面视图与测试复用
    frame_median_resid: np.ndarray   # (N, W)
    frame_robust_sd: np.ndarray      # (N, W)
    reliable: np.ndarray             # (N, W) bool, 基线是否可靠

    def evidence_map(self) -> dict[int, ColumnEvidence]:
        return {e.col: e for e in self.evidences}

    def columns_by_label(self) -> dict[str, list[int]]:
        ratio = self.config.persist_ratio
        out: dict[str, list[int]] = {"persistent": [], "intermittent": []}
        for e in self.evidences:
            out[e.label(ratio)].append(e.col)
        return out

    def summary_lines(self) -> list[str]:
        groups = self.columns_by_label()
        lines = [
            f"批次: {self.n_frames} 帧, 尺寸 {self.height}x{self.width}",
            f"固定坏列({len(groups['persistent'])}): {groups['persistent']}",
            f"少数帧异常列({len(groups['intermittent'])}): {groups['intermittent']}",
        ]
        for e in self.evidences:
            lines.append(
                f"  列 {e.col:>4d} [{e.label(self.config.persist_ratio):>13s}] "
                f"命中 {e.hits}/{self.n_frames} 帧 {e.frames} "
                f"均残差 {e.mean_residual:+.1f} 方向 {e.direction} "
                f"类型 {e.kind_hint} 分数 {e.score:.1f}"
                + ("" if e.reliable_baseline else "  [基线不可靠]")
            )
        return lines


def _neighbor_baseline(
    frames: np.ndarray, bad: np.ndarray | None, radius: int
) -> tuple[np.ndarray, np.ndarray]:
    """逐帧逐行求邻居列中位数基线。

    bad 为 (W,) bool 时, 对应列不参与邻居计算(第二遍)。
    返回 (baseline (N,H,W), reliable (N,H,W))。
    """
    n, h, w = frames.shape
    baseline = np.full((n, h, w), np.nan)
    reliable = np.zeros((n, h, w), dtype=bool)
    for c in range(w):
        lo, hi = max(0, c - radius), min(w, c + radius + 1)
        neigh = [k for k in range(lo, hi) if k != c]
        if bad is not None:
            neigh = [k for k in neigh if not bad[k]]
        if not neigh:
            continue
        baseline[:, :, c] = np.median(frames[:, :, neigh], axis=2)
        reliable[:, :, c] = True
    return baseline, reliable


def detect_columns(
    frames_gray: np.ndarray, config: DetectConfig | None = None
) -> DetectionResult:
    """对灰度批次 (N,H,W) 做坏列检测。"""
    if frames_gray.ndim != 3:
        raise ValueError("detect_columns 需要 (N,H,W) 灰度批次")
    cfg = config or DetectConfig()
    n, h, w = frames_gray.shape

    base1, _ = _neighbor_baseline(frames_gray, None, cfg.neighbor_radius)
    resid1 = frames_gray - base1
    # 全局稳健噪声: 所有帧所有像素残差的 MAD。逐帧 MAD 会被随机正常竖线放大,
    # 反而抬高阈值漏掉弱坏列, 这里用整批的中位尺度。
    noise = np.full(
        n, max(1.4826 * np.nanmedian(np.abs(resid1 - np.nanmedian(resid1))), 1e-6)
    )

    med1 = np.nanmedian(resid1, axis=1)          # (N,W)
    sd1 = 1.4826 * np.nanmedian(
        np.abs(resid1 - med1[:, None, :]), axis=1
    )
    off_thr = np.maximum(cfg.z_thresh * noise[:, None], cfg.min_abs)
    sd_thr = np.maximum(cfg.z_noise_thresh * noise[:, None], cfg.min_sd)
    hit1 = (np.abs(med1) > off_thr) | (sd1 > sd_thr)
    # 第二遍基线要剔除的列: 在足够多帧里命中(偶发竖线只命中 1 帧, 不会被剔除),
    # 同时保证连续坏列互相不做邻居。
    rough_bad = np.mean(hit1, axis=0) >= cfg.rough_hit_ratio

    base2, rel2 = _neighbor_baseline(
        frames_gray, rough_bad, cfg.neighbor_radius
    )
    # 第二遍不可靠的位置回退第一遍
    usable = rel2
    baseline = np.where(usable, base2, base1)
    reliable_cell = np.broadcast_to(usable, (n, h, w))
    resid = frames_gray - baseline

    med = np.nanmedian(resid, axis=1)
    sd = 1.4826 * np.nanmedian(np.abs(resid - med[:, None, :]), axis=1)
    hits = (np.abs(med) > off_thr) | (sd > sd_thr)

    evidences: list[ColumnEvidence] = []
    for c in range(w):
        frames_hit = np.flatnonzero(hits[:, c]).tolist()
        if not frames_hit:
            continue
        signed = med[frames_hit, c]
        sd_hit = sd[frames_hit, c]
        abs_res = np.abs(signed)
        pos = np.mean(signed > 0)
        direction = "bright" if pos >= 0.8 else "dark" if pos <= 0.2 else "mixed"
        kind_hint = "noisy" if np.mean(sd_hit) > np.mean(abs_res) else "offset"
        # 只命中 1~2 帧的可能是正常竖栏线恰好落在同列(无缺陷批次实测会出现),
        # 统一标弱候选写进证据报告, 由人工在 GUI 补选; 3 帧及以上才算可复现强候选
        confidence = "strong" if len(frames_hit) >= 3 else "weak"
        evidences.append(
            ColumnEvidence(
                col=c,
                hits=len(frames_hit),
                frames=frames_hit,
                persistence=len(frames_hit) / n,
                mean_residual=float(np.mean(signed)),
                mean_abs_resid=float(np.mean(abs_res)),
                max_abs_resid=float(np.max(abs_res)),
                residual_sd=float(np.mean(sd_hit)),
                kind_hint=kind_hint,
                direction=direction,
                score=float(
                    np.mean(abs_res / noise[frames_hit])
                    + np.mean(sd_hit / noise[frames_hit])
                ),
                reliable_baseline=bool(np.all(reliable_cell[:, :, c])),
                confidence=confidence,
            )
        )
    evidences.sort(key=lambda e: (-e.score, e.col))
    return DetectionResult(
        height=h,
        width=w,
        n_frames=n,
        config=cfg,
        noise_per_frame=[float(x) for x in noise],
        evidences=evidences,
        frame_median_resid=med,
        frame_robust_sd=sd,
        reliable=reliable_cell[:, 0, :].copy(),
    )


@dataclass
class ColumnSelection:
    """手动选区: 在自动检测结果上补选/排除/保护。

    included: 列 -> 生效帧列表; None 表示所有帧(固定坏列)
    excluded: 被人工排除的自动候选列(整列排除)
    protected: 保护列, 修补时一律跳过
    """

    included: dict[int, list[int] | None] = field(default_factory=dict)
    excluded: set[int] = field(default_factory=set)
    protected: set[int] = field(default_factory=set)

    def toggle_include(self, col: int, frames: list[int] | None = None) -> None:
        self.excluded.discard(col)
        if col in self.included:
            del self.included[col]
        else:
            self.included[col] = None if frames is None else sorted(set(frames))

    def toggle_exclude(self, col: int) -> None:
        self.included.pop(col, None)
        if col in self.excluded:
            self.excluded.discard(col)
        else:
            self.excluded.add(col)

    def toggle_protect(self, col: int) -> None:
        if col in self.protected:
            self.protected.discard(col)
        else:
            self.protected.add(col)

    def effective(self, detection: DetectionResult) -> dict[int, list[int] | None]:
        """合并自动检测与手动操作后的最终坏列选择。"""
        ratio = detection.config.persist_ratio
        merged: dict[int, list[int] | None] = {}
        for e in detection.evidences:
            if e.col in self.excluded:
                continue
            merged[e.col] = (
                None
                if e.label(ratio) == "persistent"
                else e.frames
            )
        for col, frames in self.included.items():
            merged[col] = frames
        return dict(sorted(merged.items()))

    def selected_cols(self, detection: DetectionResult) -> list[int]:
        return sorted(self.effective(detection).keys())

    def columns_for_frame(self, detection: DetectionResult, f: int) -> list[int]:
        out = []
        for col, frames in self.effective(detection).items():
            if frames is None or f in frames:
                out.append(col)
        return out

    def apply_strong_only(self, detection: DetectionResult) -> "ColumnSelection":
        """把所有只命中 1~2 帧的弱候选整列排除, 返回自身(便于链式调用)。

        弱候选多为随机正常竖线与列位置巧合, 保留在 evidence.json 中,
        由人工在 GUI 里按需补选。
        """
        for e in detection.evidences:
            if e.confidence == "weak":
                self.excluded.add(e.col)
        return self
