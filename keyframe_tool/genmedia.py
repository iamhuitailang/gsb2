"""生成测试素材：帧号烧录、长短不一的关键帧间隔、几个短提示音。

当前 ffmpeg 没编 drawtext，帧号文字用 Pillow 直接画进每帧 PNG，
再交给 ffmpeg 编码，因此生成结果不依赖字体滤镜。

产出三个素材（覆盖有声音 / 无声音 / 非零轨道起点三种情况）：
  sample_sound.mp4    带提示音，长短 GOP
  sample_silent.mp4   同一画面但无音轨
  sample_offset.mp4  带声音，整体延后 1.300s，用来验证起点偏差不会被重复计算
另写 sample_manifest.json 记录设计参数与预期关键帧，供自测和人工对照。
"""

from __future__ import annotations

import json
import math
import os
import shutil
import struct
import subprocess
import tempfile

from .ffmpeg_utils import FFmpegError, run_ffmpeg

WIDTH, HEIGHT, FPS = 640, 360, 30
DURATION = 12.0
N_FRAMES = int(DURATION * FPS)
# 长短交替的 GOP：1.0s、2.5s、0.5s、3.0s、1.0s、2.0s、1.5s（秒）
GOP_SECONDS = [1.0, 2.5, 0.5, 3.0, 1.0, 2.0, 1.5]
BEEP_TIMES = [0.8, 3.5, 6.0, 9.5]   # 短提示音出现的显示时间
BEEP_FREQS = [880, 660, 990, 740]
BEEP_DUR = 0.18
OFFSET_SECONDS = 1.3


def _render_frames(frame_dir: str) -> None:
    from PIL import Image, ImageDraw, ImageFont

    font_big = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 56)
    font_small = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 22)
    for i in range(N_FRAMES):
        img = Image.new("RGB", (WIDTH, HEIGHT))
        draw = ImageDraw.Draw(img)
        # 背景逐帧微变的渐变，保证任意两帧画面不同（PSNR/哈希可区分）
        shift = int(40 + 60 * (0.5 + 0.5 * math.sin(i / 9.0)))
        for y in range(HEIGHT):
            draw.line(
                [(0, y), (WIDTH, y)],
                fill=((y + i * 3) % 256, (y * 2 + shift) % 256, (y // 2 + i) % 256),
            )
        # 移动方块，提供明显的运动特征
        x = 30 + int((WIDTH - 90) * (i / max(1, N_FRAMES - 1)))
        draw.rectangle([x, 240, x + 60, 300], fill=(255, 235, 80), outline=(0, 0, 0), width=2)
        # 帧号（大字）与显示时间
        draw.rectangle([0, 0, WIDTH, 100], fill=(20, 20, 30))
        draw.text((20, 14), f"FRAME {i:04d}", font=font_big, fill=(255, 255, 255))
        draw.text((24, 76), f"t={i / FPS:7.3f}s  GOP keyframe pattern test", font=font_small, fill=(180, 220, 255))
        img.save(os.path.join(frame_dir, f"frame_{i:05d}.png"))


def _gop_keyframe_indices() -> list[int]:
    """把 GOP 设计换算成帧号（0 起）。"""
    idx, acc = [0], 0.0
    for seg in GOP_SECONDS[:-1]:
        acc += seg
        idx.append(round(acc * FPS))
    return idx


def _make_audio_wav(path: str) -> None:
    """合成底噪很轻的提示音 WAV（PCM s16le, 48kHz 单声道）。"""
    sr = 48000
    total = int(sr * DURATION)
    samples = [0.0] * total
    for t0, freq in zip(BEEP_TIMES, BEEP_FREQS):
        start = int(t0 * sr)
        length = int(BEEP_DUR * sr)
        for n in range(length):
            env = math.sin(math.pi * n / length)  # 淡入淡出，避免爆音
            samples[start + n] += 0.55 * env * math.sin(2 * math.pi * freq * n / sr)
    with open(path, "wb") as f:
        data = b"".join(struct.pack("<h", int(max(-1.0, min(1.0, s)) * 32767)) for s in samples)
        f.write(b"RIFF")
        f.write(struct.pack("<I", 36 + len(data)))
        f.write(b"WAVEfmt ")
        f.write(struct.pack("<IHHIIHH", 16, 1, 1, sr, sr * 2, 2, 16))
        f.write(b"data")
        f.write(struct.pack("<I", len(data)))
        f.write(data)


def _encode_video(frame_dir: str, wav_path: str | None, out_path: str, key_indices: list[int]) -> None:
    # ffmpeg 8 的 force_key_frames 表达式对逗号转义处理有变化，
    # 这里统一用最稳的绝对时间戳写法（秒，逗号分隔）
    key_times = ",".join(f"{i / FPS:.3f}" for i in key_indices)
    args = [
        "-framerate", str(FPS), "-i", os.path.join(frame_dir, "frame_%05d.png"),
    ]
    if wav_path:
        args += ["-i", wav_path]
    args += [
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-g", str(N_FRAMES), "-keyint_min", str(N_FRAMES), "-sc_threshold", "0",
        "-force_key_frames", key_times,
        "-movflags", "+faststart",
    ]
    if wav_path:
        args += ["-c:a", "aac", "-b:a", "160k", "-shortest"]
    else:
        args += ["-an"]
    args += [out_path]
    ok, log = run_ffmpeg(args, timeout=300)
    if not ok:
        raise FFmpegError(f"测试素材编码失败: {log}")


def _apply_offset(src_path: str, out_path: str) -> None:
    """把整条素材（音视频一起）延后 1.3s，制造非零轨道起点。"""
    ok, log = run_ffmpeg([
        "-i", src_path, "-c", "copy",
        "-output_ts_offset", f"{OFFSET_SECONDS}",
        "-copyts", "-movflags", "+faststart", out_path,
    ])
    if not ok:
        raise FFmpegError(f"偏移素材生成失败: {log}")


def generate(out_dir: str) -> dict:
    if not shutil.which("ffmpeg"):
        raise FFmpegError("找不到 ffmpeg")
    os.makedirs(out_dir, exist_ok=True)
    key_indices = _gop_keyframe_indices()

    with tempfile.TemporaryDirectory() as td:
        frame_dir = os.path.join(td, "frames")
        os.makedirs(frame_dir)
        _render_frames(frame_dir)
        wav_path = os.path.join(td, "beeps.wav")
        _make_audio_wav(wav_path)

        sound_path = os.path.join(out_dir, "sample_sound.mp4")
        silent_path = os.path.join(out_dir, "sample_silent.mp4")
        _encode_video(frame_dir, wav_path, sound_path, key_indices)
        _encode_video(frame_dir, None, silent_path, key_indices)

    offset_path = os.path.join(out_dir, "sample_offset.mp4")
    _apply_offset(sound_path, offset_path)

    manifest = {
        "fps": FPS,
        "width": WIDTH,
        "height": HEIGHT,
        "duration_seconds": DURATION,
        "nb_frames": N_FRAMES,
        "gop_seconds": GOP_SECONDS,
        "keyframe_indices": key_indices,
        "keyframe_display_times": [round(i / FPS, 3) for i in key_indices],
        "beeps": [{"time": t, "freq_hz": f, "duration": BEEP_DUR}
                  for t, f in zip(BEEP_TIMES, BEEP_FREQS)],
        "offset_sample": {"file": os.path.basename(offset_path), "start_time": OFFSET_SECONDS},
        "files": [os.path.basename(sound_path), os.path.basename(silent_path), os.path.basename(offset_path)],
        "note": "帧号烧录在画面上；快速裁切选在两关键帧之间时，首帧会回退到前一个关键帧",
    }
    with open(os.path.join(out_dir, "sample_manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    return manifest
