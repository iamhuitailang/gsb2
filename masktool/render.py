"""Deterministic RGBA mask rendering shared by video and verification export."""

from __future__ import annotations

import math
from typing import Any

from .core import box_at, clamp


def hex_to_rgb(color: Any, default: tuple[int, int, int] = (0, 0, 0)) -> tuple[int, int, int]:
    if not isinstance(color, str):
        return default
    text = color.strip().lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    if len(text) != 6:
        return default
    try:
        value = int(text, 16)
    except ValueError:
        return default
    return ((value >> 16) & 255, (value >> 8) & 255, value & 255)


def _target_rgba(target: dict[str, Any]) -> tuple[int, int, int, int]:
    r, g, b = hex_to_rgb(target.get("fill") or target.get("color") or "#111111")
    opacity = clamp(float(target.get("opacity", 1.0)), 0.0, 1.0)
    return r, g, b, int(round(255 * opacity))


def render_frame(project: dict[str, Any], t: float, width: int, height: int) -> bytearray:
    """Create a transparent RGBA overlay containing all active masks at *t*."""
    buf = bytearray(width * height * 4)
    if width <= 0 or height <= 0:
        return buf

    for target in project.get("targets") or []:
        if not isinstance(target, dict) or target.get("enabled", True) is False:
            continue
        box = box_at(target, t)
        if not box:
            continue
        rgba = _target_rgba(target)
        if rgba[3] == 0:
            continue
        shape = target.get("shape", "rect")
        if shape == "ellipse":
            _draw_ellipse(buf, width, height, box, rgba)
        else:
            _draw_rect(buf, width, height, box, rgba)
    return buf


def _put_span(
    buf: bytearray,
    width: int,
    height: int,
    x0: int,
    x1: int,
    y: int,
    rgba: tuple[int, int, int, int],
) -> None:
    if y < 0 or y >= height or x1 <= x0:
        return
    x0 = max(0, x0)
    x1 = min(width, x1)
    if x1 <= x0:
        return
    pixel = bytes(rgba)
    start = (y * width + x0) * 4
    buf[start : start + (x1 - x0) * 4] = pixel * (x1 - x0)


def _draw_rect(
    buf: bytearray,
    width: int,
    height: int,
    box: dict[str, float],
    rgba: tuple[int, int, int, int],
) -> None:
    x = float(box["x"]) * width
    y = float(box["y"]) * height
    w = float(box["w"]) * width
    h = float(box["h"]) * height
    x0 = math.floor(x)
    y0 = math.floor(y)
    x1 = math.ceil(x + w)
    y1 = math.ceil(y + h)
    for yy in range(max(0, y0), min(height, y1)):
        _put_span(buf, width, height, x0, x1, yy, rgba)


def _draw_ellipse(
    buf: bytearray,
    width: int,
    height: int,
    box: dict[str, float],
    rgba: tuple[int, int, int, int],
) -> None:
    x = float(box["x"]) * width
    y = float(box["y"]) * height
    w = max(0.0, float(box["w"]) * width)
    h = max(0.0, float(box["h"]) * height)
    if w <= 1 or h <= 1:
        return

    cx = x + w / 2.0
    cy = y + h / 2.0
    rx = w / 2.0
    ry = h / 2.0

    y0 = max(0, math.floor(cy - ry))
    y1 = min(height, math.ceil(cy + ry))
    for yy in range(y0, y1):
        # Pixel-center sampling keeps the silhouette stable at tiny sizes.
        dy = (yy + 0.5) - cy
        fraction = 1.0 - (dy * dy) / (ry * ry)
        if fraction < 0:
            continue
        half = rx * math.sqrt(fraction)
        x0 = math.floor(cx - half)
        x1 = math.ceil(cx + half)
        _put_span(buf, width, height, x0, x1, yy, rgba)
