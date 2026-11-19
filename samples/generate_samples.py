#!/usr/bin/env python3
"""生成本地测试样音（仅使用 Python 标准库：wave / math / struct）。

输出：
  demo-stereo.wav  44.1kHz 立体声 8s —— 首尾静音、左右声道不同信号（右声道反相）、
                   0.8s 与 6.5s 处各一个 10ms 近满幅短促峰值
  demo-silence.wav 48kHz 单声道 3s —— 全静音边界样例
  demo-mono.wav    22.05kHz 单声道 6s —— 2s 长空白 + 振幅起伏音调 + 尾部短峰值

运行：python3 generate_samples.py
"""
import math
import os
import struct
import wave

HERE = os.path.dirname(os.path.abspath(__file__))


def write_wav(path, channels, sample_rate, bits=16):
    """channels: list[list[float]]，取值 [-1, 1)。"""
    n_frames = len(channels[0])
    for ch in channels:
        assert len(ch) == n_frames, "各声道长度必须一致"
    scale = 2 ** (bits - 1)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(len(channels))
        wf.setsampwidth(bits // 8)
        wf.setframerate(sample_rate)
        frames = bytearray()
        for i in range(n_frames):
            for ch in channels:
                v = max(-1.0, min(1.0, ch[i]))
                frames += struct.pack("<h", int(round(v * (scale - 1))))
        wf.writeframes(bytes(frames))
    print(f"生成 {os.path.relpath(path, HERE)}: {sample_rate}Hz {len(channels)}ch "
          f"{bits}bit {n_frames / sample_rate:.2f}s")


def add_tone(buf, start, end, sr, freq, amp=0.4, phase=0.0, lfo_hz=0.0, lfo_depth=0.0):
    """向 buf（单声道 list）写入带 20ms 首尾包络、可选振幅调制的正弦波。"""
    i0, i1 = int(start * sr), int(end * sr)
    ramp = int(0.02 * sr)
    for i in range(i0, min(i1, len(buf))):
        t = (i - i0) / sr
        env = 1.0
        if i - i0 < ramp:
            env = (i - i0) / ramp
        elif i1 - i < ramp:
            env = (i1 - i) / ramp
        mod = 1.0
        if lfo_hz:
            mod = 1.0 - lfo_depth * (0.5 + 0.5 * math.sin(2 * math.pi * lfo_hz * t))
        buf[i] += amp * env * mod * math.sin(2 * math.pi * freq * t + phase)


def add_impulse(buf, at, sr, amp=0.97, width_ms=10):
    """10ms 短促峰值：半周期正弦脉冲，模拟录音里的爆音/打点。"""
    i0 = int(at * sr)
    n = int(sr * width_ms / 1000)
    for k in range(n):
        idx = i0 + k
        if 0 <= idx < len(buf):
            buf[idx] += amp * math.sin(math.pi * k / n)


def gen_stereo():
    sr, dur = 44100, 8.0
    n = int(sr * dur)
    left = [0.0] * n
    right = [0.0] * n

    # 第一段：L=440Hz，R=330Hz 反相，方便在编辑器里分别查看左右声道
    add_tone(left, 1.0, 3.5, sr, 440, amp=0.42)
    add_tone(right, 1.0, 3.5, sr, 330, amp=0.42, phase=math.pi)

    # 中段留 1s 纯静音（3.5–4.5s）

    # 第二段：L=523Hz，R=392Hz，带振幅调制，模拟自然起伏
    add_tone(left, 4.5, 7.0, sr, 523, amp=0.38, lfo_hz=3.5, lfo_depth=0.55)
    add_tone(right, 4.5, 7.0, sr, 392, amp=0.38, lfo_hz=2.2, lfo_depth=0.45)

    # 短促峰值：开头静音里的爆音（左声道）、第二段中的打点（右声道）
    add_impulse(left, 0.8, sr, amp=0.97)
    add_impulse(right, 6.5, sr, amp=0.95)

    write_wav(os.path.join(HERE, "demo-stereo.wav"), [left, right], sr)


def gen_silence():
    sr, dur = 48000, 3.0
    n = int(sr * dur)
    write_wav(os.path.join(HERE, "demo-silence.wav"), [[0.0] * n], sr)


def gen_mono():
    sr, dur = 22050, 6.0
    n = int(sr * dur)
    buf = [0.0] * n

    # 前 2s 纯静音；2–5s 带起伏的 300Hz 基音 + 少量二次谐波
    add_tone(buf, 2.0, 5.0, sr, 300, amp=0.4, lfo_hz=2.0, lfo_depth=0.5)
    i0, i1 = int(2.0 * sr), int(5.0 * sr)
    ramp = int(0.02 * sr)
    for i in range(i0, i1):
        env = 1.0
        if i - i0 < ramp:
            env = (i - i0) / ramp
        elif i1 - i < ramp:
            env = (i1 - i) / ramp
        t = (i - i0) / sr
        buf[i] += 0.12 * env * math.sin(2 * math.pi * 600 * t)

    # 5.6s 处一个短峰值，之后回到静音
    add_impulse(buf, 5.6, sr, amp=0.95)

    write_wav(os.path.join(HERE, "demo-mono.wav"), [buf], sr)


if __name__ == "__main__":
    gen_stereo()
    gen_silence()
    gen_mono()
    print("全部样音生成完毕，目录：", HERE)
