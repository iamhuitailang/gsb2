"""接缝雕刻引擎：逐步抽缝、撤销、源像素映射与可行性判定。

引擎维护「当前帧」上的图像与两张蒙版（保护 / 优先留白），以及每个
现存像素到源图坐标的映射 ``src_map``。每次抽缝同步作用于图像、蒙版
和映射，因此：

* 保护区域始终跟随现存像素走，不会被接缝穿过；
* 撤销直接恢复完整快照，蒙版位置逐像素还原，不存在重投影漂移；
* 被抽走的源像素坐标可精确还原，用于导出缩减位置说明。
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field

import numpy as np

from .energy import PROTECT_PENALTY, horizontal_seam, seam_energy, vertical_seam
from .masks import MaskSet

VERTICAL = "vertical"      # 竖直缝：宽度 -1
HORIZONTAL = "horizontal"  # 水平缝：高度 -1


class EngineError(RuntimeError):
    """引擎层面的通用错误。"""


class ProtectionBlockedError(EngineError):
    """最小代价缝仍穿过保护区域，无法在不破坏物件的前提下继续。"""


class TargetTooSmallError(EngineError):
    """目标尺寸小于保护区域允许的下界。"""


@dataclass
class StepRecord:
    """一次抽缝的完整记录（坐标基于抽缝前的帧 / 源图）。"""

    index: int
    direction: str          # VERTICAL / HORIZONTAL
    current_path: list[tuple[int, int]]
    source_path: list[tuple[int, int]]
    cost: float
    hits_protection: bool

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "direction": self.direction,
            "current_path": [list(p) for p in self.current_path],
            "source_path": [list(p) for p in self.source_path],
            "hits_protection": bool(self.hits_protection),
            "cost": float(self.cost),
        }

    @classmethod
    def from_dict(cls, d: dict) -> "StepRecord":
        return cls(
            index=int(d["index"]),
            direction=d["direction"],
            current_path=[tuple(p) for p in d["current_path"]],
            source_path=[tuple(p) for p in d["source_path"]],
            cost=float(d["cost"]),
            hits_protection=bool(d["hits_protection"]),
        )


@dataclass
class _Snapshot:
    image: np.ndarray
    protect: np.ndarray
    shrink: np.ndarray
    src_map: np.ndarray
    removed_ids: set[int]
    steps: list[StepRecord] = field(default_factory=list)


class SeamEngine:
    def __init__(self, image: np.ndarray, masks: MaskSet | None = None) -> None:
        arr = np.asarray(image)
        if arr.ndim != 3 or arr.shape[2] not in (3, 4):
            raise ValueError("仅支持 HxWx3 / HxWx4 的图像")
        self._source = arr.copy()
        self.src_h, self.src_w = arr.shape[:2]

        masks = masks or MaskSet()
        masks.validate(self.src_h, self.src_w)
        p, s = masks.source_masks(self.src_h, self.src_w)

        self.image = arr.copy()
        self.protect = p
        self.shrink = s
        # 每个现存像素对应的源像素编号 id = sy * src_w + sx。
        yy, xx = np.mgrid[0 : self.src_h, 0 : self.src_w]
        self.src_map = (yy * self.src_w + xx).astype(np.int64)
        self.removed_ids: set[int] = set()
        self.steps: list[StepRecord] = []
        self._history: list[_Snapshot] = []
        # 源图坐标系下的固定可行性下界（不随收缩帧移动）。
        # 无任何保护像素时，下界为 1（总能找到不穿保护的缝）。
        row_max = int(p.sum(axis=1).max())
        col_max = int(p.sum(axis=0).max())
        self._src_min_width = self.src_w - row_max if row_max else 1
        self._src_min_height = self.src_h - col_max if col_max else 1

    # ------------------------------------------------------------------
    # 基础属性
    # ------------------------------------------------------------------
    @property
    def size(self) -> tuple[int, int]:
        """当前 (宽, 高)。"""
        h, w = self.image.shape[:2]
        return w, h

    @property
    def source_size(self) -> tuple[int, int]:
        return self.src_w, self.src_h

    @property
    def can_undo(self) -> bool:
        return bool(self._history)

    # ------------------------------------------------------------------
    # 可行性
    # ------------------------------------------------------------------
    def min_width(self) -> int:
        """保护区域允许的最小宽度（基于源图的固定下界）。

        每行必须保留全部受保护像素，能抽走的缝数受限于
        「源图中受保护像素最多的那一行」，故
        下界 = 源宽 - 单行最大保护数。该值与已抽多少缝无关，
        否则每抽一帧帧宽下降、下界也跟着降，会变成移动靶。
        """
        return self._src_min_width

    def min_height(self) -> int:
        """保护区域允许的最小高度（同理，基于源图单列最大保护数）。"""
        return self._src_min_height

    def check_target(self, target_w: int, target_h: int) -> None:
        """目标尺寸越界或保护区放不下时抛出带明确数值的异常。"""
        w, h = self.size
        if target_w > w or target_h > h:
            raise TargetTooSmallError(
                f"目标 {target_w}x{target_h} 大于当前尺寸 {w}x{h}，本工具只做缩减"
            )
        if target_w < 1 or target_h < 1:
            raise TargetTooSmallError("目标宽高都必须 >= 1")
        if target_w < self.min_width():
            raise TargetTooSmallError(
                f"目标宽度 {target_w}px 放不下保护区域："
                f"源图某一行最多被保护像素占去 {self.src_w - self.min_width()}px，"
                f"宽度方向最小可行尺寸为 {self.min_width()}px（源宽 {w}px）"
            )
        if target_h < self.min_height():
            raise TargetTooSmallError(
                f"目标高度 {target_h}px 放不下保护区域："
                f"源图某一列最多被保护像素占去 {self.src_h - self.min_height()}px，"
                f"高度方向最小可行尺寸为 {self.min_height()}px（源高 {h}px）"
            )

    # ------------------------------------------------------------------
    # 缝的预览与抽取
    # ------------------------------------------------------------------
    def _energy(self) -> np.ndarray:
        return seam_energy(self.image, self.protect, self.shrink)

    def preview_seam(self, direction: str) -> StepRecord:
        """计算拟缩减的缝但不落地，供界面高亮与可行性检查。"""
        energy = self._energy()
        if direction == VERTICAL:
            seam = vertical_seam(energy)
            current_path = [(r, int(seam[r])) for r in range(seam.shape[0])]
            hits = bool(self.protect[np.arange(len(seam)), seam].any())
        elif direction == HORIZONTAL:
            seam = horizontal_seam(energy)
            current_path = [(int(seam[c]), c) for c in range(seam.shape[0])]
            hits = bool(self.protect[seam, np.arange(len(seam))].any())
        else:
            raise ValueError(f"未知方向 {direction!r}")

        source_path = [
            tuple(self._decode_id(int(self.src_map[y, x]))) for y, x in current_path
        ]
        cost = float(sum(energy[y, x] for y, x in current_path))
        return StepRecord(
            index=len(self.steps),
            direction=direction,
            current_path=current_path,
            source_path=source_path,
            cost=cost,
            hits_protection=hits,
        )

    def remove_seam(self, direction: str, *, allow_protected: bool = False) -> StepRecord:
        """抽走一条缝并推进一帧；默认拒绝穿过保护区的缝。"""
        record = self.preview_seam(direction)
        if record.hits_protection and not allow_protected:
            raise ProtectionBlockedError(
                f"第 {record.index + 1} 步（{direction}）最小代价缝仍穿过 "
                f"{sum(1 for y, x in record.current_path if self.protect[y, x])} "
                "个保护像素；请放宽目标尺寸或调整保护区域"
            )

        self._history.append(self._snapshot())
        if direction == VERTICAL:
            self._remove_vertical(record)
        else:
            self._remove_horizontal(record)
        self.steps.append(record)
        return record

    def _remove_vertical(self, record: StepRecord) -> None:
        h, w = self.image.shape[:2]
        seam = np.array([x for _, x in record.current_path], dtype=np.int64)
        keep = np.ones((h, w), dtype=bool)
        keep[np.arange(h), seam] = False
        for y, x in record.current_path:
            self.removed_ids.add(int(self.src_map[y, x]))

        c = self.image.shape[2]
        self.image = self.image[keep].reshape(h, w - 1, c)
        self.protect = self.protect[keep].reshape(h, w - 1)
        self.shrink = self.shrink[keep].reshape(h, w - 1)
        self.src_map = self.src_map[keep].reshape(h, w - 1)

    def _remove_horizontal(self, record: StepRecord) -> None:
        # 转置后复用竖直缝逻辑，通道轴单独处理。
        h, w = self.image.shape[:2]
        seam = np.array([y for y, _ in record.current_path], dtype=np.int64)
        keep = np.ones((h, w), dtype=bool)
        keep[seam, np.arange(w)] = False
        for y, x in record.current_path:
            self.removed_ids.add(int(self.src_map[y, x]))

        c = self.image.shape[2]
        self.image = self.image[keep].reshape(h - 1, w, c)
        self.protect = self.protect[keep].reshape(h - 1, w)
        self.shrink = self.shrink[keep].reshape(h - 1, w)
        self.src_map = self.src_map[keep].reshape(h - 1, w)

    def undo(self) -> StepRecord:
        """回到上一步，返回被撤销的记录；蒙版随快照逐像素还原。"""
        if not self._history:
            raise EngineError("没有可撤销的步骤")
        snap = self._history.pop()
        record = self.steps.pop()
        self.image = snap.image
        self.protect = snap.protect
        self.shrink = snap.shrink
        self.src_map = snap.src_map
        self.removed_ids = snap.removed_ids
        return record

    # ------------------------------------------------------------------
    # 多步缩减与顺序控制
    # ------------------------------------------------------------------
    def resize_to(
        self,
        target_w: int,
        target_h: int,
        order: str = "alternate",
    ) -> list[StepRecord]:
        """按指定先后顺序缩到目标尺寸。

        order:
          * ``width_first``：先完成全部宽度缩减，再减高度；
          * ``height_first``：反之；
          * ``alternate``（默认）：宽高交替，变形更均匀。
        """
        self.check_target(target_w, target_h)
        w, h = self.size
        n_w, n_h = w - target_w, h - target_h
        sequence = self._plan_sequence(n_w, n_h, order)

        done: list[StepRecord] = []
        for direction in sequence:
            try:
                done.append(self.remove_seam(direction))
            except ProtectionBlockedError as exc:
                cur_w, cur_h = self.size
                raise TargetTooSmallError(
                    f"缩到 {cur_w}x{cur_h} 时保护区域已无可用缝，"
                    f"无法继续到 {target_w}x{target_h}：{exc}"
                ) from exc
        return done

    @staticmethod
    def _plan_sequence(n_w: int, n_h: int, order: str) -> list[str]:
        if order == "width_first":
            return [VERTICAL] * n_w + [HORIZONTAL] * n_h
        if order == "height_first":
            return [HORIZONTAL] * n_h + [VERTICAL] * n_w
        if order != "alternate":
            raise ValueError(
                f"未知顺序 {order!r}，可选 width_first / height_first / alternate"
            )
        seq: list[str] = []
        i = j = 0
        while i < n_w or j < n_h:
            if i < n_w:
                seq.append(VERTICAL)
                i += 1
            if j < n_h:
                seq.append(HORIZONTAL)
                j += 1
        return seq

    def apply_directions(self, directions: list[str]) -> list[StepRecord]:
        """按给定方向序列抽缝，主要用于项目回放复现。"""
        return [self.remove_seam(d) for d in directions]

    # ------------------------------------------------------------------
    # 源坐标 / 快照
    # ------------------------------------------------------------------
    def _decode_id(self, sid: int) -> tuple[int, int]:
        return divmod(sid, self.src_w)

    def removed_source_pixels(self) -> list[tuple[int, int]]:
        """所有被抽走像素在源图上的 (y, x) 坐标。"""
        return sorted(self._decode_id(sid) for sid in self.removed_ids)

    def removed_source_columns(self) -> list[int]:
        """被竖直缝抽走的源列（含该列任一像素被抽走即列出），去重排序。"""
        cols = {x for (y, x) in self.removed_source_pixels()}
        return sorted(cols)

    def _snapshot(self) -> _Snapshot:
        return _Snapshot(
            image=self.image.copy(),
            protect=self.protect.copy(),
            shrink=self.shrink.copy(),
            src_map=self.src_map.copy(),
            removed_ids=set(self.removed_ids),
            steps=copy.copy(self.steps),
        )
