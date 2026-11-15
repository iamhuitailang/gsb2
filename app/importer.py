"""道闸导出 CSV 解析。

支持中文表头（兼容英文别名），列：
停车场, 闸机号, 流水号, 车牌, 事件类型, 事件时间[, 来源文件]

事件类型：进场/entry/入；出场/exit/出。
文件可能乱序到达，本模块只负责解析与校验，配对与导入顺序无关。
"""

from __future__ import annotations

import csv
import io

from .pairing import ENTRY, EXIT
from .storage import parse_event_time

HEADER_MAP = {
    "停车场": "lot",
    "parkinglot": "lot",
    "lot": "lot",
    "闸机号": "gate",
    "gate": "gate",
    "流水号": "seq",
    "seq": "seq",
    "车牌": "plate",
    "plate": "plate",
    "事件类型": "event_type",
    "type": "event_type",
    "eventtype": "event_type",
    "事件时间": "event_time",
    "time": "event_time",
    "eventtime": "event_time",
}

TYPE_MAP = {
    "进场": ENTRY,
    "入场": ENTRY,
    "入": ENTRY,
    "entry": ENTRY,
    "in": ENTRY,
    "出场": EXIT,
    "离场": EXIT,
    "出": EXIT,
    "exit": EXIT,
    "out": EXIT,
}

REQUIRED = ("lot", "gate", "seq", "plate", "event_type", "event_time")


class CsvFormatError(ValueError):
    pass


def parse_csv(content: str) -> list[dict]:
    """把 CSV 文本解析为标准化事件行列表。空行忽略，错误行会带行号抛出。"""
    reader = csv.reader(io.StringIO(content))
    rows = list(reader)
    if not rows:
        raise CsvFormatError("空文件")

    header = [h.strip().lstrip("﻿") for h in rows[0]]
    columns = []
    for name in header:
        key = HEADER_MAP.get(name.lower())
        if key is None:
            raise CsvFormatError(f"未知表头列: {name!r}")
        columns.append(key)
    missing = [c for c in REQUIRED if c not in columns]
    if missing:
        raise CsvFormatError(f"缺少必需列: {', '.join(missing)}")

    events: list[dict] = []
    for line_no, raw in enumerate(rows[1:], start=2):
        if not raw or not any(cell.strip() for cell in raw):
            continue
        if len(raw) != len(columns):
            raise CsvFormatError(f"第 {line_no} 行列数与表头不一致")
        record = dict(zip(columns, (cell.strip() for cell in raw)))
        try:
            seq = int(record["seq"])
            event_type = TYPE_MAP.get(record["event_type"].lower())
            if event_type is None:
                raise CsvFormatError(
                    f"第 {line_no} 行事件类型非法: {record['event_type']!r}"
                )
            parse_event_time(record["event_time"])  # 校验时间格式
        except CsvFormatError:
            raise
        except ValueError as exc:
            raise CsvFormatError(f"第 {line_no} 行字段格式错误: {exc}") from exc
        if not record["lot"] or not record["gate"] or not record["plate"]:
            raise CsvFormatError(f"第 {line_no} 行存在空字段")
        record["seq"] = seq
        record["plate"] = record["plate"].upper()
        record["event_type"] = event_type
        events.append(record)
    return events
