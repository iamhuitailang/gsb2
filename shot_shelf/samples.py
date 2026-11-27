"""Generate a deterministic local demo clip with ffmpeg lavfi.

No network, no third-party footage.  The clip is designed to exercise every
detector rule:

============  ======================================================
0 – 3s        static navy scene, static card
3 – 6s        hard cut to teal
6 – 10s       same composition, slow hue drift (must NOT split)
10 – 12s      hard cut to brick red
12 – 12.6s    0.6s white flash (short shot, strong cuts both sides)
12.6 – 16s    blue scene with a small brightness step at 14.37s
16 – 19s      static grey
19 – 21.5s    slow dissolve to purple (gradual transition)
21.5 – 24s    static purple ending
============  ======================================================

``samples/sample_manifest.json`` records the intended boundaries so the demo
can compare "自动建议" against the designed ground truth.
"""

from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path

from . import media
from .store import samples_dir

SAMPLE_VERSION = 5
SAMPLE_NAME = "shot-shelf-demo.mp4"
FPS = 25
WIDTH = 640
HEIGHT = 360

_FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]


class SampleError(RuntimeError):
    pass


EXPECTED = {
    "hard": [3000, 10000],
    "short_shot": {"start": 12000, "end": 12600},
    "weak": [14367],
    "gradual": [19200, 21400],
    "static_regions": [[0, 3000], [16000, 19000], [21500, 24000]],
    "slow_change_regions": [[6000, 10000]],
    "notes": [
        "0–3s 静止：理想情况下 0 个切点。",
        "3s、10s 硬切：应稳定检出。",
        "6–10s 只有轻微色相漂移：不应被切成多段。",
        "12–12.6s 短镜头两侧都是强切：应保留，不应被最小镜头长度吞掉。",
        "14.37s 蓝色场景的轻微亮度跳变：应判为弱变化并合并。",
        "19–21.5s 慢渐变转场：应识别为一个渐变切点，而不是连续多个硬切。",
    ],
}


def _font_path() -> str | None:
    for candidate in _FONT_CANDIDATES:
        if os.path.exists(candidate):
            return candidate
    return None


def _has_drawtext() -> bool:
    try:
        return bool(media.doctor().get("drawtext_filter"))
    except Exception:  # noqa: BLE001 - optional decoration only
        return False


def _run(cmd: list[str]) -> None:
    result = media._run(cmd, timeout=600)
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip().splitlines()[-8:]
        raise SampleError("生成样片失败：" + (" / ".join(detail) if detail else f"退出码 {result.returncode}"))


def _drawtext(label: str, font: str) -> str:
    escaped = label.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
    escaped_font = font.replace(":", "\\:").replace("'", "\\'")
    return (
        f"drawtext=fontfile='{escaped_font}':text='{escaped}':"
        "x=22:y=h-44:fontsize=19:fontcolor=white@0.9:"
        "box=1:boxcolor=black@0.45:boxborderw=8"
    )


def _segment(
    out_path: Path,
    *,
    seconds: float,
    color: str,
    overlays: str = "",
    motion: str = "",
    label: str = "",
    font: str | None = None,
) -> None:
    def build_filter(include_label: bool) -> str:
        parts = []
        if overlays:
            parts.append(overlays)
        if motion:
            parts.append(motion)
        if include_label and label and font:
            parts.append(_drawtext(label, font))
        parts.append("format=yuv420p")
        return ",".join(parts)

    def attempt(include_label: bool) -> bool:
        cmd = [
            media.ffmpeg_bin(),
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"color=c={color}:s={WIDTH}x{HEIGHT}:r={FPS}:d={seconds:.3f}",
            "-vf",
            build_filter(include_label),
            "-t",
            f"{seconds:.3f}",
            "-r",
            str(FPS),
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-an",
            "-y",
            str(out_path),
        ]
        result = media._run(cmd, timeout=600)
        return result.returncode == 0

    # A label is decoration only: if drawtext is missing or the font lacks the
    # glyphs, retry without it rather than failing the whole sample.
    use_label = bool(label and font)
    ok = attempt(use_label)
    if not ok and use_label:
        ok = attempt(False)
    if not ok:
        raise SampleError(f"生成样片片段失败：{out_path.name}")


# Static compositions used in several segments.
_TEAL_SHAPES = (
    "drawbox=x=120:y=70:w=180:h=180:color=0x1f8f7f:t=fill,"
    "drawbox=x=360:y=110:w=180:h=100:color=0xa9e6d8:t=fill,"
    "drawbox=x=360:y=240:w=110:h=44:color=0xffd479:t=fill"
)
_GREY_SHAPES = (
    "drawbox=x=180:y=90:w=280:h=170:color=0x44484f:t=fill,"
    "drawbox=x=220:y=130:w=200:h=90:color=0x8a8f98:t=fill"
)
_PURPLE_SHAPES = (
    "drawbox=x=180:y=90:w=280:h=170:color=0x6a4f8a:t=fill,"
    "drawbox=x=220:y=130:w=200:h=90:color=0xc9b3e8:t=fill"
)


def _build(tmp_dir: Path, font: str | None) -> list[Path]:
    pieces: list[Path] = []

    # 0–3s: static navy.
    path = tmp_dir / "seg-00.mp4"
    _segment(
        path,
        seconds=3.0,
        color="0x16233d",
        overlays=(
            "drawbox=x=170:y=80:w=300:h=170:color=0x2f4a7d:t=fill,"
            "drawbox=x=200:y=110:w=240:h=110:color=0x9fb8dd:t=fill,"
            "drawbox=x=270:y=250:w=100:h=12:color=0xd9e4f5:t=fill"
        ),
        label="01 static / expect 0 cuts" if font else "",
        font=font,
    )
    pieces.append(path)

    # 3–6s: hard cut to teal.
    path = tmp_dir / "seg-01.mp4"
    _segment(
        path, seconds=3.0, color="0x0f3f3a", overlays=_TEAL_SHAPES,
        label="02 hard cut to teal" if font else "", font=font,
    )
    pieces.append(path)

    # 6–10s: identical composition, slow hue drift → one shot.
    path = tmp_dir / "seg-02.mp4"
    _segment(
        path, seconds=4.0, color="0x0f3f3a", overlays=_TEAL_SHAPES,
        motion="hue=h='2.0*t':s=0.9",
        label="03 slow drift / expect no cut" if font else "", font=font,
    )
    pieces.append(path)

    # 10–12s: hard cut to brick red.
    path = tmp_dir / "seg-03.mp4"
    _segment(
        path, seconds=2.0, color="0x4a1f1a",
        overlays=(
            "drawbox=x=90:y=60:w=210:h=210:color=0xb4472f:t=fill,"
            "drawbox=x=330:y=120:w=220:h=120:color=0xf0b6a2:t=fill"
        ),
        label="04 hard cut to brick red" if font else "", font=font,
    )
    pieces.append(path)

    # 12–12.6s: 0.6s white flash; strong cuts on both sides.
    path = tmp_dir / "seg-04.mp4"
    _segment(
        path, seconds=0.6, color="0xf2f2ee",
        overlays="drawbox=x=60:y=60:w=520:h=240:color=0xffffff:t=fill",
        label="05 short shot 0.6s" if font else "", font=font,
    )
    pieces.append(path)

    # 12.6–16s: blue scene with a small brightness step at 1.767s.
    path = tmp_dir / "seg-05.mp4"
    _segment(
        path, seconds=3.4, color="0x182a52",
        overlays=(
            "drawbox=x=140:y=90:w=360:h=180:color=0x2b4f9e:t=fill,"
            "drawbox=x=180:y=130:w=120:h=100:color=0x8fb4ff:t=fill,"
            "drawbox=x=330:y=130:w=130:h=100:color=0xcfd9f2:t=fill"
        ),
        motion="eq=brightness='if(gt(t,1.767),0.05,0)'",
        label="06 weak change / expect merge" if font else "", font=font,
    )
    pieces.append(path)

    # 16–19s: static grey.
    path = tmp_dir / "seg-06.mp4"
    _segment(
        path, seconds=3.0, color="0x24262b", overlays=_GREY_SHAPES,
        label="07 static / expect 0 cuts" if font else "", font=font,
    )
    pieces.append(path)

    # 19–21.5s: slow dissolve grey → purple.
    path = tmp_dir / "seg-07.mp4"
    duration = 2.5
    fade = 2.2
    cmd = [
        media.ffmpeg_bin(),
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        f"color=c=0x24262b:s={WIDTH}x{HEIGHT}:r={FPS}:d={duration:.3f}",
        "-f",
        "lavfi",
        "-i",
        f"color=c=0x3a2350:s={WIDTH}x{HEIGHT}:r={FPS}:d={duration:.3f}",
        "-filter_complex",
        (
            f"[0:v]{_GREY_SHAPES},setsar=1,format=yuv420p[a];"
            f"[1:v]{_PURPLE_SHAPES},setsar=1,format=yuv420p[b];"
            f"[a][b]xfade=transition=fade:duration={fade:.3f}:offset={duration - fade:.3f},"
            f"format=yuv420p[v]"
        ),
        "-map",
        "[v]",
        "-t",
        f"{duration:.3f}",
        "-r",
        str(FPS),
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-an",
        "-y",
        str(path),
    ]
    _run(cmd)
    pieces.append(path)

    # 21.5–24s: static purple ending.
    path = tmp_dir / "seg-08.mp4"
    _segment(
        path, seconds=2.5, color="0x3a2350", overlays=_PURPLE_SHAPES,
        label="08 static ending" if font else "", font=font,
    )
    pieces.append(path)
    return pieces


def _concat(pieces: list[Path], out_path: Path, tmp_dir: Path) -> None:
    list_file = tmp_dir / "concat.txt"
    list_file.write_text(
        "\n".join(f"file '{piece.as_posix()}'" for piece in pieces) + "\n", encoding="utf-8"
    )
    cmd = [
        media.ffmpeg_bin(),
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(list_file),
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-y",
        str(out_path),
    ]
    _run(cmd)


def _manifest_path() -> Path:
    return samples_dir() / "sample_manifest.json"


def _read_manifest() -> dict | None:
    path = _manifest_path()
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if payload.get("version") == SAMPLE_VERSION else None


def ensure_sample(*, regenerate: bool = False) -> dict:
    video_path = samples_dir() / SAMPLE_NAME
    manifest = _read_manifest()
    if not regenerate and manifest and video_path.exists():
        stat = video_path.stat()
        if manifest.get("size") == stat.st_size:
            return {"video_path": str(video_path), "regenerated": False, "manifest": manifest}

    # ffmpeg lives on PATH; use media.ffmpeg_bin() semantics rather than a
    # hand-rolled check so SHOT_SHELF_FFMPEG is honoured consistently.
    try:
        media.ffmpeg_bin()
    except media.MediaError as exc:
        raise SampleError(str(exc)) from exc
    doctor = media.doctor()
    if not doctor.get("libx264"):
        raise SampleError("ffmpeg 缺少 libx264 编码器，无法生成样片")

    font = _font_path() if _has_drawtext() else None
    tmp_dir = samples_dir() / ".build"
    shutil.rmtree(tmp_dir, ignore_errors=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)
    try:
        pieces = _build(tmp_dir, font)
        staging = tmp_dir / SAMPLE_NAME
        _concat(pieces, staging, tmp_dir)
        info = media.probe(staging)
        os.replace(staging, video_path)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    manifest = {
        "version": SAMPLE_VERSION,
        "name": "Shot Shelf 演示样片",
        "video": SAMPLE_NAME,
        "fps": info.fps,
        "duration_ms": info.duration_ms,
        "width": info.width,
        "height": info.height,
        "size": video_path.stat().st_size,
        "labels_included": bool(font),
        "expected": EXPECTED,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "recipe": [
            "0–3s     静止深蓝画面，期望 0 个自动切点",
            "3s       硬切到青绿",
            "6–10s    构图不变，仅轻微色相漂移，期望不切",
            "10s      硬切到砖红",
            "12–12.6s 白色短镜头，两侧均为强切，期望保留",
            "14.37s   蓝色场景亮度轻跳，期望判为弱变化并合并",
            "16–19s   静止深灰画面",
            "19–21.5s 慢渐变转场到紫色，期望识别为渐变切点",
            "21.5–24s 紫色静止收尾",
        ],
    }
    _manifest_path().write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"video_path": str(video_path), "regenerated": True, "manifest": manifest}


def describe() -> dict:
    video_path = samples_dir() / SAMPLE_NAME
    manifest = _read_manifest()
    exists = video_path.exists()
    return {
        "exists": exists,
        "path": str(video_path) if exists else None,
        "expected_path": str(video_path),
        "manifest": manifest,
        "hint": "样片由 ffmpeg 在本机生成，包含硬切、慢变化、静止画面、短镜头、闪光与弱变化。",
    }
