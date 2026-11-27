"""清理流水线、版本历史与约束。

设计要点
--------
* 每个处理动作是一个 Step, 作用于当前二值 mask 产生新 mask,
  动作顺序由 steps 列表决定, 可以任意增删和上下移动——所以
  "先去毛刺还是先补短缝"的差别可以直接试出来。
* 每应用一步就生成一个不可变 Version(快照 + 该版本的连通域/
  孔洞统计)。撤回只是把指针移回旧版本; 在旧版本上重新调参,
  会从那里截断重建, 统计天然回到对应版本。
* 连通性 4/8 是全局参数, 形态学结构元、连通块标记、孔洞标记
  全部用同一个值, 保证三处口径一致。
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional

import numpy as np

from . import morphology as morph


class StepKind(str, Enum):
    OPENING = "opening"          # 去毛刺(开运算)
    CLOSING = "closing"          # 补短缝(闭运算)
    REMOVE_SMALL = "remove_small"  # 移除小孤岛

    @property
    def label(self) -> str:
        return {
            StepKind.OPENING: "去毛刺(开运算)",
            StepKind.CLOSING: "补短缝(闭运算)",
            StepKind.REMOVE_SMALL: "移除小孤岛",
        }[self]


@dataclass
class Step:
    kind: StepKind
    radius: int = 1          # opening/closing 的像素半径
    min_size: int = 20       # remove_small 的面积阈值(像素)

    def describe(self) -> str:
        if self.kind is StepKind.REMOVE_SMALL:
            return f"{self.kind.label} < {self.min_size}px"
        return f"{self.kind.label} r={self.radius}"

    def apply(self, mask: np.ndarray, connectivity: int) -> np.ndarray:
        if self.kind is StepKind.OPENING:
            return morph.opening(mask, self.radius, connectivity)
        if self.kind is StepKind.CLOSING:
            return morph.closing(mask, self.radius, connectivity)
        out, _ = morph.remove_small_components(mask, self.min_size, connectivity)
        return out

    def to_dict(self) -> dict:
        return {"kind": self.kind.value, "radius": self.radius, "min_size": self.min_size}

    @staticmethod
    def from_dict(d: dict) -> "Step":
        return Step(kind=StepKind(d["kind"]), radius=d.get("radius", 1),
                    min_size=d.get("min_size", 20))


@dataclass
class Version:
    """流水线某个时刻的不可变快照。"""
    name: str
    mask: np.ndarray
    labels: np.ndarray
    n_components: int
    component_stats: list[dict]
    hole_labels: np.ndarray
    n_holes: int
    hole_stats: list[dict]
    changed_from_prev: Optional[np.ndarray] = None  # bool, 相对上一版本的变化像素
    step: Optional[Step] = None

    @property
    def ink_pixels(self) -> int:
        return int(self.mask.sum())

    @property
    def changed_count(self) -> int:
        if self.changed_from_prev is None:
            return 0
        return int(self.changed_from_prev.sum())


@dataclass
class NoMergeConstraint:
    """两个连通块不能合并。锚点用创建约束时的像素坐标固定下来。"""
    kind: str = "no_merge"
    label_a: int = 0
    label_b: int = 0
    anchor_a: tuple[int, int] = (0, 0)  # (y, x)
    anchor_b: tuple[int, int] = (0, 0)
    samples_a: list[tuple[int, int]] = field(default_factory=list)
    samples_b: list[tuple[int, int]] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class PreserveHoleConstraint:
    """圈出的小孔区域必须保留(其内背景像素不能被填成墨迹)。"""
    kind: str = "preserve_hole"
    rect: tuple[int, int, int, int] = (0, 0, 0, 0)  # y0, x0, y1, x1 含端点
    samples: list[tuple[int, int]] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


Constraint = NoMergeConstraint | PreserveHoleConstraint


def _sample_points(mask: np.ndarray, labels: np.ndarray, lab: int,
                   max_points: int = 40) -> list[tuple[int, int]]:
    """在一个连通块内取确定性的代表像素(含质心附近与均匀抽样),
    供后续版本中稳定追踪这个块。"""
    ys, xs = np.nonzero(labels == lab)
    if len(ys) == 0:
        return []
    order = np.argsort(ys * labels.shape[1] + xs)
    ys, xs = ys[order], xs[order]
    idx = np.linspace(0, len(ys) - 1, num=min(max_points, len(ys))).round().astype(int)
    return [(int(ys[i]), int(xs[i])) for i in np.unique(idx)]


def _track_component(version: Version,
                     samples: list[tuple[int, int]]) -> tuple[Optional[int], bool]:
    """根据采样像素在某版本中找对应连通块。

    返回 (label_or_None, still_ink): 多数采样点落在同一标签上即认定
    为该块; 采样点全部变成背景则认为块已消失。
    """
    if not samples:
        return None, False
    votes: dict[int, int] = {}
    ink_hits = 0
    for y, x in samples:
        lab = int(version.labels[y, x])
        if lab != 0:
            votes[lab] = votes.get(lab, 0) + 1
            ink_hits += 1
    if not votes:
        return None, False
    label = max(votes.items(), key=lambda kv: (kv[1], -kv[0]))[0]
    return label, ink_hits > 0


@dataclass
class Violation:
    constraint: Constraint
    kind: str                  # "merged" | "vanished" | "hole_filled"
    detail: str
    locations: list[tuple[int, int]] = field(default_factory=list)
    rect: Optional[tuple[int, int, int, int]] = None


def evaluate_constraints(version: Version,
                         constraints: list[Constraint]) -> list[Violation]:
    """检查一个版本是否破坏约束, 违规同时给出定位像素/框。"""
    violations: list[Violation] = []
    for c in constraints:
        if isinstance(c, NoMergeConstraint):
            la, _ = _track_component(version, c.samples_a or [c.anchor_a])
            lb, _ = _track_component(version, c.samples_b or [c.anchor_b])
            if la is None or lb is None:
                gone = "A" if la is None else "B"
                anchor = c.anchor_a if la is None else c.anchor_b
                violations.append(
                    Violation(c, "vanished",
                              f"禁并对的块 {gone} (原标签 "
                              f"{c.label_a if gone == 'A' else c.label_b}) 已被清掉",
                              locations=[anchor]))
            elif la == lb:
                locs = sorted(set((c.anchor_a, c.anchor_b)))
                violations.append(
                    Violation(c, "merged",
                              f"禁并的两块 (原标签 {c.label_a},{c.label_b}) "
                              f"现在合并成了块 {la}",
                              locations=locs))
        elif isinstance(c, PreserveHoleConstraint):
            y0, x0, y1, x1 = c.rect
            region = version.mask[y0:y1 + 1, x0:x1 + 1]
            filled = np.count_nonzero(region)
            if filled:
                # 被填掉的具体像素, 供界面高亮
                yy, xx = np.nonzero(region)
                locs = [(int(y0 + yy[i]), int(x0 + xx[i])) for i in range(len(yy))]
                violations.append(
                    Violation(c, "hole_filled",
                              f"要保留的小孔内有 {filled}px 被填成墨迹",
                              locations=locs, rect=c.rect))
    return violations


class Project:
    """持有原图、阈值、连通性、步骤列表、版本历史和约束。"""

    def __init__(self, gray: np.ndarray, threshold: int = 128,
                 connectivity: int = 8, name: str = "原图"):
        self.gray = np.asarray(gray, dtype=np.uint8)
        self.threshold = int(threshold)
        self.connectivity = connectivity
        self.name = name
        self.steps: list[Step] = []
        self.constraints: list[Constraint] = []
        self.versions: list[Version] = []
        self.cursor: int = -1  # 当前查看的版本下标, -1 表示还没建基线
        self._rebuild_base()

    # ------------------------------------------------------------------
    def binarize(self, threshold: Optional[int] = None) -> np.ndarray:
        """灰度 -> 二值: 灰度 <= 阈值视为墨迹(黑)。"""
        t = self.threshold if threshold is None else threshold
        return self.gray <= t

    def _make_version(self, name: str, mask: np.ndarray,
                      prev_mask: Optional[np.ndarray],
                      step: Optional[Step]) -> Version:
        labels, n = morph.label_components(mask, self.connectivity)
        stats = morph.component_stats(labels, n)
        hole_labels, n_holes, hole_stats = morph.find_holes(mask, self.connectivity)
        changed = None if prev_mask is None else (mask != prev_mask)
        return Version(name, mask.copy(), labels, n, stats,
                       hole_labels, n_holes, hole_stats, changed, step)

    def _rebuild_base(self) -> None:
        """从灰度图重建基线版本(版本 0)。"""
        mask = self.binarize()
        base = self._make_version(self.name, mask, None, None)
        self.versions = [base]
        self.cursor = 0

    def set_threshold(self, threshold: int) -> None:
        """调阈值等于换基线: 清空步骤和历史(约束保留, 重新追踪)。"""
        self.threshold = int(threshold)
        self.steps = []
        self._rebuild_base()

    def set_connectivity(self, connectivity: int) -> None:
        """切换 4/8 连通: 保留步骤, 整条流水线重放。"""
        if connectivity not in (4, 8):
            raise ValueError("connectivity 只能是 4 或 8")
        self.connectivity = connectivity
        self._replay()

    # ------------------------------------------------------------------
    def add_step(self, step: Step) -> Version:
        """在当前版本之后追加一步并重算。"""
        self.steps = self.steps[: self.cursor]  # 截断当前版本之后的步骤
        self.steps.append(step)
        self._replay()
        return self.current

    def move_step(self, index: int, delta: int) -> None:
        """上移/下移某一步, 然后整条重放——顺序差异由此可见。"""
        j = index + delta
        if not (0 <= j < len(self.steps)):
            return
        self.steps[index], self.steps[j] = self.steps[j], self.steps[index]
        self._replay()

    def remove_step(self, index: int) -> None:
        del self.steps[index]
        self._replay()

    def update_step(self, index: int, **params) -> None:
        """改某一步的参数(radius/min_size), 从该步起重放。"""
        step = self.steps[index]
        for k, v in params.items():
            setattr(step, k, v)
        self._replay()

    def rollback(self, version_index: int) -> None:
        """撤回到指定版本: 只移动游标, 历史仍保留; 之后再加新步骤
        会从该点截断。统计直接读该版本快照, 立刻回到对应版本。"""
        if not (0 <= version_index < len(self.versions)):
            raise IndexError("版本下标越界")
        self.cursor = version_index
        # steps 与版本是一一对应的(版本 i>=1 对应 steps[i-1])
        self.steps = self.steps[:version_index]

    def _replay(self) -> None:
        """从基线开始按 steps 重新生成全部版本。"""
        base_mask = self.binarize()
        versions = [self._make_version(self.name, base_mask, None, None)]
        prev = base_mask
        mask = base_mask
        for i, step in enumerate(self.steps, start=1):
            mask = step.apply(mask, self.connectivity)
            versions.append(
                self._make_version(f"{i}. {step.describe()}", mask, prev, step))
            prev = mask
        self.versions = versions
        self.cursor = len(versions) - 1

    # ------------------------------------------------------------------
    @property
    def current(self) -> Version:
        return self.versions[self.cursor]

    @property
    def base(self) -> Version:
        return self.versions[0]

    # ------------------------------------------------------------------
    # 约束
    # ------------------------------------------------------------------
    def add_no_merge(self, label_a: int, label_b: int) -> NoMergeConstraint:
        v = self.current
        if label_a == label_b or label_a <= 0 or label_b <= 0:
            raise ValueError("需要两个不同的有效连通块标签")
        if label_a > v.n_components or label_b > v.n_components:
            raise ValueError("标签超出当前版本的连通块范围")
        ca = NoMergeConstraint(
            label_a=label_a, label_b=label_b,
            anchor_a=_first_pixel(v.labels, label_a),
            anchor_b=_first_pixel(v.labels, label_b),
            samples_a=_sample_points(v.mask, v.labels, label_a),
            samples_b=_sample_points(v.mask, v.labels, label_b),
        )
        self.constraints.append(ca)
        return ca

    def add_preserve_hole(self, rect: tuple[int, int, int, int]) -> PreserveHoleConstraint:
        y0, x0, y1, x1 = rect
        y0, y1 = sorted((int(y0), int(y1)))
        x0, x1 = sorted((int(x0), int(x1)))
        h, w = self.gray.shape
        y0, y1 = max(0, y0), min(h - 1, y1)
        x0, x1 = max(0, x0), min(w - 1, x1)
        region = self.current.mask[y0:y1 + 1, x0:x1 + 1]
        samples = [(int(y), int(x))
                   for y, x in zip(*np.nonzero(~region), strict=False)]
        c = PreserveHoleConstraint(rect=(y0, x0, y1, x1), samples=samples)
        self.constraints.append(c)
        return c

    def remove_constraint(self, index: int) -> None:
        del self.constraints[index]

    def violations_at(self, version_index: Optional[int] = None) -> list[Violation]:
        v = self.versions[self.cursor if version_index is None else version_index]
        return evaluate_constraints(v, self.constraints)


def _first_pixel(labels: np.ndarray, lab: int) -> tuple[int, int]:
    ys, xs = np.nonzero(labels == lab)
    return int(ys[0]), int(xs[0])
