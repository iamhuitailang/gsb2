#!/usr/bin/env python3
"""生成分析页面附带的三个样音（16-bit 立体声 WAV，44.1 kHz）。

仅使用标准库。输出到仓库 samples/ 目录：
  sample_lowfreq.wav  低频：30→200 Hz 扫频 + 50 Hz 底鼓式脉冲
  sample_tone.wav     纯音：1 kHz 正弦，带轻微幅度变化便于观察峰值保持
  sample_stereo.wav   左右声道差异：左 440 Hz / 右 554 Hz，且右声道有一段缺失
"""

import math
import os
import struct
import wave

SR = 44100
DURATION = 8.0
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "samples")

AMP = 0.7


def write_wav(name, left, right):
    path = os.path.join(OUT_DIR, name)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        frames = bytearray()
        for l, r in zip(left, right):
            frames += struct.pack("<hh", int(l * 32767), int(r * 32767))
        w.writeframes(bytes(frames))
    print(f"wrote {path} ({len(left) / SR:.1f}s)")


def gen_lowfreq():
    n = int(SR * DURATION)
    left, right = [], []
    phase = 0.0
    for i in range(n):
        t = i / SR
        # 30 -> 200 Hz 指数扫频
        f = 30.0 * (200.0 / 30.0) ** (t / DURATION)
        phase += 2 * math.pi * f / SR
        v = AMP * math.sin(phase)
        # 每秒一个 50 Hz 衰减脉冲，模拟底鼓
        tt = t % 1.0
        if tt < 0.25:
            v += 0.5 * math.sin(2 * math.pi * 50 * tt) * math.exp(-tt * 20)
        v = max(-1.0, min(1.0, v))
        left.append(v)
        right.append(v)
    return left, right


def gen_tone():
    n = int(SR * DURATION)
    left, right = [], []
    for i in range(n):
        t = i / SR
        # 1 kHz 纯音，幅度在 0.4~0.7 间缓慢变化，便于观察峰值保持
        env = 0.55 + 0.15 * math.sin(2 * math.pi * 0.5 * t)
        v = env * math.sin(2 * math.pi * 1000 * t)
        left.append(v)
        right.append(v)
    return left, right


def gen_stereo():
    n = int(SR * DURATION)
    left, right = [], []
    for i in range(n):
        t = i / SR
        l = 0.6 * math.sin(2 * math.pi * 440 * t)          # 左：440 Hz
        r = 0.6 * math.sin(2 * math.pi * 554.37 * t)       # 右：升 C#，554 Hz
        if 3.0 <= t < 5.0:                                  # 中段右声道缺失
            r = 0.0
        if 6.0 <= t < 6.5:                                  # 右声道一段高频噪声感（6 kHz）
            r += 0.3 * math.sin(2 * math.pi * 6000 * t)
        left.append(l)
        right.append(r)
    return left, right


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    write_wav("sample_lowfreq.wav", *gen_lowfreq())
    write_wav("sample_tone.wav", *gen_tone())
    write_wav("sample_stereo.wav", *gen_stereo())


if __name__ == "__main__":
    main()
