"""网格模型：从逐段边状态构建格子、合并格与稳定编号。

编号规则（需求 4）：
- 每个逻辑槽位 (r, c) 都有固定编号 R{r+1}C{c+1}，空白格、缺图不会让
  后面的编号前移；
- 合并格占多个槽位，编号取其左上角锚点槽位（如 R2C2 跨 (2,3)x(2,3)），
  被覆盖的槽位标记 covered_by，不产生新格子；
- 另给导出顺序号 seq（1..N），按锚点行列排序，仅用于文件命名。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from .detection import ABSENT, PRESENT, UNCERTAIN, DetectionResult, EdgeSeg


def new_id() -> str:
    return uuid.uuid4().hex[:12]


@dataclass
class Cell:
    cell_id: str
    anchor: tuple[int, int]        # (r, c) 锚点槽位
    span: tuple[int, int]          # (行跨度, 列跨度)
    code: str                      # R{r+1}C{c+1}
    is_blank: bool = False
    confidence: str = "high"
    notes: list[str] = field(default_factory=list)

    @property
    def r0(self) -> int:
        return self.anchor[0]

    @property
    def c0(self) -> int:
        return self.anchor[1]

    @property
    def r1(self) -> int:
        return self.anchor[0] + self.span[0] - 1

    @property
    def c1(self) -> int:
        return self.anchor[1] + self.span[1] - 1

    @property
    def slots(self) -> list[tuple[int, int]]:
        return [(r, c) for r in range(self.r0, self.r1 + 1)
                for c in range(self.c0, self.c1 + 1)]

    def to_dict(self) -> dict[str, Any]:
        return {
            "cell_id": self.cell_id,
            "code": self.code,
            "anchor": list(self.anchor),
            "span": list(self.span),
            "is_blank": self.is_blank,
            "confidence": self.confidence,
            "notes": self.notes,
        }


# 边覆写：键与 DetectionResult 中的键格式一致
# h: (iy, j) 表示横线 iy 在列段 j 上的边；v: (i, jx) 表示竖线 jx 在行段 i 上的边


class GridModel:
    def __init__(self, detection: DetectionResult):
        self.det = detection
        self.n_rows = len(detection.ys) - 1
        self.n_cols = len(detection.xs) - 1
        # 手工覆写：edge_key -> 目标状态（present/absent）
        self.overrides: dict[str, str] = {}
        self.cell_notes: dict[str, list[str]] = {}
        self.cells: list[Cell] = []
        self.rebuild()

    # ------------------------------------------------------------------ 边查询
    def h_edge(self, iy: int, j: int) -> EdgeSeg:
        return self.det.h_segs[(iy, j)]

    def v_edge(self, i: int, jx: int) -> EdgeSeg:
        return self.det.v_segs[(i, jx)]

    def edge_state(self, orientation: str, a: int, b: int) -> str:
        """取边段的有效状态（含手工覆写）。"""
        key = f"{orientation}:{a},{b}"
        if key in self.overrides:
            return self.overrides[key]
        seg = self.h_edge(a, b) if orientation == "h" else self.v_edge(a, b)
        return seg.state

    def edge_info(self, orientation: str, a: int, b: int) -> EdgeSeg:
        return self.h_edge(a, b) if orientation == "h" else self.v_edge(a, b)

    # ------------------------------------------------------------------ 构建
    def rebuild(self) -> None:
        """根据当前边状态重新做合并格洪水填充与编号。"""
        n_r, n_c = self.n_rows, self.n_cols
        visited = [[False] * n_c for _ in range(n_r)]
        cells: list[Cell] = []

        def open_right(r: int, c: int) -> bool:
            # 竖线索引 c+1，行段 r 上没有实线（absent 视为合并；uncertain 默认当有边）
            return self.edge_state("v", r, c + 1) == ABSENT

        def open_down(r: int, c: int) -> bool:
            # 横线索引 r+1，列段 c
            return self.edge_state("h", r + 1, c) == ABSENT

        for r in range(n_r):
            for c in range(n_c):
                if visited[r][c]:
                    continue
                # BFS 找合并区域
                stack = [(r, c)]
                region: list[tuple[int, int]] = []
                visited[r][c] = True
                while stack:
                    cr, cc = stack.pop()
                    region.append((cr, cc))
                    if cc + 1 < n_c and not visited[cr][cc + 1] and open_right(cr, cc):
                        visited[cr][cc + 1] = True
                        stack.append((cr, cc + 1))
                    if cr + 1 < n_r and not visited[cr + 1][cc] and open_down(cr, cc):
                        visited[cr + 1][cc] = True
                        stack.append((cr + 1, cc))
                rs = [p[0] for p in region]
                cs = [p[1] for p in region]
                r0, r1, c0, c1 = min(rs), max(rs), min(cs), max(cs)
                span_r, span_c = r1 - r0 + 1, c1 - c0 + 1
                cell = Cell(
                    cell_id=new_id(),
                    anchor=(r0, c0),
                    span=(span_r, span_c),
                    code=f"R{r0 + 1}C{c0 + 1}",
                )
                cell.notes = list(self.cell_notes.get(cell.code, []))
                cell.confidence = self._cell_confidence(cell)
                cells.append(cell)

        cells.sort(key=lambda c: (c.r0, c.c0))
        self.cells = cells
        self._refresh_blank_flags()

    def _cell_confidence(self, cell: Cell) -> str:
        """格子可信度 = 其四条外围边段的最低可信度。"""
        levels = {"high": 3, "medium": 2, "low": 1}
        worst = 3
        notes: list[str] = []
        r0, r1, c0, c1 = cell.r0, cell.r1, cell.c0, cell.c1
        for c in range(c0, c1 + 1):
            for iy in (r0, r1 + 1):
                seg = self.h_edge(iy, c)
                worst = min(worst, levels[seg.confidence])
                if seg.state == UNCERTAIN:
                    notes.append(f"横线{iy + 1}列段{c + 1}待确认")
        for r in range(r0, r1 + 1):
            for jx in (c0, c1 + 1):
                seg = self.v_edge(r, jx)
                worst = min(worst, levels[seg.confidence])
                if seg.state == UNCERTAIN:
                    notes.append(f"竖线{jx + 1}行段{r + 1}待确认")
        merged = cell.span != (1, 1)
        if merged:
            notes.append(f"合并范围 {cell.span[0]}行x{cell.span[1]}列")
        inv = {3: "high", 2: "medium", 1: "low"}
        existing = self.cell_notes.get(cell.code, [])
        merged_note = [n for n in existing if n.startswith("手工确认合并")]
        cell.notes = merged_note + notes
        return inv[worst]

    def _refresh_blank_flags(self) -> None:
        """空白判定交给导出阶段（需要原图），这里只保留手工/既有标记。"""
        for cell in self.cells:
            cell.is_blank = any("空白" in n for n in cell.notes)

    # ------------------------------------------------------------------ 编辑
    def set_edge_override(self, orientation: str, a: int, b: int,
                          state: str | None) -> None:
        """增/改/删一条边段的手工覆写。state=None 表示删除覆写。"""
        key = f"{orientation}:{a},{b}"
        if state is None:
            self.overrides.pop(key, None)
        else:
            if state not in (PRESENT, ABSENT):
                raise ValueError("边状态只能是 present 或 absent")
            self.overrides[key] = state
        self.rebuild()

    def confirm_merge(self, r0: int, r1: int, c0: int, c1: int) -> None:
        """手工确认一个矩形合并范围：内部边全部置 absent。"""
        for r in range(r0, r1 + 1):
            for c in range(c0, c1):
                self.overrides[f"v:{r},{c + 1}"] = ABSENT
        for r in range(r0, r1):
            for c in range(c0, c1 + 1):
                self.overrides[f"h:{r + 1},{c}"] = ABSENT
        code = f"R{r0 + 1}C{c0 + 1}"
        self.cell_notes[code] = [
            n for n in self.cell_notes.get(code, []) if not n.startswith("手工确认合并")
        ]
        self.cell_notes[code].append(
            f"手工确认合并 R{r0 + 1}-{r1 + 1} / C{c0 + 1}-{c1 + 1}")
        self.rebuild()

    def unmerge_at(self, r: int, c: int) -> None:
        """拆开包含槽位 (r,c) 的合并格：删除其内部边的 absent 覆写。"""
        target = next((cell for cell in self.cells
                       if cell.r0 <= r <= cell.r1 and cell.c0 <= c <= cell.c1), None)
        if target is None or target.span == (1, 1):
            return
        for rr in range(target.r0, target.r1 + 1):
            for cc in range(target.c0, target.c1):
                self.overrides.pop(f"v:{rr},{cc + 1}", None)
        for rr in range(target.r0, target.r1):
            for cc in range(target.c0, target.c1 + 1):
                self.overrides.pop(f"h:{rr + 1},{cc}", None)
        self.rebuild()

    def add_vline(self, x: float) -> int:
        """在拉正图 x 位置插入一条竖线，返回新线索引。"""
        xs = self.det.xs
        idx = next((i for i, v in enumerate(xs) if v > x), len(xs))
        xs.insert(idx, float(x))
        self.n_cols += 1
        # 旧的 v 段索引 >= idx 要右移；新线各段默认 present（用户主动加的分隔）
        new_v: dict[tuple[int, int], EdgeSeg] = {}
        for (i, jx), seg in self.det.v_segs.items():
            new_v[(i, jx + 1 if jx >= idx else jx)] = seg
        for i in range(self.n_rows):
            new_v[(i, idx)] = EdgeSeg(PRESENT, "high", 1.0, 0, reason="手工新增竖线")
        self.det.v_segs = new_v
        # h 段：列段多了一段，拆成两段，复制原段状态
        new_h: dict[tuple[int, int], EdgeSeg] = {}
        for (iy, j), seg in self.det.h_segs.items():
            nj = j + 1 if j >= idx else j
            new_h[(iy, nj)] = seg
            if j == idx - 1:
                new_h[(iy, idx)] = EdgeSeg(
                    seg.state, seg.confidence, seg.support, seg.longest_gap,
                    reason="随新增竖线拆分的边段")
        self.det.h_segs = new_h
        self._shift_overrides(idx, vertical=True)
        self.rebuild()
        return idx

    def add_hline(self, y: float) -> int:
        """在拉正图 y 位置插入一条横线，返回新线索引。"""
        ys = self.det.ys
        idx = next((i for i, v in enumerate(ys) if v > y), len(ys))
        ys.insert(idx, float(y))
        self.n_rows += 1
        new_h: dict[tuple[int, int], EdgeSeg] = {}
        for (iy, j), seg in self.det.h_segs.items():
            new_h[(iy + 1 if iy >= idx else iy, j)] = seg
        for j in range(self.n_cols):
            new_h[(idx, j)] = EdgeSeg(PRESENT, "high", 1.0, 0, reason="手工新增横线")
        self.det.h_segs = new_h
        new_v: dict[tuple[int, int], EdgeSeg] = {}
        for (i, jx), seg in self.det.v_segs.items():
            ni = i + 1 if i >= idx else i
            new_v[(ni, jx)] = seg
            if i == idx - 1:
                new_v[(idx, jx)] = EdgeSeg(
                    seg.state, seg.confidence, seg.support, seg.longest_gap,
                    reason="随新增横线拆分的边段")
        self.det.v_segs = new_v
        self._shift_overrides(idx, vertical=False)
        self.rebuild()
        return idx

    def remove_vline(self, idx: int) -> None:
        if idx <= 0 or idx >= len(self.det.xs) - 1:
            raise ValueError("外框竖线不能删除")
        self.det.xs.pop(idx)
        self.n_cols -= 1
        self.det.v_segs = {(i, jx - 1 if jx > idx else jx): s
                           for (i, jx), s in self.det.v_segs.items() if jx != idx}
        merged_h: dict[tuple[int, int], EdgeSeg] = {}
        for (iy, j), seg in self.det.h_segs.items():
            merged_h[(iy, j - 1 if j > idx else j)] = seg
        self.det.h_segs = merged_h
        self.overrides = {
            self._shift_key(k, idx, vertical=True): v
            for k, v in self.overrides.items()
            if not self._key_is_removed(k, idx, vertical=True)}
        self.rebuild()

    def remove_hline(self, idx: int) -> None:
        if idx <= 0 or idx >= len(self.det.ys) - 1:
            raise ValueError("外框横线不能删除")
        self.det.ys.pop(idx)
        self.n_rows -= 1
        self.det.h_segs = {(iy - 1 if iy > idx else iy, j): s
                           for (iy, j), s in self.det.h_segs.items() if iy != idx}
        merged_v: dict[tuple[int, int], EdgeSeg] = {}
        for (i, jx), seg in self.det.v_segs.items():
            merged_v[(i - 1 if i > idx else i, jx)] = seg
        self.det.v_segs = merged_v
        self.overrides = {
            self._shift_key(k, idx, vertical=False): v
            for k, v in self.overrides.items()
            if not self._key_is_removed(k, idx, vertical=False)}
        self.rebuild()

    # ---------------------------------------------------------- 覆写键维护
    @staticmethod
    def _shift_key(key: str, idx: int, vertical: bool) -> str:
        orient, rest = key.split(":")
        a, b = (int(x) for x in rest.split(","))
        if vertical:  # 竖线增删：v 键的线号是 b，h 键的段号是 b
            b2 = b - 1 if b > idx else b
            return f"{orient}:{a},{b2}"
        a2 = a - 1 if a > idx else a
        return f"{orient}:{a2},{b}"

    @staticmethod
    def _key_is_removed(key: str, idx: int, vertical: bool) -> bool:
        orient, rest = key.split(":")
        a, b = (int(x) for x in rest.split(","))
        if vertical:
            return orient == "v" and b == idx
        return orient == "h" and a == idx

    def _shift_overrides(self, idx: int, vertical: bool) -> None:
        # 插入：索引 >= idx 的段/线号 +1
        shifted: dict[str, str] = {}
        for key, val in self.overrides.items():
            orient, rest = key.split(":")
            a, b = (int(x) for x in rest.split(","))
            if vertical:
                if orient == "v" and b >= idx:
                    b += 1
                if orient == "h" and b >= idx:
                    b += 1
            else:
                if orient == "h" and a >= idx:
                    a += 1
                if orient == "v" and a >= idx:
                    a += 1
            shifted[f"{orient}:{a},{b}"] = val
        self.overrides = shifted

    # ------------------------------------------------------------------ 序列化
    def slot_coverage(self) -> dict[tuple[int, int], str]:
        """槽位 -> 占用它的格子 code（锚点格或被覆盖标记）。"""
        out: dict[tuple[int, int], str] = {}
        for cell in self.cells:
            for slot in cell.slots:
                out[slot] = cell.code if slot == cell.anchor else f"covered:{cell.code}"
        return out

    def to_dict(self) -> dict[str, Any]:
        coverage = self.slot_coverage()
        slots = []
        for r in range(self.n_rows):
            for c in range(self.n_cols):
                slots.append({
                    "r": r, "c": c,
                    "code": f"R{r + 1}C{c + 1}",
                    "status": coverage.get((r, c), "missing"),
                })
        return {
            "n_rows": self.n_rows,
            "n_cols": self.n_cols,
            "xs": self.det.xs,
            "ys": self.det.ys,
            "overrides": self.overrides,
            "cell_notes": self.cell_notes,
            "cells": [c.to_dict() for c in self.cells],
            "slots": slots,
            "low_confidence": self.det.low_confidence,
            "table_bbox": list(self.det.table_bbox),
            "h_segs": {f"{k[0]},{k[1]}": v.to_dict()
                       for k, v in self.det.h_segs.items()},
            "v_segs": {f"{k[0]},{k[1]}": v.to_dict()
                       for k, v in self.det.v_segs.items()},
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "GridModel":
        def seg(d: dict) -> EdgeSeg:
            return EdgeSeg(
                state=d["state"], confidence=d["confidence"],
                support=d.get("support", 0.0), longest_gap=d.get("longest_gap", 0),
                bridged=d.get("bridged", False), faint=d.get("faint", False),
                stamp_coverage=d.get("stamp_coverage", 0.0),
                reason=d.get("reason", ""))

        det = DetectionResult(
            xs=[float(v) for v in data["xs"]],
            ys=[float(v) for v in data["ys"]],
            table_bbox=tuple(data.get("table_bbox", (0, 0, 0, 0))),
        )
        det.h_segs = {tuple(int(i) for i in k.split(",")): seg(v)
                      for k, v in data.get("h_segs", {}).items()}
        det.v_segs = {tuple(int(i) for i in k.split(",")): seg(v)
                      for k, v in data.get("v_segs", {}).items()}
        det.low_confidence = data.get("low_confidence", [])
        model = cls(det)
        model.overrides = dict(data.get("overrides", {}))
        model.cell_notes = {k: list(v) for k, v in data.get("cell_notes", {}).items()}
        model.rebuild()
        return model
