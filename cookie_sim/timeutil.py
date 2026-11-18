"""HTTP 日期解析与时间工具。"""
from __future__ import annotations

import calendar
import email.utils
import time
from typing import Optional

# RFC 7231 允许的三种 HTTP-date 格式, 均要求 GMT
_HTTP_DATE_FORMATS = (
    "%a, %d %b %Y %H:%M:%S GMT",  # RFC 1123
    "%A, %d-%b-%y %H:%M:%S GMT",  # RFC 850
    "%a %b %d %H:%M:%S %Y",       # asctime
)


def now_ts() -> float:
    return time.time()


def parse_http_date(value: str) -> Optional[float]:
    """把 HTTP-date 解析为 unix 秒; 无法识别或非 GMT 时返回 None。"""
    if not value:
        return None
    text = value.strip()
    for fmt in _HTTP_DATE_FORMATS:
        try:
            return float(calendar.timegm(time.strptime(text, fmt)))
        except ValueError:
            continue
    # 兜底: 标准库的宽松解析, 但只接受带 GMT/UTC 时区信息的输入
    try:
        parsed = email.utils.parsedate_tz(text)
    except (TypeError, ValueError):
        return None
    if parsed is None or parsed[9] not in (0, None):
        return None
    try:
        return float(calendar.timegm(parsed[:9]))
    except (TypeError, ValueError):
        return None
