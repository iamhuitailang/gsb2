#!/usr/bin/env python3
"""生成多设备同期录音的样音（仅使用 Python 标准库）。

生成公共事件时间轴，再为每台“设备”施加：
  - 开头静音长度不同（startSilenceSec）
  - 起始偏移不同（startOffsetSec，决定设备晚录/早录）
  - 轻微速度差（rate，相对参考时钟，1+ppm*1e-6）
  - 不同采样率与声道数、独立底噪
输出 16-bit PCM WAV 与 manifest.json（含真值，便于核对对齐结果）。

用法：python3 tools/generate_samples.py [输出目录，默认 public/samples]
"""
import json
import math
import os
import random
import struct
import sys
import wave

SR_REF = 48000
DURATION = 60.0  # 公共事件轴时长（秒）
RNG = random.Random(20241126)


def build_event_timeline():
    """公共事件：周期性敲击声 + 说话样的扫频段 + 两个瞬态标记点。"""
    events = []
    # 每 4 秒一个指数衰减敲击（模拟打板/鼓点）。
    t = 2.0
    while t < DURATION - 1:
        freq = RNG.choice([220.0, 330.0, 440.0, 550.0])
        events.append(("hit", round(t, 4), freq))
        t += 4.0
    # 三段扫频（模拟有音高内容）。
    for start in (10.0, 26.0, 44.0):
        events.append(("sweep", start, start + 3.0))
    # 两个突出的瞬态标记（对齐锚点用）。
    events.append(("mark", 8.0, 880.0))
    events.append(("mark", 40.0, 990.0))
    return events


def render_source(events, sr, duration, channels, noise_level):
    """渲染“真实世界”声源信号（工程时间坐标）。"""
    n = int(duration * sr)
    mono = [0.0] * n

    def add(idx, v):
        if 0 <= idx < n:
            mono[idx] += v

    for ev in events:
        if ev[0] == "hit":
            _, t0, freq = ev
            length = int(0.35 * sr)
            base = int(t0 * sr)
            for k in range(length):
                env = math.exp(-k / (0.08 * sr))
                v = 0.55 * env * math.sin(2 * math.pi * freq * k / sr)
                add(base + k, v)
        elif ev[0] == "mark":
            _, t0, freq = ev
            length = int(0.5 * sr)
            base = int(t0 * sr)
            for k in range(length):
                env = math.exp(-k / (0.12 * sr))
                v = 0.8 * env * math.sin(2 * math.pi * freq * k / sr)
                add(base + k, v)
        elif ev[0] == "sweep":
            _, t0, t1 = ev
            base = int(t0 * sr)
            length = int((t1 - t0) * sr)
            for k in range(length):
                f = 180.0 + 520.0 * (k / length)
                v = 0.35 * math.sin(2 * math.pi * f * k / sr)
                # 缓慢包络，避免起止爆音。
                env = min(1.0, k / (0.05 * sr), (length - k) / (0.05 * sr))
                add(base + k, v * max(0.0, env))

    # 独立底噪（每台设备不同种子在调用处处理，这里直接用全局 RNG）。
    for i in range(n):
        mono[i] += noise_level * (RNG.random() * 2 - 1)

    if channels == 1:
        return [mono]
    # 立体声：轻微左右差，体现声道预览功能。
    left = mono[:]
    right = mono[:]
    for i in range(n):
        wobble = 0.05 * math.sin(2 * math.pi * 0.5 * i / sr)
        left[i] = mono[i] * (1 + wobble) + noise_level * 0.5 * (RNG.random() * 2 - 1)
        right[i] = mono[i] * (1 - wobble) + noise_level * 0.5 * (RNG.random() * 2 - 1)
    return [left, right]


def make_recording(source_sr, channels_data, cfg):
    """按设备配置施加时钟速度、起始偏移、开头静音与重采样。"""
    rate = cfg["rate"]
    src_sr = source_sr
    dev_sr = cfg["sampleRate"]
    # 设备采样轴上的时长：源时长按 rate 伸缩，再加开头静音与偏移。
    lead = cfg["startSilenceSec"] + cfg["startOffsetSec"]
    total_src_sec = DURATION * rate
    total_dev_sec = lead + total_src_sec + 1.0
    n_dev = int(total_dev_sec * dev_sr)
    out = [[0.0] * n_dev for _ in range(len(channels_data))]

    lead_frames = int(lead * dev_sr)
    for i in range(n_dev - lead_frames):
        # 设备采样 -> 源时间（秒，源坐标）。
        src_time = i / dev_sr / rate
        src_idx = src_time * src_sr
        i0 = int(math.floor(src_idx))
        frac = src_idx - i0
        for c, data in enumerate(channels_data):
            if i0 + 1 < len(data):
                v = data[i0] * (1 - frac) + data[i0 + 1] * frac
            elif i0 < len(data):
                v = data[i0]
            else:
                v = 0.0
            out[c][lead_frames + i] = v
    return out, lead, total_dev_sec


def write_wav(path, channels, sr):
    with wave.open(path, "wb") as w:
        w.setnchannels(len(channels))
        w.setsampwidth(2)
        w.setframerate(sr)
        n = min(len(c) for c in channels)
        frames = bytearray()
        for i in range(n):
            for c in channels:
                v = max(-1.0, min(1.0, c[i]))
                frames += struct.pack("<h", int(v * 32767) if v >= 0 else int(v * 32768))
        w.writeframes(frames)


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "samples")
    os.makedirs(out_dir, exist_ok=True)

    events = build_event_timeline()
    # 声源在最高采样率下渲染一次，各设备再自行重采样。
    source = render_source(events, SR_REF, DURATION + 1.0, channels=2, noise_level=0.004)

    configs = [
        # 参考设备：基准时钟、立体声、48k
        dict(file="recorder_A_ref.wav", sampleRate=48000, channels=2,
             startSilenceSec=0.5, startOffsetSec=0.0, rate=1.0, noise=0.003),
        # 设备 B：晚 1.2 秒开始，开头 2 秒静音，时钟快 350 ppm
        dict(file="recorder_B_late_fast.wav", sampleRate=48000, channels=2,
             startSilenceSec=2.0, startOffsetSec=1.2, rate=1.0 + 350e-6, noise=0.005),
        # 设备 C：早 0.8 秒（负偏移），单声道、44.1k，时钟慢 220 ppm
        dict(file="recorder_C_early_slow.wav", sampleRate=44100, channels=1,
             startSilenceSec=1.0, startOffsetSec=-0.8, rate=1.0 - 220e-6, noise=0.006),
        # 设备 D：晚 0.45 秒，长静音 3.5 秒，立体声、44.1k，轻微快 90 ppm
        dict(file="recorder_D_gap.wav", sampleRate=44100, channels=2,
             startSilenceSec=3.5, startOffsetSec=0.45, rate=1.0 + 90e-6, noise=0.004),
    ]

    manifest = {
        "description": "多设备同期录音样音真值清单（用于核对对齐结果）",
        "sourceSampleRate": SR_REF,
        "eventCount": len(events),
        "events": events,
        "convention": "设备文件中第 leadSec 秒起对应工程时间 0；rate!=1 表示设备时钟相对参考的快慢",
        "recorders": [],
    }

    for cfg in configs:
        # 按目标采样率重采样声源（线性插值足够示例用途）。
        n_src = int((DURATION + 1.0) * SR_REF)
        n_new = int((DURATION + 1.0) * cfg["sampleRate"])
        resampled = []
        for ch_data in source:
            buf = [0.0] * n_new
            for i in range(n_new):
                src_idx = i * SR_REF / cfg["sampleRate"]
                i0 = int(math.floor(src_idx))
                frac = src_idx - i0
                buf[i] = (ch_data[i0] * (1 - frac) + ch_data[min(i0 + 1, n_src - 1)] * frac)
            resampled.append(buf)
        if cfg["channels"] == 1:
            # 单声道取左右平均。
            mono = [(resampled[0][i] + resampled[1][i]) / 2 for i in range(n_new)]
            resampled = [mono]

        rec, lead, total_sec = make_recording(cfg["sampleRate"], resampled, cfg)
        path = os.path.join(out_dir, cfg["file"])
        write_wav(path, rec, cfg["sampleRate"])

        manifest["recorders"].append({
            "file": cfg["file"],
            "sampleRate": cfg["sampleRate"],
            "channels": cfg["channels"],
            "startSilenceSec": cfg["startSilenceSec"],
            "startOffsetSec": cfg["startOffsetSec"],
            "leadSec": round(lead, 6),
            "clockRate": cfg["rate"],
            "driftPpm": round((cfg["rate"] - 1) * 1e6, 3),
            "durationSec": round(total_sec, 4),
            "noiseLevel": cfg["noise"],
            "expectedMapping": "sourceSec = leadSec + projectSec * clockRate",
        })
        print(f"wrote {path}  ({cfg['channels']}ch, {cfg['sampleRate']} Hz, {total_sec:.2f} s)")

    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"wrote {os.path.join(out_dir, 'manifest.json')}")


if __name__ == "__main__":
    main()
