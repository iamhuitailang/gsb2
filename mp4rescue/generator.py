"""样例素材生成器。

生成一个"标准片":画面带帧号与秒刻度,音频每秒一声定调蜂鸣(音高随秒递增),
用本机 ffmpeg 封装为 empty_moov 的分段 MP4(fMP4)。随后只做字节级手术,
派生出抢救工具需要的全部中断/异常样例:

- good.mp4            完整标准片
- break_moof.mp4      断在分段说明(moof)内部
- break_mdat.mp4      断在画面数据(mdat)内部
- boundary.mp4        恰好写完一整段后中断
- gap.mp4             中间掉一段
- duplicate.mp4       中间重复一段
- no_moov.mp4         起始说明缺失(应被拒绝修复)
- not_mp4.bin         根本不是 MP4(应被拒绝修复)
"""

from __future__ import annotations

import math
import struct
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from . import boxes as bx
from .ffmpeg_wrap import FfmpegError, _resolve

WIDTH, HEIGHT, FPS = 640, 360, 15
DURATION_SECONDS = 12
SAMPLE_RATE = 48000
BEEP_MILLISECONDS = 120
FRAG_DURATION_US = 1_000_000  # 每段约 1 秒


def _font() -> ImageFont.FreeTypeFont:
    for candidate in (
        "/System/Library/Fonts/Supplemental/Courier New Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ):
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, 56)
    return ImageFont.load_default()


def render_video_raw(path: Path) -> None:
    """逐帧渲染 rgb24 原始视频:帧号大字 + 秒刻度 + 渐变背景。"""
    font_big = _font()
    font_small = ImageFont.truetype(font_big.path, 28) if hasattr(font_big, "path") else font_big
    total = FPS * DURATION_SECONDS
    with path.open("wb") as out:
        for frame_no in range(total):
            second = frame_no // FPS
            img = Image.new("RGB", (WIDTH, HEIGHT))
            draw = ImageDraw.Draw(img)
            # 随秒变化的渐变背景,方便肉眼判断顺序
            top = (20 + second * 18 % 200, 40, 90)
            bottom = (10, 10 + second * 15 % 180, 60 + second * 12 % 160)
            for y in range(HEIGHT):
                blend = y / HEIGHT
                color = tuple(int(top[i] * (1 - blend) + bottom[i] * blend) for i in range(3))
                draw.line([(0, y), (WIDTH, y)], fill=color)
            draw.rectangle([40, 60, WIDTH - 40, 220], fill=(15, 15, 15))
            draw.text((WIDTH // 2, 140), f"FRAME {frame_no:04d}",
                      font=font_big, fill=(255, 255, 255), anchor="mm")
            draw.text((WIDTH // 2, 290), f"second {second:02d} / {DURATION_SECONDS - 1}",
                      font=font_small, fill=(255, 220, 120), anchor="mm")
            # 顶部进度条:每帧加一格,直观检查有没有跳帧/乱序
            bar_w = (WIDTH - 80) // total
            draw.rectangle([40, 24, 40 + bar_w * (frame_no + 1), 40], fill=(90, 220, 120))
            out.write(img.tobytes())


def render_audio_raw(path: Path) -> None:
    """每秒一声蜂鸣,频率随秒数 440*(s+1),静音间隔清晰可辨。"""
    beep_len = SAMPLE_RATE * BEEP_MILLISECONDS // 1000
    with path.open("wb") as out:
        for second in range(DURATION_SECONDS):
            freq = 440 * (second + 1)
            for n in range(SAMPLE_RATE):
                if n < beep_len:
                    env = min(1.0, n / 800.0) * min(1.0, (beep_len - n) / 800.0)
                    sample = int(24000 * env * math.sin(2 * math.pi * freq * n / SAMPLE_RATE))
                else:
                    sample = 0
                out.write(struct.pack("<h", sample))


def mux_fmp4(video_raw: Path, audio_raw: Path, dst: Path) -> None:
    ffmpeg = _resolve("ffmpeg")
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS), "-i", str(video_raw),
        "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", str(audio_raw),
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-g", str(FPS), "-c:a", "aac", "-b:a", "96k",
        "-movflags", "empty_moov+default_base_moof",
        "-frag_duration", str(FRAG_DURATION_US),
        str(dst),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise FfmpegError(f"fMP4 封装失败:\n{proc.stderr.strip()}")


def _moof_ranges(data: bytes) -> list[tuple[int, int]]:
    """返回每个 moof 盒子的 (offset, end)。"""
    top = bx.parse_top_level(data)
    return [(b.offset, b.end) for b in top.boxes if b.type == b"moof"]


def _fragment_ranges(data: bytes) -> list[tuple[int, int, int, int]]:
    """返回每段 (moof_offset, moof_end, mdat_offset, mdat_end)。"""
    top = bx.parse_top_level(data)
    ranges = []
    pending: tuple[int, int] | None = None
    for box in top.boxes:
        if box.type == b"moof":
            pending = (box.offset, box.end)
        elif box.type == b"mdat" and pending is not None:
            ranges.append((pending[0], pending[1], box.offset, box.end))
            pending = None
    return ranges


def _write(path: Path, data: bytes) -> None:
    path.write_bytes(data)


def derive_samples(base: Path, out_dir: Path) -> dict[str, Path]:
    data = base.read_bytes()
    frags = _fragment_ranges(data)
    if len(frags) < 6:
        raise FfmpegError(f"标准片分段数过少({len(frags)}),无法派生中断样例")
    moofs = _moof_ranges(data)
    outputs: dict[str, Path] = {}

    # 1) 断在第 5 段的 moof 内部:只保留 moof 头 + 一小截(穿越 mfhd,断在 traf 里)
    moof_off, moof_end = moofs[4]
    cut_moof = moof_off + min(40, (moof_end - moof_off) // 2)
    outputs["break_moof.mp4"] = out_dir / "break_moof.mp4"
    _write(outputs["break_moof.mp4"], data[:cut_moof])

    # 2) 断在第 5 段的 mdat 内部:moof 完整,mdat 只留一半数据
    m_off, m_end, d_off, d_end = frags[4]
    cut_mdat = d_off + 8 + (d_end - d_off - 8) // 2
    outputs["break_mdat.mp4"] = out_dir / "break_mdat.mp4"
    _write(outputs["break_mdat.mp4"], data[:cut_mdat])

    # 3) 恰好写完第 5 段(moof+mdat 完整),其后内容全部丢失
    outputs["boundary.mp4"] = out_dir / "boundary.mp4"
    _write(outputs["boundary.mp4"], data[:frags[4][3]])

    # 4) 掉段:删掉第 5 整段,前后字节直接相连
    gap = data[:frags[4][0]] + data[frags[4][3]:]
    outputs["gap.mp4"] = out_dir / "gap.mp4"
    _write(outputs["gap.mp4"], gap)

    # 5) 重复段:把第 4 段再插一份到第 5 段的位置
    dup = (
        data[:frags[4][0]]
        + data[frags[3][0]:frags[3][3]]
        + data[frags[4][0]:]
    )
    outputs["duplicate.mp4"] = out_dir / "duplicate.mp4"
    _write(outputs["duplicate.mp4"], dup)

    # 6) 起始说明缺失:从第一个 moof 开始,ftyp/moov 全丢
    outputs["no_moov.mp4"] = out_dir / "no_moov.mp4"
    _write(outputs["no_moov.mp4"], data[frags[0][0]:])

    # 7) 音频少一截:取前 11 个完整段,再拼一个"只有视频 traf"的第 12 段。
    #    做法是把原第 12 段 moof 里的音频 traf 删掉,并把 mdat 截到视频样本为止。
    audio_short = _build_video_only_last_fragment(data, frags[11])
    outputs["audio_short.mp4"] = out_dir / "audio_short.mp4"
    _write(outputs["audio_short.mp4"], audio_short)

    # 8) 根本不是 MP4
    outputs["not_mp4.bin"] = out_dir / "not_mp4.bin"
    _write(outputs["not_mp4.bin"], b"THIS IS NOT AN MP4 FILE\n" + b"\x00" * 256)

    return outputs


def _build_video_only_last_fragment(data: bytes, frag: tuple[int, int, int, int]) -> bytes:
    """构造末段只有视频的字节流:删掉该段 moof 中的音频 traf,mdat 只留视频样本。"""
    import struct as _struct

    from .boxes import TRUN_DATA_OFFSET, parse_trun, parse_top_level

    moof_off, moof_end, mdat_off, mdat_end = frag
    top = parse_top_level(data)
    moof = next(b for b in top.boxes if b.type == b"moof" and b.offset == moof_off)
    mfhd = moof.find(b"mfhd")
    traf_boxes = moof.find_all(b"traf")
    video_traf, audio_traf = traf_boxes[0], traf_boxes[1]

    # 视频 traf 的 trun 声明了视频样本总字节,即 mdat 中需要保留的视频数据长度
    trun = video_traf.find(b"trun")
    trun_info = parse_trun(trun)
    video_bytes = sum(s.size or 0 for s in trun_info.samples)

    # 重建 moof:mfhd + 仅视频 traf,盒子大小字段同步改写
    new_moof_body = bytearray()
    new_moof_body += data[moof_off + mfhd.offset - moof_off: moof_off + mfhd.end - moof_off]
    new_video_traf = bytearray(
        data[moof_off + video_traf.offset - moof_off: moof_off + video_traf.end - moof_off]
    )
    # trun.data_offset 相对 moof 起点;moof 变短后要补上差值
    delta = (8 + len(new_moof_body) + len(new_video_traf)) - moof.size
    if trun_info.flags & TRUN_DATA_OFFSET and trun_info.data_offset is not None:
        # trun 在新 traf 内的相对位置不变;载荷 8 字节后即 data_offset 字段
        trun_in_traf = trun.offset - video_traf.offset
        field = trun_in_traf + trun.header_size + 8
        new_offset = trun_info.data_offset + delta
        new_video_traf[field:field + 4] = _struct.pack(">i", new_offset)
    new_moof_body += new_video_traf
    new_moof_size = 8 + len(new_moof_body)
    new_moof = _struct.pack(">I4s", new_moof_size, b"moof") + bytes(new_moof_body)

    # 重建 mdat:8 字节头 + 仅视频样本
    new_mdat = _struct.pack(">I4s", 8 + video_bytes, b"mdat") + data[mdat_off + 8: mdat_off + 8 + video_bytes]
    return data[:moof_off] + new_moof + new_mdat


def generate_all(out_dir: Path) -> dict[str, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="mp4rescue_gen_") as tmp:
        tmp_dir = Path(tmp)
        video_raw = tmp_dir / "video.rgb"
        audio_raw = tmp_dir / "audio.pcm"
        render_video_raw(video_raw)
        render_audio_raw(audio_raw)
        base = out_dir / "good.mp4"
        mux_fmp4(video_raw, audio_raw, base)
    outputs = {"good.mp4": base}
    outputs.update(derive_samples(base, out_dir))
    return outputs
