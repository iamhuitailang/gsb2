#!/usr/bin/env python3
"""生成演示用多声道 WAV 素材（仅依赖标准库）。

生成到 test_material/ 目录：
  01_六声道_不同测试音.wav  6 声道，每声道不同频率/不同节奏，便于辨认换位
  02_合并削波演示.wav       2 声道，各 0.8 同相同频，等比例合并后峰值 1.6 -> 削波
  03_反相相消演示.wav       2 声道，前 2s 同相、后 2s 反相，合并时前段叠加后段相消
  04_含静音声道.wav         4 声道，第 3 声道为数字静音，演示"留空"与"本身静音"的区别

用法: python3 tools/make_test_material.py [输出目录]
"""
import math
import os
import struct
import sys
import wave

SR = 48000  # 采样率
AMP = 0.5   # 基础幅度


def write_wav(path, channels):
    """channels: list of list[float]，各声道等长，写入 16bit PCM。"""
    n_ch = len(channels)
    n = len(channels[0])
    assert all(len(c) == n for c in channels), "各声道长度不一致"
    frames = bytearray()
    for i in range(n):
        for c in channels:
            v = max(-1.0, min(1.0, c[i]))
            frames += struct.pack("<h", int(round(v * 32767)))
    with wave.open(path, "wb") as w:
        w.setnchannels(n_ch)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(bytes(frames))
    print(f"  {os.path.basename(path)}  {n_ch}ch {n / SR:.1f}s  ->  {path}")


def tone(freq, n, amp=AMP, sr=SR, phase=0.0):
    return [amp * math.sin(2 * math.pi * freq * i / sr + phase) for i in range(n)]


def silence(n):
    return [0.0] * n


def gate(sig, sr=SR, on=0.4, off=0.2, start=0.0):
    """把信号切成 通on秒/断off秒 的脉冲串，start 秒后开始，便于按节奏认声道。"""
    out = []
    period = int((on + off) * sr)
    on_n = int(on * sr)
    start_n = int(start * sr)
    for i, v in enumerate(sig):
        if i < start_n:
            out.append(0.0)
        else:
            out.append(v if (i - start_n) % period < on_n else 0.0)
    return out


def fade(sig, sr=SR, ms=10):
    """首尾加短淡入淡出，避免爆音。"""
    k = int(sr * ms / 1000)
    out = list(sig)
    for i in range(min(k, len(out))):
        out[i] *= i / k
        out[-1 - i] *= i / k
    return out


def demo1_tones(out_dir):
    """6 声道，每声道不同频率 + 不同起始节拍，试听时能立刻分辨谁是谁。"""
    dur = 6.0
    n = int(SR * dur)
    freqs = [220, 277, 330, 440, 554, 659]
    chans = []
    for ch, f in enumerate(freqs):
        sig = tone(f, n, amp=0.5)
        sig = gate(sig, on=0.35, off=0.25, start=ch * 0.6)  # 各声道错开 0.6s 进入
        chans.append(fade(sig))
    write_wav(os.path.join(out_dir, "01_六声道_不同测试音.wav"), chans)


def demo2_merge_clip(out_dir):
    """2 声道同相同频各 0.8，1:1 合并后峰值 1.6，演示削波检测。"""
    n = int(SR * 4.0)
    a = fade(tone(440, n, amp=0.8))
    b = fade(tone(440, n, amp=0.8))
    write_wav(os.path.join(out_dir, "02_合并削波演示.wav"), [a, b])


def demo3_phase_cancel(out_dir):
    """前 2s 两声道同相（合并变响），后 2s 反相（合并相消近静音）。"""
    n2 = int(SR * 2.0)
    t = tone(440, n2, amp=0.6)
    ch0 = fade(t + t)
    ch1 = fade(t + [-v for v in t])  # 后半段反相
    write_wav(os.path.join(out_dir, "03_反相相消演示.wav"), [ch0, ch1])


def demo4_silent_channel(out_dir):
    """4 声道，第 3 声道（索引 2）为纯静音，演示与"留空"的区分。"""
    n = int(SR * 4.0)
    chans = [
        fade(tone(330, n, amp=0.5)),
        fade(tone(440, n, amp=0.5)),
        silence(n),
        fade(tone(550, n, amp=0.5)),
    ]
    write_wav(os.path.join(out_dir, "04_含静音声道.wav"), chans)


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "test_material")
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    print(f"生成测试素材到 {out_dir} (采样率 {SR} Hz, 16bit)")
    demo1_tones(out_dir)
    demo2_merge_clip(out_dir)
    demo3_phase_cancel(out_dir)
    demo4_silent_channel(out_dir)
    print("完成。")


if __name__ == "__main__":
    main()
