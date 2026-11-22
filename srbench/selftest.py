"""确定性自检：不依赖 GUI，数值化验证全部关键性质。

运行：python -m srbench.cli selftest
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np

from . import QUALITY_HIGH, QUALITY_LOW
from .analysis import (
    check_lengths,
    check_peak_alignment,
    dominant_frequency,
    fold_frequency,
    map_selection_to_output,
)
from .resample import output_length, ratio_parts, resample
from .signals import (
    impulse,
    log_chirp,
    sine_tone,
    stereo_dual_tone,
    stereo_staggered_impulse,
    white_noise,
)
from .wavio import probe_wav, read_wav, write_wav

_passed: list[str] = []
_failed: list[tuple[str, str]] = []


def _check(name: str, cond: bool, detail: str = "") -> bool:
    if cond:
        _passed.append(name)
        print(f"  [PASS] {name} {detail}")
    else:
        _failed.append((name, detail))
        print(f"  [FAIL] {name} {detail}")
    return cond


def test_length_rule() -> None:
    print("\n[1] 片尾取整规则 ceil(n*up/down)，两条路径一致")
    src = impulse(sample_rate=48000, duration=0.01)  # 480 点
    for dst in (8000, 22050, 44100, 96000):
        up, down = ratio_parts(48000, dst)
        expect = output_length(src.n_frames, up, down)
        low = resample(src, dst, QUALITY_LOW)
        high = resample(src, dst, QUALITY_HIGH)
        rep = check_lengths(src, low.audio, high.audio)
        _check(
            f"48k->{dst} 长度一致且符合规则",
            rep.low_ok and rep.high_ok and low.audio.n_frames == high.audio.n_frames == expect,
            f"期望 {expect}，低 {low.audio.n_frames}，高 {high.audio.n_frames}",
        )
        # 时长误差严格小于一个输出采样间隔
        _check(
            f"48k->{dst} 时长误差 < 1 输出采样",
            rep.duration_error_seconds < 1.0 / dst + 1e-12,
            f"误差 {rep.duration_error_seconds:.3e}s",
        )


def test_peak_alignment() -> None:
    print("\n[2] 左右声道峰值不错位")
    src = stereo_staggered_impulse(sample_rate=48000, duration=0.05)
    for dst in (22050, 44100, 96000):
        low = resample(src, dst, QUALITY_LOW)
        high = resample(src, dst, QUALITY_HIGH)
        rep = check_peak_alignment(src, low.audio, high.audio)
        _check(f"48k->{dst} 低质量左右峰同采样", rep.low_aligned,
               f"偏移 {rep.low_peak_offset_samples}")
        _check(f"48k->{dst} 高质量左右峰同采样", rep.high_aligned,
               f"偏移 {rep.high_peak_offset_samples}")

    # 人为错开的脉冲：在目标率足够高时应保持相对偏移；
    # 2:1 下采样到 24k 时，晚 1 个源采样的脉冲恰好落在输出采样间隙，
    # 线性插值会把它丢掉——这是低质量路径的物理局限，也要稳定复现。
    shifted = stereo_staggered_impulse(sample_rate=48000, duration=0.05,
                                       left_at=0.01, right_at=0.01 + 1 / 48000)
    low24 = resample(shifted, 24000, QUALITY_LOW)
    r_peak_24 = float(np.max(np.abs(low24.audio.channel(1))))
    _check("2:1 下采样稳定复现间隙脉冲丢失（低质量局限）", r_peak_24 < 1e-12,
           f"R 峰残留 {r_peak_24:.2e}（期望 0）")
    high24 = resample(shifted, 24000, QUALITY_HIGH)
    r_peak_24h = float(np.max(np.abs(high24.audio.channel(1))))
    _check("高质量 FIR 保留间隙脉冲（滤波器有跨采样支撑）", r_peak_24h > 0.05,
           f"R 峰 {r_peak_24h:.3f}")
    low44 = resample(shifted, 44100, QUALITY_LOW)
    lp_l = np.argmax(np.abs(low44.audio.channel(0)))
    lp_r = np.argmax(np.abs(low44.audio.channel(1)))
    # 44.1k 下一个源采样对应 ~0.92 输出采样，错开应可辨认（R 峰不早于 L 峰）
    _check("44.1k 下错开 1 源采样的脉冲保持可辨认偏移", lp_r >= lp_l,
           f"L@{lp_l} R@{lp_r}")


def test_aliasing() -> None:
    print("\n[3] 高频下采样：低质量产生假低音，高质量抑制")
    # 18kHz @48k -> 22050，Nyquist=11025，18k 折叠到 2*11025-18000=4050Hz
    src = sine_tone(18000.0, sample_rate=48000, duration=1.0)
    dst = 22050
    expected_fold = fold_frequency(18000.0, dst / 2)
    _check("折叠频率计算正确", abs(expected_fold - 4050.0) < 1e-9, f"fold={expected_fold}")

    low = resample(src, dst, QUALITY_LOW)
    high = resample(src, dst, QUALITY_HIGH)
    f_low, db_low = dominant_frequency(low.audio.channel(0), dst)
    f_high, db_high = dominant_frequency(high.audio.channel(0), dst)
    _check("低质量主峰落在假低音 4050Hz 附近", abs(f_low - 4050.0) < dst / low.audio.n_frames * 2 + 5,
           f"f={f_low:.1f}Hz ({db_low:.1f}dBFS)")
    # 高质量路径主峰应被显著压低（18k 部分进入过渡带，阈值取 35dB 留余量）
    _check("高质量路径假低音被抑制 >=35dB", db_high <= db_low - 35,
           f"低 {db_low:.1f}dBFS vs 高 {db_high:.1f}dBFS（差值 {db_low - db_high:.1f}dB）")

    # 直接比较同一折叠频率 bin 上两条路径的幅度（同长度同 FFT，口径一致）
    n = low.audio.n_frames
    nfft = 1 << int(np.ceil(np.log2(max(8, n))))
    spec_low = np.abs(np.fft.rfft(low.audio.channel(0) * np.hanning(n), nfft))
    spec_high = np.abs(np.fft.rfft(high.audio.channel(0) * np.hanning(n), nfft))
    freqs = np.fft.rfftfreq(nfft, d=1.0 / dst)
    fold_bin = int(np.argmin(np.abs(freqs - expected_fold)))
    alias_low_db = 20 * np.log10(spec_low[fold_bin] / (np.sum(np.hanning(n)) / 2) + 1e-12)
    alias_high_db = 20 * np.log10(spec_high[fold_bin] / (np.sum(np.hanning(n)) / 2) + 1e-12)
    _check("混叠折叠 bin：高质量比低质量低 >=35dB", alias_high_db <= alias_low_db - 35,
           f"低 {alias_low_db:.1f}dB vs 高 {alias_high_db:.1f}dB @ {freqs[fold_bin]:.0f}Hz")


def test_upsampling() -> None:
    print("\n[4] 上采样不产生新频率，两条路径主峰都保持原频率")
    src = sine_tone(3000.0, sample_rate=22050, duration=0.5)
    low = resample(src, 48000, QUALITY_LOW)
    high = resample(src, 48000, QUALITY_HIGH)
    f_low, _ = dominant_frequency(low.audio.channel(0), 48000)
    f_high, _ = dominant_frequency(high.audio.channel(0), 48000)
    _check("上采样后低质量主峰仍为 3kHz", abs(f_low - 3000) < 10, f"f={f_low:.1f}")
    _check("上采样后高质量主峰仍为 3kHz", abs(f_high - 3000) < 10, f"f={f_high:.1f}")


def test_wav_roundtrip() -> None:
    print("\n[5] WAV 各格式往返读写 + 头部核对")
    src = stereo_dual_tone(sample_rate=44100, duration=0.2)
    cases = [
        ("PCM", 16, False), ("PCM", 24, False), ("PCM", 32, False),
        ("FLOAT", 32, False), ("PCM", 16, True),
    ]
    with tempfile.TemporaryDirectory() as td:
        for fmt, bits, ext in cases:
            p = Path(td) / f"rt_{fmt}_{bits}_{ext}.wav"
            write_wav(p, src, bits=bits, sample_format=fmt, extensible=ext)
            info = probe_wav(p)
            back = read_wav(p)
            hdr_ok = (info["sample_rate"] == 44100 and info["channels"] == 2
                      and info["sample_format"] == fmt and info["bits_per_sample"] == bits
                      and info["frames_by_header"] == src.n_frames)
            _check(f"{fmt}/{bits}/ext={ext} 头部正确", hdr_ok,
                   f"{info['sample_rate']}Hz {info['channels']}ch {info['sample_format']}")
            if fmt == "PCM":
                qstep = 2.0 / 2 ** bits
                err = np.max(np.abs(back.samples - src.samples))
                _check(f"{fmt}/{bits} 量化误差 <= 1 级", err <= qstep * 1.01, f"err={err:.2e}")
            else:
                err = np.max(np.abs(back.samples - src.samples))
                _check(f"{fmt}/{bits} 近乎无损", err < 1e-6, f"err={err:.2e}")
            _check(f"{fmt}/{bits} 帧数/声道一致",
                   back.n_frames == src.n_frames and back.channels == 2,
                   f"{back.n_frames} 帧 {back.channels} 声道")


def test_selection_mapping() -> None:
    print("\n[6] 框选区间映射：输出采样位置与源位置一一对应")
    sr, dst = 48000, 22050
    up, down = ratio_parts(sr, dst)
    i0, i1 = 1000, 1048  # 1ms 片段
    o0, o1, src_pos = map_selection_to_output(i0, i1, sr, dst)
    # 映射单调、边界包含关系正确
    mono = np.all(np.diff(src_pos) > 0)
    cover = src_pos[0] >= i0 - 1 and src_pos[-1] <= i1
    _check("映射单调且落在源框选范围内", mono and cover,
           f"输出 [{o0},{o1})，源位置 {src_pos[0]:.2f}..{src_pos[-1]:.2f}")
    _check("输出区间长度符合 ceil 规则", o1 - o0 == output_length(i1 - i0, up, down),
           f"{o1 - o0} vs {output_length(i1 - i0, up, down)}")


def test_presets_deterministic() -> None:
    print("\n[7] 测试信号可复现")
    a = white_noise(seed=14765)
    b = white_noise(seed=14765)
    _check("同种子白噪声逐采样一致", np.array_equal(a.samples, b.samples))
    c = sine_tone(18000.0, sample_rate=48000, duration=1.0)
    d = sine_tone(18000.0, sample_rate=48000, duration=1.0)
    _check("正弦生成确定", np.array_equal(c.samples, d.samples))
    _check("扫频可生成且有限", np.all(np.isfinite(log_chirp().samples)))


def test_chirp_alias_visual() -> None:
    print("\n[8] 扫频下采样：低质量在全频段出现镜像折叠，高质量无折叠")
    src = log_chirp(20, 20000, sample_rate=48000, duration=2.0)
    dst = 24000  # Nyquist 12k
    low = resample(src, dst, QUALITY_LOW)
    high = resample(src, dst, QUALITY_HIGH)
    # 对数扫频高频集中在末尾；取最后 0.2 秒（瞬时频率已远高于 12k Nyquist），
    # 整个 0-11.5k 带内对高质量都应是阻带，低质量则充满镜像折叠。
    n = int(0.2 * dst)
    seg_l = low.audio.channel(0)[-n:]
    seg_h = high.audio.channel(0)[-n:]
    freqs = np.fft.rfftfreq(n, d=1.0 / dst)
    band = freqs <= 11500
    e_l = np.mean(np.abs(np.fft.rfft(seg_l * np.hanning(n)))[band] ** 2)
    e_h = np.mean(np.abs(np.fft.rfft(seg_h * np.hanning(n)))[band] ** 2)
    _check("末尾 0.2s 折叠带：高质量比低质量低 20dB 以上",
           10 * np.log10(e_h + 1e-20) <= 10 * np.log10(e_l + 1e-20) - 20,
           f"低 {10*np.log10(e_l+1e-20):.1f}dB vs 高 {10*np.log10(e_h+1e-20):.1f}dB")


def run_all(verbose: bool = True) -> bool:
    _passed.clear()
    _failed.clear()
    print("=" * 60)
    print("srbench 确定性自检")
    print("=" * 60)
    for fn in (
        test_length_rule,
        test_peak_alignment,
        test_aliasing,
        test_upsampling,
        test_wav_roundtrip,
        test_selection_mapping,
        test_presets_deterministic,
        test_chirp_alias_visual,
    ):
        fn()
    print("\n" + "=" * 60)
    print(f"通过 {len(_passed)} 项，失败 {len(_failed)} 项")
    if _failed:
        for name, detail in _failed:
            print(f"  FAIL: {name} {detail}")
    return not _failed
