"""Header-name normalisation shared by the API layer."""

from __future__ import annotations

from typing import Any

from .config import FIELD_ORDER

HEADER_ALIASES: dict[str, str] = {
    "x-forwarded-for": "x_forwarded_for",
    "x_forwarded_for": "x_forwarded_for",
    "xff": "x_forwarded_for",
    "forwarded": "forwarded",
    "x-real-ip": "x_real_ip",
    "x_real_ip": "x_real_ip",
    "cf-connecting-ip": "cf_connecting_ip",
    "cf_connecting_ip": "cf_connecting_ip",
}

FIELD_TO_HEADER = {
    "x_forwarded_for": "X-Forwarded-For",
    "forwarded": "Forwarded",
    "x_real_ip": "X-Real-IP",
    "cf_connecting_ip": "CF-Connecting-IP",
}


def normalize_headers(raw: Any) -> tuple[dict[str, list[str]], list[dict[str, str]]]:
    """Normalise submitted header data.

    Accepts a mapping whose values are strings, lists of strings, or a JSON
    encoded string (used by the comma-in-value form).  Returns per-field
    occurrence lists plus structured errors.
    """
    errors: list[dict[str, str]] = []
    result: dict[str, list[str]] = {key: [] for key in FIELD_ORDER}
    if raw is None:
        return result, errors
    if not isinstance(raw, dict):
        return result, [
            {
                "field": "headers",
                "code": "type",
                "message": "转发字段必须是对象（键为字段名，值为字符串或字符串数组）",
            }
        ]

    for name, value in raw.items():
        canonical = HEADER_ALIASES.get(str(name).strip().lower())
        if canonical is None:
            errors.append(
                {
                    "field": f"headers.{name}",
                    "code": "unknown_header",
                    "message": (
                        f"未识别的转发字段 {name!r}；支持 X-Forwarded-For、Forwarded、"
                        "X-Real-IP、CF-Connecting-IP"
                    ),
                }
            )
            continue
        if value in (None, ""):
            continue
        if isinstance(value, str):
            result[canonical].append(value)
        elif isinstance(value, list):
            for index, item in enumerate(value):
                if item in (None, ""):
                    continue
                if not isinstance(item, str):
                    errors.append(
                        {
                            "field": f"headers.{name}[{index}]",
                            "code": "type",
                            "message": "每条字段内容必须是字符串",
                        }
                    )
                    continue
                result[canonical].append(item)
        else:
            errors.append(
                {
                    "field": f"headers.{name}",
                    "code": "type",
                    "message": "字段值必须是字符串或字符串数组",
                }
            )
    return result, errors


def headers_as_list(headers: dict[str, list[str]]) -> list[dict[str, str]]:
    """Serialize headers for storage, preserving occurrences and order."""
    stored: list[dict[str, str]] = []
    for key in FIELD_ORDER:
        for value in headers.get(key, []):
            stored.append({"name": key, "header": FIELD_TO_HEADER[key], "value": value})
    return stored
