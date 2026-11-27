"""坏列修补。

修补规则:
- 对每帧实际生效的坏列, 用同帧左右健康列做线性插值;
- 保护列(protected)不参与修补、也不被当作参考邻居;
- 图片左右边沿的坏列: 只有单侧健康列时退化为最近邻复制, 并标记 edge_copy;
  单侧也没有健康列时标记 unrepaired;
- 连续坏列超过 max_span、或两侧凑不齐两个健康参考时标记 unreliable,
  这些位置仍然填值(尽量不空洞), 但在结果里明确可见, 不冒充可靠恢复;
- 未选中的像素保证逐字节不变, 由 assert_unchanged 校验。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# 单元格修补状态
REPAIRED = "repaired"          # 双侧插值, 可靠
EDGE_COPY = "edge_copy"        # 边沿单侧复制, 降级但可用
UNRELIABLE = "unreliable"      # 连续坏列过宽/参考不足, 填了但不可信
UNREPAIRED = "unrepaired"      # 无任何健康邻居, 保留原值
PROTECTED = "protected"        # 在保护范围内, 不动

_FILL_STATES = {REPAIRED, EDGE_COPY, UNRELIABLE}


@dataclass
class RepairConfig:
    max_span: int = 3          # 连续坏列超过该长度视为不可靠
    edge_radius: int = 1       # 距离左右边沿多少列内按边沿规则处理


@dataclass
class FrameRepair:
    frame_index: int
    repaired: np.ndarray
    states: dict[int, str]     # 列 -> 状态
    n_changed_cells: int
    max_abs_diff: float
    mean_abs_diff: float


@dataclass
class RepairResult:
    repaired: np.ndarray               # (N,H,W) 或 (N,H,W,C)
    states: list[dict[int, str]]
    repairs: list[FrameRepair]
    protected_cols: list[int]

    def unreliable_columns(self) -> dict[int, list[int]]:
        """返回 帧 -> 不可靠/未修补列, 供界面高亮。"""
        out: dict[int, list[int]] = {}
        for f, st in enumerate(self.states):
            bad = sorted(
                c for c, s in st.items() if s in (UNRELIABLE, UNREPAIRED)
            )
            if bad:
                out[f] = bad
        return out

    def stats_rows(self, frame_names: list[str]) -> list[dict]:
        rows = []
        for f, rep in enumerate(self.repairs):
            counts: dict[str, int] = {}
            for s in rep.states.values():
                counts[s] = counts.get(s, 0) + 1
            rows.append(
                {
                    "frame": frame_names[f] if f < len(frame_names) else str(f),
                    "changed_cells": rep.n_changed_cells,
                    "repaired_cols": counts.get(REPAIRED, 0),
                    "edge_copy_cols": counts.get(EDGE_COPY, 0),
                    "unreliable_cols": counts.get(UNRELIABLE, 0),
                    "unrepaired_cols": counts.get(UNREPAIRED, 0),
                    "protected_cols": counts.get(PROTECTED, 0),
                    "max_abs_diff": round(rep.max_abs_diff, 3),
                    "mean_abs_diff": round(rep.mean_abs_diff, 4),
                }
            )
        return rows


def _components(cols: list[int]) -> list[list[int]]:
    """把排序列表切成连续段。"""
    if not cols:
        return []
    comps, cur = [], [cols[0]]
    for c in cols[1:]:
        if c == cur[-1] + 1:
            cur.append(c)
        else:
            comps.append(cur)
            cur = [c]
    comps.append(cur)
    return comps


def _find_healthy(
    start: int, step: int, width: int, blocked: set[int]
) -> int | None:
    c = start
    while 0 <= c < width:
        if c not in blocked:
            return c
        c += step
    return None


def repair_frame(
    frame: np.ndarray,
    bad_cols: list[int],
    protected: set[int],
    config: RepairConfig,
    frame_index: int = 0,
) -> FrameRepair:
    """修补单帧(灰度 2D 或彩色 3D)。"""
    out = frame.copy()
    width = frame.shape[1]
    blocked = set(bad_cols) | set(protected)
    states: dict[int, str] = {}
    for c in protected:
        if c in bad_cols:  # 保护优先: 坏列落在保护范围内也不动
            states[c] = PROTECTED

    for comp in _components(sorted(set(bad_cols) - set(protected))):
        left = _find_healthy(comp[0] - 1, -1, width, blocked)
        right = _find_healthy(comp[-1] + 1, 1, width, blocked)
        span_too_wide = len(comp) > config.max_span
        # 连续坏段贴着图像边沿且只有单侧健康邻居 -> 边沿降级复制
        comp_at_edge = (
            comp[0] <= config.edge_radius
            or comp[-1] >= width - 1 - config.edge_radius
        )

        if left is None and right is None:
            for c in comp:
                states[c] = UNREPAIRED
            continue

        axis = 1
        for c in comp:
            if left is not None and right is not None:
                weight = (c - left) / (right - left)
                vals = (
                    frame.take(left, axis=axis) * (1.0 - weight)
                    + frame.take(right, axis=axis) * weight
                )
                state = UNRELIABLE if span_too_wide else REPAIRED
            else:
                ref = left if left is not None else right
                vals = frame.take(ref, axis=axis).copy()
                # 只有单侧参考: 贴边沿按降级复制(可见但可用);
                # 内部列出现这种情况说明连续坏列吃掉了一侧邻居, 标不可靠
                state = EDGE_COPY if comp_at_edge else UNRELIABLE
            out[:, c] = vals
            states[c] = state

    diff = np.abs(out - frame)
    changed_mask = np.any(diff > 0, axis=tuple(range(2, diff.ndim)))
    n_changed = int(changed_mask.sum())
    changed_vals = diff[changed_mask] if n_changed else diff[np.zeros_like(diff, bool)]
    return FrameRepair(
        frame_index=frame_index,
        repaired=out,
        states=dict(sorted(states.items())),
        n_changed_cells=n_changed,
        max_abs_diff=float(diff.max(initial=0.0)),
        mean_abs_diff=float(changed_vals.mean()) if n_changed else 0.0,
    )


def repair_batch(
    frames: np.ndarray,
    selection_per_frame: list[list[int]],
    protected: list[int] | set[int] | None = None,
    config: RepairConfig | None = None,
) -> RepairResult:
    """修补整批。selection_per_frame[f] 为第 f 帧实际要修的列。"""
    cfg = config or RepairConfig()
    prot = set(protected or [])
    if frames.ndim not in (3, 4):
        raise ValueError("repair_batch 需要 (N,H,W) 或 (N,H,W,C) 批次")
    if len(selection_per_frame) != frames.shape[0]:
        raise ValueError("每帧选择列表长度必须与批次数一致")
    width = frames.shape[2]
    for f, cols in enumerate(selection_per_frame):
        bad = [c for c in cols if c not in prot]
        if bad and (min(bad) < 0 or max(bad) >= width):
            raise ValueError(f"第 {f} 帧存在越界列号(宽度 {width}): {bad}")

    repaired_frames, states, repairs = [], [], []
    for f in range(frames.shape[0]):
        rep = repair_frame(
            frames[f], selection_per_frame[f], prot, cfg, frame_index=f
        )
        repaired_frames.append(rep.repaired)
        states.append(rep.states)
        repairs.append(rep)
    return RepairResult(
        repaired=np.stack(repaired_frames),
        states=states,
        repairs=repairs,
        protected_cols=sorted(prot),
    )


def assert_unchanged(
    original: np.ndarray,
    repaired: np.ndarray,
    selected_per_frame: list[list[int]],
    protected: list[int] | set[int] | None = None,
) -> None:
    """核对: 未选中(且非填值波及)的位置与原图完全一致, 选中列外零改动。"""
    prot = set(protected or [])
    width = original.shape[2]
    for f in range(original.shape[0]):
        touched = set(selected_per_frame[f]) - prot
        untouched = [c for c in range(width) if c not in touched]
        if not untouched:
            continue
        diff = np.abs(original[f][:, untouched] - repaired[f][:, untouched])
        if np.any(diff != 0.0):
            raise AssertionError(f"第 {f} 帧选中列之外出现改动")
