#!/usr/bin/env python3
"""生成响度/峰值差异明显的样音到 samples/ 目录。

每个样音生成后用 ffmpeg ebur128 实测整体响度，再缩放到目标响度，
保证样音的响度差异符合预期。需要 numpy、soundfile 和 ffmpeg。
"""

import os
import subprocess

import numpy as np
import soundfile as sf

SR = 48000
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "samples")
rng = np.random.default_rng(20231122)


def speech_like(duration, sr=SR):
    """类语音信号：带通噪声 + 音节包络（模拟播客/对白）。"""
    n = int(duration * sr)
    t = np.arange(n) / sr
    # 基频附近共振 + 噪声，模拟人声粗糙质感
    sig = np.zeros(n)
    f0 = 110 + 40 * np.sin(2 * np.pi * 0.3 * t)
    for mult, amp in ((1, 1.0), (2, 0.5), (3, 0.3), (4, 0.15)):
        sig += amp * np.sin(2 * np.pi * np.cumsum(f0 * mult) / sr)
    sig += 0.4 * rng.standard_normal(n)
    # 简单带通（300Hz-3kHz 附近）：一阶高低通
    sig = np.convolve(sig, np.ones(8) / 8, mode="same")          # 低通
    sig = np.concatenate([[0], np.diff(sig)])                    # 高通近似
    # 音节包络：150-350ms 的随机突发 + 停顿
    env = np.zeros(n)
    pos = 0
    while pos < n:
        burst = int(rng.uniform(0.15, 0.35) * sr)
        gap = int(rng.uniform(0.03, 0.15) * sr)
        end = min(pos + burst, n)
        env[pos:end] = rng.uniform(0.4, 1.0) * np.sin(np.pi * np.arange(end - pos) / (end - pos))
        pos = end + gap
    return sig * env


def music_like(duration, sr=SR):
    """类音乐信号：多声部和弦 + 节拍。"""
    n = int(duration * sr)
    t = np.arange(n) / sr
    sig = np.zeros(n)
    for f in (220, 277.2, 329.6, 440):
        sig += 0.25 * np.sin(2 * np.pi * f * t) * (1 + 0.3 * np.sin(2 * np.pi * 0.5 * t))
    beat = (np.sin(2 * np.pi * 2 * t) > 0.6).astype(float)       # 简单节拍
    sig += 0.3 * beat * rng.standard_normal(n) * np.exp(-(t % 0.5) * 20)
    return sig


def normalize_to(target_lufs, data, sr, name):
    """实测整体响度并缩放到目标 LUFS。"""
    tmp = os.path.join(OUT, ".tmp_measure.wav")
    sf.write(tmp, data, sr)
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", tmp,
         "-af", "ebur128=peak=true", "-f", "null", "-"],
        capture_output=True, text=True).stderr
    import re
    integrated = float(re.findall(r"I:\s+(-?[\d.]+)\s+LUFS", out)[-1])
    gain_db = target_lufs - integrated
    scaled = data * (10 ** (gain_db / 20))
    peak = np.max(np.abs(scaled))
    if peak > 0.98:  # 防止缩放后溢出
        scaled *= 0.98 / peak
    os.remove(tmp)
    print(f"  {name}: 目标 {target_lufs:+.1f} LUFS (实测 {integrated:+.1f}, "
          f"增益 {gain_db:+.1f} dB, 采样峰值 {np.max(np.abs(scaled)):.3f})")
    return scaled


def main():
    os.makedirs(OUT, exist_ok=True)

    print("生成样音:")
    # 1. 正常音量的播客对白（立体声）≈ -16 LUFS
    voice = speech_like(12)
    stereo = np.column_stack([voice, np.roll(voice, 400) * 0.9])
    sf.write(os.path.join(OUT, "podcast_ep01_voice.wav"),
             normalize_to(-16.0, stereo, SR, "podcast_ep01_voice.wav"), SR, "PCM_24")

    # 2. 偏响的片头音乐 ≈ -9 LUFS
    sf.write(os.path.join(OUT, "podcast_intro_music_loud.wav"),
             normalize_to(-9.0, music_like(8), SR, "podcast_intro_music_loud.wav"),
             SR, "PCM_24")

    # 3. 偏轻的对白 ≈ -28 LUFS
    sf.write(os.path.join(OUT, "podcast_ep02_voice_quiet.wav"),
             normalize_to(-28.0, speech_like(10), SR, "podcast_ep02_voice_quiet.wav"),
             SR, "PCM_24")

    # 4. 响度中等但峰值顶到 0 dBFS 的游戏对白（校正时必然削波预警）
    n = 6 * SR
    t = np.arange(n) / SR
    base = 0.05 * speech_like(6)
    for pos in (1.0, 2.5, 4.2):  # 叠加高瞬态
        i = int(pos * SR)
        base[i:i + 200] += 0.99 * np.sin(2 * np.pi * 1800 * t[:200]) * np.exp(-t[:200] * 60)
    sf.write(os.path.join(OUT, "game_dialogue_hot_peaks.wav"),
             np.clip(base, -1, 1), SR, "PCM_24")
    print("  game_dialogue_hot_peaks.wav: 中等响度 + 近 0 dBFS 瞬态峰值")

    # 5. 左右声道不平衡的游戏音效（立体声）≈ -13 LUFS
    sfx_l = music_like(5) * 1.0
    sfx_r = np.roll(music_like(5), 1200) * 0.4
    sf.write(os.path.join(OUT, "game_sfx_stereo_unbalanced.wav"),
             normalize_to(-13.0, np.column_stack([sfx_l, sfx_r]), SR,
                          "game_sfx_stereo_unbalanced.wav"), SR, "PCM_24")

    # 6. 纯静音 3 秒（验证不会被误算成正常响度）
    sf.write(os.path.join(OUT, "silence_3s.wav"), np.zeros((3 * SR, 2)), SR, "PCM_24")
    print("  silence_3s.wav: 纯静音")

    # 7. 0.2 秒短提示音（验证短音频走 RMS 估计路径）
    n = int(0.2 * SR)
    beep = 0.5 * np.sin(2 * np.pi * 880 * np.arange(n) / SR)
    sf.write(os.path.join(OUT, "short_beep_0.2s.wav"), beep, SR, "PCM_24")
    print("  short_beep_0.2s.wav: 0.2s 短音频")

    print(f"\n样音已生成到 {OUT}/")


if __name__ == "__main__":
    main()
