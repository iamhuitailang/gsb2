"""停车事件配对核心逻辑（纯函数，不依赖数据库，便于测试）。

配对规则：
1. 仅在同一停车场、同一有效车牌内配对。
2. 按事件时间升序处理；同一时刻进场事件排在出场之前（车先进才能出）。
3. 出场事件与当前"最近一次尚未配对的进场"配对（栈式 / LIFO），
   因此一条进场最多跟一条出场配对，且天然支持跨午夜停车，
   与文件导入的先后顺序无关。
4. 没有另一端的事件保持未配对，交由调用方落库展示。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Iterable, Sequence

# 事件类型常量
ENTRY = "entry"
EXIT = "exit"


@dataclass(frozen=True)
class Event:
    """一条道闸事件。plate 为当前生效车牌（可能经操作员更正）。"""

    event_id: int
    lot: str
    gate: str
    seq: int
    plate: str
    event_type: str
    event_time: datetime


@dataclass(frozen=True)
class Pair:
    """一条完整停车记录：一次进场 + 一次出场。"""

    entry_id: int
    exit_id: int
    lot: str
    plate: str
    entry_time: datetime
    exit_time: datetime

    @property
    def duration_seconds(self) -> int:
        """停留时长：配对后的实际时间差（秒）。"""
        return int((self.exit_time - self.entry_time).total_seconds())


def _sort_key(event: Event):
    # 同时间点进场(0)优先于出场(1)，再按闸机号、流水号保证结果稳定
    type_rank = 0 if event.event_type == ENTRY else 1
    return (event.event_time, type_rank, event.gate, event.seq, event.event_id)


def pair_events(events: Iterable[Event]) -> tuple[list[Pair], list[int]]:
    """对一批事件执行配对。

    返回 ``(配对列表, 未配对事件 ID 列表)``。
    配对列表按进场时间排序；未配对 ID 按事件时间排序。
    """
    ordered: Sequence[Event] = sorted(events, key=_sort_key)

    # key = (停车场, 车牌)，value = 尚未配对的进场事件栈
    open_entries: dict[tuple[str, str], list[Event]] = {}
    pairs: list[Pair] = []
    paired_ids: set[int] = set()

    for event in ordered:
        key = (event.lot, event.plate)
        if event.event_type == ENTRY:
            open_entries.setdefault(key, []).append(event)
        elif event.event_type == EXIT:
            stack = open_entries.get(key)
            if stack:
                entry = stack.pop()  # 最近一次未配对进场，支持跨午夜
                paired_ids.add(entry.event_id)
                paired_ids.add(event.event_id)
                pairs.append(
                    Pair(
                        entry_id=entry.event_id,
                        exit_id=event.event_id,
                        lot=event.lot,
                        plate=event.plate,
                        entry_time=entry.event_time,
                        exit_time=event.event_time,
                    )
                )
        # 未知类型直接忽略（入库阶段已校验，不会出现）

    pairs.sort(key=lambda p: (p.entry_time, p.entry_id))
    unpaired_ids = [e.event_id for e in ordered if e.event_id not in paired_ids]
    return pairs, unpaired_ids
