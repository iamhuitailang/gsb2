"""Generate a copyright-free demo clip from geometry and fictional numbers."""

from __future__ import annotations

import math
import subprocess
from pathlib import Path
from typing import Any

from .core import new_id
from .media import ffmpeg_bin, probe_video

WIDTH = 1280
HEIGHT = 720
FPS = 30
DURATION = 12.0

FONT: dict[str, list[str]] = {
    "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
    "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
    "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "X": ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
    "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
    ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"],
    " ": ["00000"] * 7,
}


def demo_spec() -> list[dict[str, Any]]:
    return [
        {
            "id": "demo-a",
            "name": "蓝牌 NO 0427",
            "label": "NO 0427",
            "shape": "rect",
            "demoColor": (37, 99, 235),
            "color": "#60a5fa",
            "fill": "#111827",
            "keyframes": [
                {"id": "a0", "t": 0.0, "x": 0.06, "y": 0.18, "w": 0.17, "h": 0.10},
                {"id": "a2", "t": 2.0, "x": 0.25, "y": 0.25, "w": 0.17, "h": 0.10},
                {"id": "a4", "t": 4.0, "x": 0.47, "y": 0.39, "w": 0.17, "h": 0.10},
                {"id": "a6", "t": 6.0, "x": 0.68, "y": 0.29, "w": 0.17, "h": 0.10},
                {"id": "a7", "t": 7.0, "x": 0.82, "y": 0.22, "w": 0.17, "h": 0.10},
                {"id": "a74", "t": 7.4, "x": 1.06, "y": 0.19, "w": 0.17, "h": 0.10},
                {"id": "a88", "t": 8.8, "x": 1.06, "y": 0.27, "w": 0.17, "h": 0.10},
                {"id": "a92", "t": 9.2, "x": 0.82, "y": 0.31, "w": 0.17, "h": 0.10},
                {"id": "a105", "t": 10.5, "x": 0.58, "y": 0.43, "w": 0.17, "h": 0.10},
                {"id": "a12", "t": 12.0, "x": 0.32, "y": 0.57, "w": 0.17, "h": 0.10},
            ],
            "gaps": [{"id": "gap-a", "start": 7.04, "end": 9.16, "reason": "右侧出画"}],
        },
        {
            "id": "demo-b",
            "name": "橙椭圆 B-204",
            "label": "B-204",
            "shape": "ellipse",
            "demoColor": (249, 115, 22),
            "color": "#fb923c",
            "fill": "#111827",
            "keyframes": [
                {"id": "b0", "t": 0.0, "x": 0.80, "y": 0.47, "w": 0.18, "h": 0.115},
                {"id": "b2", "t": 2.0, "x": 0.62, "y": 0.43, "w": 0.18, "h": 0.115},
                {"id": "b4", "t": 4.0, "x": 0.43, "y": 0.37, "w": 0.18, "h": 0.115},
                {"id": "b6", "t": 6.0, "x": 0.25, "y": 0.48, "w": 0.18, "h": 0.115},
                {"id": "b8", "t": 8.0, "x": 0.10, "y": 0.58, "w": 0.18, "h": 0.115},
                {"id": "b10", "t": 10.0, "x": 0.25, "y": 0.68, "w": 0.18, "h": 0.115},
                {"id": "b12", "t": 12.0, "x": 0.48, "y": 0.73, "w": 0.18, "h": 0.115},
            ],
            "gaps": [],
        },
        {
            "id": "demo-c",
            "name": "绿牌 C-77",
            "label": "C-77",
            "shape": "rect",
            "demoColor": (22, 163, 74),
            "color": "#4ade80",
            "fill": "#111827",
            "keyframes": [
                {"id": "c0", "t": 0.0, "x": 0.46, "y": 0.84, "w": 0.15, "h": 0.095},
                {"id": "c24", "t": 2.4, "x": 0.43, "y": 0.74, "w": 0.15, "h": 0.095},
                {"id": "c4", "t": 4.0, "x": 0.40, "y": 0.54, "w": 0.15, "h": 0.095},
                {"id": "c56", "t": 5.6, "x": 0.37, "y": 0.34, "w": 0.15, "h": 0.095},
                {"id": "c66", "t": 6.6, "x": 0.35, "y": 0.13, "w": 0.15, "h": 0.095},
                {"id": "c7", "t": 7.0, "x": 0.34, "y": -0.14, "w": 0.15, "h": 0.095},
                {"id": "c88", "t": 8.8, "x": 0.18, "y": -0.15, "w": 0.15, "h": 0.095},
                {"id": "c94", "t": 9.4, "x": 0.17, "y": 0.16, "w": 0.15, "h": 0.095},
                {"id": "c106", "t": 10.6, "x": 0.14, "y": 0.38, "w": 0.15, "h": 0.095},
                {"id": "c12", "t": 12.0, "x": 0.11, "y": 0.58, "w": 0.15, "h": 0.095},
            ],
            "gaps": [{"id": "gap-c", "start": 6.72, "end": 9.32, "reason": "上方出画"}],
        },
    ]


def demo_project(asset_id: str = "demo") -> dict[str, Any]:
    targets = []
    for spec in demo_spec():
        target = {k: v for k, v in spec.items() if k not in {"label", "demoColor"}}
        # The generated plate path contains fully off-screen control points.
        # The editable sample project keeps only in-frame boundary keys plus
        # explicit no-mask gaps, demonstrating the recommended workflow.
        target["keyframes"] = [
            dict(key)
            for key in spec["keyframes"]
            if key.get("x", 0) >= -0.001
            and key.get("y", 0) >= -0.001
            and key.get("x", 0) + key.get("w", 0) <= 1.001
            and key.get("y", 0) + key.get("h", 0) <= 1.001
        ]
        target["enabled"] = True
        targets.append(target)
    return {
        "version": 1,
        "app": "number-mask-workbench",
        "assetId": asset_id,
        "video": {
            "name": "内置演示_几何体号码牌.mp4",
            "assetId": asset_id,
            "width": WIDTH,
            "height": HEIGHT,
            "duration": DURATION,
            "fps": FPS,
        },
        "settings": {"keyInterval": 1.0, "padding": 0, "verifyKeyFrames": True},
        "targets": targets,
        "reviews": {},
    }


def _span(buf: bytearray, x0: int, x1: int, y: int, color: tuple[int, int, int, int]) -> None:
    if y < 0 or y >= HEIGHT or x1 <= x0:
        return
    x0 = max(0, x0)
    x1 = min(WIDTH, x1)
    if x1 <= x0:
        return
    start = (y * WIDTH + x0) * 4
    buf[start : start + (x1 - x0) * 4] = bytes(color) * (x1 - x0)


def _rect(buf: bytearray, x0: int, y0: int, x1: int, y1: int, color: tuple[int, int, int]) -> None:
    for y in range(max(0, int(y0)), min(HEIGHT, math.ceil(y1))):
        _span(buf, math.floor(x0), math.ceil(x1), y, (*color, 255))


def _ellipse(buf: bytearray, cx: float, cy: float, rx: float, ry: float, color: tuple[int, int, int]) -> None:
    for y in range(max(0, math.floor(cy - ry)), min(HEIGHT, math.ceil(cy + ry))):
        dy = y + 0.5 - cy
        f = 1 - dy * dy / max(1.0, ry * ry)
        if f < 0:
            continue
        half = rx * math.sqrt(f)
        _span(buf, math.floor(cx - half), math.ceil(cx + half), y, (*color, 255))


def _text_size(text: str, scale: int) -> tuple[int, int]:
    return len(text) * 6 * scale - scale, 7 * scale


def _draw_text(
    buf: bytearray,
    text: str,
    cx: float,
    cy: float,
    scale: int,
    color: tuple[int, int, int] = (255, 255, 255),
) -> None:
    width, height = _text_size(text, scale)
    x = round(cx - width / 2)
    y = round(cy - height / 2)
    for char in text.upper():
        glyph = FONT.get(char, FONT["-"])
        for row_index, row in enumerate(glyph):
            for col_index, pixel in enumerate(row):
                if pixel != "1":
                    continue
                px = x + col_index * scale
                py = y + row_index * scale
                _rect(buf, px, py, px + scale, py + scale, color)
        x += 6 * scale


def _background() -> bytearray:
    buf = bytearray(WIDTH * HEIGHT * 4)
    top = (238, 242, 247)
    bottom = (203, 213, 225)
    for y in range(HEIGHT):
        u = y / HEIGHT
        color = tuple(round(top[i] + (bottom[i] - top[i]) * u) for i in range(3))
        _span(buf, 0, WIDTH, y, (*color, 255))

    # Grid.
    for x in range(0, WIDTH, 80):
        _rect(buf, x, 0, x + 2, HEIGHT, (226, 232, 240))
    for y in range(0, HEIGHT, 80):
        _rect(buf, 0, y, WIDTH, y + 2, (226, 232, 240))

    # Static geometric set dressing.
    _ellipse(buf, 165, 610, 150, 150, (186, 230, 253))
    _ellipse(buf, 1110, 120, 190, 190, (254, 215, 170))
    _rect(buf, 880, 520, 1180, 650, (220, 252, 231))
    # Triangle near center-bottom.
    for i in range(150):
        half = i * 0.75
        y = 560 + i
        _span(buf, 300 - int(half), 300 + int(half), y, (233, 213, 255, 255))

    _draw_text(buf, "CAM 14777", 145, 42, 3, (71, 85, 105))
    return buf


def _demo_box_at(spec: dict[str, Any], t: float) -> dict[str, float]:
    keys = sorted(spec["keyframes"], key=lambda k: k["t"])
    if t <= keys[0]["t"]:
        return keys[0]
    if t >= keys[-1]["t"]:
        return keys[-1]
    for left, right in zip(keys, keys[1:]):
        if left["t"] <= t <= right["t"]:
            u = (t - left["t"]) / (right["t"] - left["t"])
            return {k: left[k] + (right[k] - left[k]) * u for k in ("x", "y", "w", "h")}
    return keys[0]


def _draw_plate(buf: bytearray, spec: dict[str, Any], t: float) -> None:
    box = _demo_box_at(spec, t)
    x0 = box["x"] * WIDTH
    y0 = box["y"] * HEIGHT
    x1 = (box["x"] + box["w"]) * WIDTH
    y1 = (box["y"] + box["h"]) * HEIGHT
    fill = spec["demoColor"]
    border = (255, 255, 255)

    if spec["shape"] == "ellipse":
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        _ellipse(buf, cx, cy, (x1 - x0) / 2 + 5, (y1 - y0) / 2 + 5, (15, 23, 42))
        _ellipse(buf, cx, cy, (x1 - x0) / 2, (y1 - y0) / 2, fill)
        # A light inner band helps the fictional digits read.
        _ellipse(buf, cx, cy, (x1 - x0) / 2 - 8, (y1 - y0) / 2 - 8, tuple(min(255, c + 28) for c in fill))
    else:
        _rect(buf, x0 - 5, y0 - 5, x1 + 5, y1 + 5, (15, 23, 42))
        _rect(buf, x0, y0, x1, y1, fill)
        _rect(buf, x0 + 7, y0 + 7, x1 - 7, y1 - 7, tuple(min(255, c + 24) for c in fill))

    scale = 4 if len(spec["label"]) >= 6 else 5
    _draw_text(buf, spec["label"], (x0 + x1) / 2, (y0 + y1) / 2 + 1, scale, (255, 255, 255))


def render_demo_frame(background: bytearray, t: float) -> bytes:
    buf = bytearray(background)
    for spec in demo_spec():
        _draw_plate(buf, spec, t)

    # Frame/time code makes frame-by-frame checks obvious.
    frame = int(round(t * FPS))
    _draw_text(buf, f"T {t:04.1f} F{frame:03d}", WIDTH - 190, 38, 3, (71, 85, 105))
    return bytes(buf)


def generate_demo(asset_dir: Path, force: bool = False) -> Path:
    asset_dir.mkdir(parents=True, exist_ok=True)
    out = asset_dir / "source.mp4"
    if out.exists() and not force:
        return out

    background = _background()
    audio = (
        "aevalsrc=0.045*sin(2*PI*261.63*t)+0.018*sin(2*PI*392.0*t)"
        f":d={DURATION}:s=44100"
    )
    cmd = [
        ffmpeg_bin(),
        "-y",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgba",
        "-video_size",
        f"{WIDTH}x{HEIGHT}",
        "-framerate",
        str(FPS),
        "-i",
        "-",
        "-f",
        "lavfi",
        "-i",
        audio,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-shortest",
        str(out),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    assert proc.stdin and proc.stderr
    try:
        total_frames = int(DURATION * FPS)
        for i in range(total_frames):
            proc.stdin.write(render_demo_frame(background, i / FPS))
        proc.stdin.close()
    except BrokenPipeError as exc:
        stderr = proc.stderr.read().decode("utf-8", "replace")[-2000:]
        raise RuntimeError(f"演示视频生成失败：{stderr}") from exc
    code = proc.wait()
    if code != 0:
        stderr = proc.stderr.read().decode("utf-8", "replace")[-2000:]
        raise RuntimeError(f"演示视频编码失败：{stderr}")
    probe_video(out)
    return out
