"""本机样例素材生成：纯 Python 绘制 RGB 帧 + ffmpeg 编码，全程离线。

画面本身携带可读的画面编号（源片号 + 全局帧号 + 时间码），
并在拍点时刻画标记点；音频为连续节拍声，相位按全局时间延续，
因此多个源片拼起来仍是一条连贯的“一条声音来源”。

不依赖 ffmpeg drawtext（本机构建未编入该滤镜），也不引入第三方包。
"""

from __future__ import annotations

import json
import math
import struct
import subprocess
from pathlib import Path

# 5x7 点阵字体（0/1），覆盖数字、大写字母与少量符号
FONT = {
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
    "D": ["11100", "10010", "10001", "10001", "10001", "10010", "11100"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    "G": ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
    "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    "I": ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
    "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
    "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
    ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
    ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"],
    "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
    " ": ["00000"] * 7,
}

# 每档样例的源片时长（秒），总 15s、15fps => 225 帧，单段都很小
DEFAULT_CLIP_SECONDS = (4.0, 5.0, 6.0)
SAMPLE_FPS = 15
SAMPLE_WIDTH = 640
SAMPLE_HEIGHT = 360
SAMPLE_RATE = 44100
BEAT_INTERVAL = 0.5  # 每 0.5s 一个拍点


def _draw_char(buf: bytearray, w: int, h: int, ch: str, x: int, y: int,
               scale: int, color: tuple[int, int, int]) -> int:
    glyph = FONT.get(ch, FONT[" "])
    for row, bits in enumerate(glyph):
        for col, bit in enumerate(bits):
            if bit == "1":
                for dy in range(scale):
                    for dx in range(scale):
                        px, py = x + col * scale + dx, y + row * scale + dy
                        if 0 <= px < w and 0 <= py < h:
                            off = (py * w + px) * 3
                            buf[off:off + 3] = bytes(color)
    return x + (5 + 1) * scale


def _draw_text(buf: bytearray, w: int, h: int, text: str, x: int, y: int,
               scale: int, color: tuple[int, int, int]) -> None:
    cursor = x
    for ch in text:
        cursor = _draw_char(buf, w, h, ch, cursor, y, scale, color)


def _fill(buf: bytearray, color: tuple[int, int, int]) -> None:
    px = bytes(color)
    for i in range(0, len(buf), 3):
        buf[i:i + 3] = px


def render_frame(global_frame: int, clip_index: int, local_frame: int,
                 w: int = SAMPLE_WIDTH, h: int = SAMPLE_HEIGHT,
                 fps: int = SAMPLE_FPS) -> bytes:
    """画一帧：背景色按源片区分，画面编号/时间码大字，拍点高亮点。"""
    buf = bytearray(w * h * 3)
    palette = [(28, 42, 74), (74, 28, 52), (28, 64, 48)]
    base = palette[clip_index % len(palette)]
    _fill(buf, base)

    t = global_frame / fps
    beat_phase = t % BEAT_INTERVAL
    on_beat = beat_phase < 1.0 / fps  # 拍点所在帧
    beat_index = round(t / BEAT_INTERVAL)

    # 顶部：源片与全局帧号
    _draw_text(buf, w, h, f"SRC{clip_index + 1} F{global_frame:03d}", 24, 20, 4, (235, 235, 245))
    # 中部：时间码
    secs = int(t)
    tc = f"{secs // 60:02d}:{secs % 60:02d}.{global_frame % fps:02d}"
    _draw_text(buf, w, h, tc, 24, 110, 6, (255, 220, 120))
    # 底部：拍点编号与节拍圆点
    _draw_text(buf, w, h, f"BEAT {beat_index:03d}", 24, h - 70, 3, (200, 220, 255))
    dot_x, dot_y, dot_r = w - 70, h - 48, 22
    dot_color = (255, 90, 90) if on_beat else (90, 110, 140)
    for yy in range(dot_y - dot_r, dot_y + dot_r):
        for xx in range(dot_x - dot_r, dot_x + dot_r):
            if (xx - dot_x) ** 2 + (yy - dot_y) ** 2 <= dot_r * dot_r:
                off = (yy * w + xx) * 3
                buf[off:off + 3] = bytes(dot_color)
    # 底部进度条：直观显示时间推进，方便肉眼发现重播
    bar_w = int((global_frame / (sum(DEFAULT_CLIP_SECONDS) * fps)) * (w - 48))
    for yy in range(h - 14, h - 8):
        for xx in range(24, 24 + max(0, bar_w)):
            off = (yy * w + xx) * 3
            buf[off:off + 3] = bytes((120, 200, 255))
    return bytes(buf)


def _pcm_beats(frames: int, global_start_frame: int, fps: int) -> bytes:
    """合成节拍音：拍点短促正弦 + 很轻的衬底，相位按全局时间连续。

    每个视频帧对应 SAMPLE_RATE/fps 个 PCM 采样；全局采样号 =
    全局帧时间折算，因此跨源片拼接时相位连续、不产生爆音断点。
    """
    out = bytearray()
    per_frame = SAMPLE_RATE // fps
    global_start_sample = int(global_start_frame / fps * SAMPLE_RATE)
    for n in range(frames):
        t = (global_start_frame + n) / fps
        beat_phase = t % BEAT_INTERVAL
        env = math.exp(-beat_phase * 28) if beat_phase < 0.09 else 0.0
        for k in range(per_frame):
            gs = global_start_sample + n * per_frame + k
            sample_t = gs / SAMPLE_RATE
            val = 0.55 * env * math.sin(2 * math.pi * 880 * sample_t) \
                + 0.05 * math.sin(2 * math.pi * 220 * sample_t)
            pcm = int(max(-1.0, min(1.0, val)) * 32767)
            out += struct.pack("<h", pcm)
    return bytes(out)


def encode_clip(path: Path, frames: int, global_start_frame: int,
                clip_index: int, fps: int = SAMPLE_FPS,
                w: int = SAMPLE_WIDTH, h: int = SAMPLE_HEIGHT) -> None:
    """生成一个带编号画面与节拍音的源短片。

    视频原始 RGB 走 stdin 管道；音频 PCM 先写到临时文件再作为第二输入，
    避免双管道互相写满造成死锁，也不依赖 shell。
    """
    import tempfile

    path.parent.mkdir(parents=True, exist_ok=True)
    audio_pcm = _pcm_beats(frames, global_start_frame, fps)
    with tempfile.NamedTemporaryFile(suffix=".pcm", delete=False) as tmp:
        tmp.write(audio_pcm)
        audio_path = tmp.name
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps),
        "-i", "pipe:0",
        "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", "1",
        "-i", audio_path,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k",
        "-shortest",
        str(path),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        assert proc.stdin is not None
        for f in range(frames):
            proc.stdin.write(render_frame(global_start_frame + f, clip_index, f, w, h, fps))
        proc.stdin.close()
        stderr = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
        code = proc.wait()
    finally:
        Path(audio_path).unlink(missing_ok=True)
        if proc.poll() is None:
            proc.kill()
    if code != 0:
        raise RuntimeError(f"ffmpeg 编码样例失败: {stderr[-400:]}")


def generate_source_clips(
    out_dir: str | Path,
    clip_seconds: tuple[float, ...] = DEFAULT_CLIP_SECONDS,
    fps: int = SAMPLE_FPS,
) -> dict:
    """生成编号源片 + markers.json（拍点与每帧画面编号映射）。"""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    markers: dict = {"fps": fps, "beat_interval": BEAT_INTERVAL, "beats": [], "frames": []}
    global_frame = 0
    for i, secs in enumerate(clip_seconds):
        frames = int(round(secs * fps))
        encode_clip(out / f"clip{i + 1}.mp4", frames, global_frame, i, fps)
        for f in range(frames):
            g = global_frame + f
            tt = g / fps
            markers["frames"].append({
                "global_frame": g,
                "time": round(tt, 4),
                "label": f"src{i + 1}/f{f:03d}",
                "beat": round(tt / BEAT_INTERVAL),
            })
            if abs(tt % BEAT_INTERVAL) < 1e-9:
                markers["beats"].append({"time": round(tt, 4), "index": round(tt / BEAT_INTERVAL)})
        global_frame += frames
    (out / "markers.json").write_text(json.dumps(markers, ensure_ascii=False, indent=2),
                                      encoding="utf-8")
    return markers
