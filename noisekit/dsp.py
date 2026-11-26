"""核心数字信号处理: STFT、谱减降噪、噪声样本分析。

只用 numpy 实现, 不依赖 scipy。

降噪算法 (谱减法 + 增益平滑 + 瞬态/语音保护):
1. 对用户选取的噪声样本做 STFT, 逐频点估计平均幅度作为噪声轮廓 N(f);
2. 对整段录音逐帧计算幅度谱, 过减 alpha 控制处理强度:
       g = max( sqrt(max(|S|^2 - alpha*N^2, 0)) / |S|, 增益下限 )
3. 增益在时间轴做一阶平滑(释放慢、起音快), 抑制 "音乐噪声";
4. 检测到瞬态帧(能量骤升, 如敲击)与语音样帧(低谱平坦度)时降低衰减量,
   尽量保留语音和短促音。
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

EPS = 1e-12
GAIN_FLOOR = 10.0 ** (-50.0 / 20.0)  # -50 dB, 避免彻底挖空产生音乐噪声
DB_FLOOR = -100.0


# --------------------------------------------------------------------------- #
# 窗口尺寸
# --------------------------------------------------------------------------- #
def choose_n_fft(sr: int) -> int:
    """按采样率选约 40 ms 的 2 的幂窗口, 限制在 1024~4096。"""
    n = 2 ** int(math.ceil(math.log2(sr * 0.04)))
    return int(np.clip(n, 1024, 4096))


# --------------------------------------------------------------------------- #
# STFT / ISTFT (Hann 窗, 50% 重叠, 归一化重叠相加, 可完美重构)
# --------------------------------------------------------------------------- #
def _frame_signal(x: np.ndarray, n_frames: int, n_fft: int, hop: int) -> np.ndarray:
    """按 STFT 帧网格切出长度足够的信号, 末尾反射填充。"""
    need = (n_frames - 1) * hop + n_fft
    if need > len(x):
        pad = need - len(x)
        if len(x) > pad:
            return np.concatenate([x, x[: -pad - 1 : -1]])
        return np.pad(x, (0, pad))
    return x


def _count_frames(length: int, n_fft: int, hop: int) -> int:
    """覆盖整个信号所需的帧数 (最后一帧可超出长度, 由填充补齐)。"""
    if length < n_fft:
        return 1
    return 1 + int(np.ceil((length - n_fft) / hop))


def stft(x: np.ndarray, n_fft: int, hop: int) -> np.ndarray:
    """一维信号 -> 复数谱 (frames, n_fft//2+1)。

    帧网格固定从样本 0 开始, 帧数覆盖整个信号; 末尾不足一窗时反射填充,
    避免零填充在边界产生不连续。内部帧不受填充影响, 可完美重构。
    """
    if x.ndim != 1:
        raise ValueError("stft 只接受一维信号")
    window = np.hanning(n_fft)
    n_frames = _count_frames(len(x), n_fft, hop)
    padded = _frame_signal(x, n_frames, n_fft, hop)
    frames = np.stack(
        [padded[i * hop : i * hop + n_fft] * window for i in range(n_frames)]
    )
    return np.fft.rfft(frames, n=n_fft, axis=1)


def istft(spec: np.ndarray, n_fft: int, hop: int, length: int) -> np.ndarray:
    """复数谱 -> 一维信号, 按窗平方和归一化, 截断/补齐到 length。

    Hann 窗 50% 重叠时内部帧窗平方和恒为 0.375, 边界帧覆盖不足处按实际窗和
    归一化, 因此内部帧可完美重构, 边界仅受零填充影响。
    """
    window = np.hanning(n_fft)
    n_frames = spec.shape[0]
    if n_frames == 0:
        return np.zeros(length, dtype=np.float64)
    out_len = max(length, (n_frames - 1) * hop + n_fft)
    y = np.zeros(out_len, dtype=np.float64)
    wsum = np.zeros(out_len, dtype=np.float64)
    frames = np.fft.irfft(spec, n=n_fft, axis=1)
    for i in range(n_frames):
        s = i * hop
        y[s : s + n_fft] += frames[i] * window
        wsum[s : s + n_fft] += window**2
    wsum[wsum < EPS] = 1.0
    y /= wsum
    if len(y) < length:
        y = np.pad(y, (0, length - len(y)))
    return y[:length]


# --------------------------------------------------------------------------- #
# 多声道辅助
# --------------------------------------------------------------------------- #
def _split_channels(x: np.ndarray) -> np.ndarray:
    """统一成 (channels, samples) 的 float64 视图。"""
    if x.ndim == 1:
        return x[np.newaxis, :].astype(np.float64, copy=False)
    return x.T.astype(np.float64, copy=False)


def _merge_channels(ch_data: np.ndarray, was_stereo: bool) -> np.ndarray:
    if not was_stereo:
        return ch_data[0]
    return ch_data.T


# --------------------------------------------------------------------------- #
# 噪声样本分析
# --------------------------------------------------------------------------- #
def _zero_crossing_rate(seg: np.ndarray, frame: int, hop: int) -> float:
    if len(seg) < frame:
        return float(np.mean(np.abs(np.diff(np.signbit(seg)))))
    n = 1 + (len(seg) - frame) // hop
    rates = []
    for i in range(n):
        part = seg[i * hop : i * hop + frame]
        rates.append(np.mean(np.abs(np.diff(np.signbit(part)))))
    return float(np.mean(rates))


def _highpass(x: np.ndarray, sr: int, cutoff: float = 85.0) -> np.ndarray:
    """一阶高通, 滤掉 50/60Hz 电源嗡声等低频周期源, 仅用于语音周期检测。"""
    rc = 1.0 / (2 * math.pi * cutoff)
    dt = 1.0 / sr
    a = rc / (rc + dt)
    y = np.empty_like(x)
    prev_x = 0.0
    prev_y = 0.0
    for i, v in enumerate(x):
        y[i] = a * (prev_y + v - prev_x)
        prev_x, prev_y = v, y[i]
    return y


def _frame_hnr(frame: np.ndarray, sr: int) -> float:
    """单帧周期度指标 (dB), 基于归一化自相关峰; 噪声无周期 -> 负值, 浊音 -> 正值。

    r = max_lag ac(lag)/ac(0): 周期信号在基频周期处接近 1, 噪声接近 0。
    返回 10*log10(r/(1-r)) 作为类 HNR 的 dB 量纲指标。
    检测帧先经 85Hz 高通, 排除 50/60Hz 电源嗡声这类非语音周期源。
    """
    x = _highpass(frame - np.mean(frame), sr)
    energy = np.dot(x, x)
    if energy < EPS:
        return -20.0
    min_lag = max(1, int(sr / 500))
    max_lag = min(len(x) - 1, int(sr / 85))
    if max_lag <= min_lag:
        return -20.0
    ac = np.correlate(x, x, mode="full")[len(x) - 1 :]
    r = float(np.max(ac[min_lag:max_lag]) / (ac[0] + EPS))
    r = float(np.clip(r, 1e-4, 0.9999))
    return 10.0 * math.log10(r / (1.0 - r))


def _segment_hnr(seg: np.ndarray, sr: int) -> tuple[float, float]:
    """对片段按 40ms 帧求周期度, 返回 (平均 HNR dB, 高周期帧占比)。

    语音浊音帧 HNR 多在 +1.5 以上, 稳态噪声帧多为负值; 用占比而非平均,
    避免段内间隙/清音把整体均值拉低。
    """
    frame = int(sr * 0.04)
    hop = frame // 2
    if len(seg) < frame:
        return -20.0, 0.0
    vals = []
    for i in range(0, len(seg) - frame + 1, hop):
        vals.append(_frame_hnr(seg[i : i + frame], sr))
    if not vals:
        return -20.0, 0.0
    arr = np.asarray(vals)
    voiced_fraction = float(np.mean(arr > 1.5))
    return float(np.mean(arr)), voiced_fraction


def analyze_noise_segment(
    x: np.ndarray,
    sr: int,
    start: float,
    end: float,
    n_fft: int | None = None,
) -> dict[str, Any]:
    """分析噪声样本区间, 返回噪声轮廓与语音污染判断。

    判定依据 (语音/敲击与稳态噪声的统计差异):
    - 帧能量波峰因子 crest: 有人声时能量起伏大;
    - 谱平坦度 flatness: 噪声平坦(接近 1), 语音有谐波结构(明显偏小);
    - 过零率 ZCR: 浊音段 ZCR 低、清音段高, 与稳态噪声分布不同;
    - 高能帧占比 occupancy: 人声使不少帧显著高于中位能量。
    """
    if n_fft is None:
        n_fft = choose_n_fft(sr)
    hop = n_fft // 2
    i0, i1 = int(round(start * sr)), int(round(end * sr))
    i0 = max(0, min(i0, len(x)))
    i1 = max(i0, min(i1, len(x)))
    duration = (i1 - i0) / sr
    warnings: list[str] = []
    if duration < 0.1:
        raise ValueError("噪声样本太短: 至少需要 0.1 秒, 建议 0.5 秒以上")
    if duration < 0.5:
        warnings.append("样本不足 0.5 秒, 噪声轮廓估计可能不稳定, 建议选取更长的纯噪声段")

    channels = _split_channels(x)
    profiles: list[np.ndarray] = []
    flatness_vals, crest_vals, zcr_vals, occ_vals, hnr_vals = [], [], [], [], []
    n_frames = 0

    for ch in channels:
        seg = ch[i0:i1]
        spec = stft(seg, n_fft, hop)
        if spec.shape[0] < 2:
            raise ValueError("噪声样本不足一个分析窗, 请选取更长的区间")
        n_frames = spec.shape[0]
        mag = np.abs(spec)
        profiles.append(np.mean(mag, axis=0))

        power = np.sum(mag**2, axis=1) + EPS
        # 谱平坦度: 几何均值 / 算术均值 (按帧平均)
        log_mag = np.log(mag + EPS)
        flat = np.exp(np.mean(log_mag, axis=1)) / (np.mean(mag, axis=1) + EPS)
        flatness_vals.append(float(np.mean(flat)))

        rms = np.sqrt(power / n_fft)
        med = float(np.median(rms)) + EPS
        crest_vals.append(float(np.max(rms) / med))
        occ_vals.append(float(np.mean(rms > 3.0 * med)))
        zcr_vals.append(_zero_crossing_rate(seg, int(sr * 0.02), int(sr * 0.01)))
        hnr_vals.append(_segment_hnr(seg, sr))

    flatness = float(np.mean(flatness_vals))
    crest = float(np.mean(crest_vals))
    zcr = float(np.mean(zcr_vals))
    occupancy = float(np.mean(occ_vals))
    hnr = float(np.mean([v[0] for v in hnr_vals]))
    voiced_fraction = float(np.mean([v[1] for v in hnr_vals]))

    # 判定依据: 稳态噪声没有基频周期 (高 HNR 帧占比很低), 语音有明显浊音段;
    # 辅以能量起伏与谱平坦度, 避免把稳态哼声误判成语音
    speech_suspected = (
        voiced_fraction > 0.25
        or hnr > 3.0
        or (flatness < 0.32 and crest > 5.0 and occupancy > 0.12)
        or (crest > 10.0 and occupancy > 0.2)
        or (flatness < 0.22 and crest > 4.0)
    )
    if speech_suspected:
        warnings.append(
            "噪声样本中检测到疑似语音或瞬态信号, 用它估计噪声轮廓可能削弱人声/敲击, "
            "建议改选只有底噪的区间"
        )

    noise_power = float(np.mean([np.sum(p**2) for p in profiles]) / n_fft)
    return {
        "n_fft": n_fft,
        "hop": hop,
        "frames": n_frames,
        "duration": round(duration, 4),
        "flatness": round(flatness, 4),
        "crest": round(crest, 3),
        "zcr": round(zcr, 4),
        "occupancy": round(occupancy, 4),
        "hnr_db": round(hnr, 2),
        "voiced_fraction": round(voiced_fraction, 3),
        "speech_suspected": bool(speech_suspected),
        "noise_power_db": round(10.0 * math.log10(noise_power + EPS), 2),
        "warnings": warnings,
        "profile": [p.tolist() for p in profiles],
    }


# --------------------------------------------------------------------------- #
# 谱减降噪
# --------------------------------------------------------------------------- #
def _voice_like(
    mag: np.ndarray,
    noise_mag: np.ndarray,
    sr: int,
    n_fft: int,
    hop: int,
    raw_frames: np.ndarray,
) -> np.ndarray:
    """逐帧判断是否像语音: 谐波结构(HNR) + 能量高于噪声 + 低谱平坦度。

    HNR 必须在原始时域帧上计算 (带真实相位), 不能用幅度谱零相位重构帧。
    """
    frame_power = np.sum(mag**2, axis=1)
    noise_power = np.sum(noise_mag**2) + EPS
    flat = np.exp(np.mean(np.log(mag + EPS), axis=1)) / (np.mean(mag, axis=1) + EPS)
    hnr = np.array([_frame_hnr(f, sr) for f in raw_frames])
    loud = frame_power > 1.5 * noise_power
    # HNR 为主判据 (噪声帧 HNR 通常 < -5, 浊音帧 > 3), 平坦度仅作辅助
    return loud & (hnr > 2.0) & (flat < 0.85)


def _denoise_channel(
    x: np.ndarray,
    profile: np.ndarray,
    n_fft: int,
    hop: int,
    sr: int,
    strength: float,
    smoothing: float,
    protect_transient: bool,
    protect_voice: bool,
) -> np.ndarray:
    """单声道降噪。strength/smoothing 均为 0~1。"""
    if strength <= 0.0:
        return x.copy()
    alpha = 1.0 + 7.0 * float(np.clip(strength, 0.0, 1.0))
    sm = 0.95 * float(np.clip(smoothing, 0.0, 1.0))

    spec = stft(x, n_fft, hop)
    if spec.shape[0] == 0:
        return x.copy()
    mag = np.abs(spec)
    phase = spec / (mag + EPS)
    noise2 = profile**2

    # 加窗时域帧, 供 HNR 周期检测 (保留真实相位); 填充方式与 stft 完全一致
    window = np.hanning(n_fft)
    padded = _frame_signal(x, spec.shape[0], n_fft, hop)
    raw_frames = np.stack(
        [padded[i * hop : i * hop + n_fft] * window for i in range(spec.shape[0])]
    )

    # 帧能量 (dB), 用于瞬态检测
    frame_power = np.sum(mag**2, axis=1) + EPS
    frame_db = 10.0 * np.log10(frame_power)

    voice = (
        _voice_like(mag, profile, sr, n_fft, hop, raw_frames)
        if protect_voice
        else np.zeros(spec.shape[0], bool)
    )

    # 瞬态检测: 帧能量正跳变显著高于常态 (自适应阈值), 且不是持续升高的语音
    deltas = np.diff(frame_db, prepend=frame_db[0])
    positive = deltas[deltas > 0]
    rise_med = float(np.median(positive)) if positive.size else 3.0
    rise_thresh = max(8.0, rise_med * 4.0)
    rise_frames = np.where((deltas > rise_thresh) & (~voice))[0]
    # 上升帧及其前一帧: 敲击能量会泄漏到前一分析窗, 两帧一起保护
    transient = np.zeros(spec.shape[0], dtype=bool)
    for t in rise_frames:
        transient[max(0, t - 1)] = True
        transient[t] = True

    gains = np.empty_like(mag)
    prev_g = np.ones(mag.shape[1])
    for t in range(spec.shape[0]):
        a = alpha
        if voice[t]:
            a = max(1.0, alpha * 0.45)  # 语音帧显著减弱过减, 保留人声
        # 标准谱减增益: g = sqrt(max(1 - a*N^2/S^2, floor^2))
        # 噪声帧 S≈N 时 g 随强度趋近 floor, 信号帧 S≫N 时 g→1
        ratio = a * noise2 / (mag[t] ** 2 + EPS)
        g = np.sqrt(np.maximum(1.0 - ratio, GAIN_FLOOR**2))

        if protect_transient and transient[t]:
            # 瞬态帧(含敲击泄漏的前一分析窗)托底到 -2 dB, 且不被时间平滑侵蚀
            g = np.maximum(g, 0.8)
            gains[t] = g
            prev_g = g
            continue

        if sm > 0.0:
            # 起音快、释放慢: 增益变大(声音回来)时不做平滑
            g_sm = sm * prev_g + (1.0 - sm) * g
            g = np.maximum(g, g_sm)
        gains[t] = g
        prev_g = g

    out_spec = gains * mag * phase
    return istft(out_spec, n_fft, hop, len(x))


def denoise(
    x: np.ndarray,
    sr: int,
    noise_profile: list[list[float]] | np.ndarray,
    n_fft: int,
    hop: int | None = None,
    strength: float = 0.5,
    smoothing: float = 0.6,
    protect_transient: bool = True,
    protect_voice: bool = True,
) -> np.ndarray:
    """对整段录音应用谱减降噪, 输入/输出形状一致 (一维或 (n, 2))。"""
    if hop is None:
        hop = n_fft // 2
    was_stereo = x.ndim == 2
    channels = _split_channels(x)
    n_ch = channels.shape[0]
    profiles = [np.asarray(p, dtype=np.float64) for p in noise_profile]
    if len(profiles) != n_ch:
        raise ValueError(f"噪声轮廓声道数 {len(profiles)} 与音频声道数 {n_ch} 不一致")

    out = np.empty_like(channels)
    for c in range(n_ch):
        if profiles[c].shape[0] != n_fft // 2 + 1:
            raise ValueError("噪声轮廓频点数与分析窗不匹配, 请重新选取噪声样本")
        out[c] = _denoise_channel(
            channels[c],
            profiles[c],
            n_fft,
            hop,
            sr,
            strength,
            smoothing,
            protect_transient,
            protect_voice,
        )
    y = _merge_channels(out, was_stereo)
    return np.clip(y, -1.0, 1.0)


# --------------------------------------------------------------------------- #
# 展示用统计量
# --------------------------------------------------------------------------- #
def average_spectrum_db(
    x: np.ndarray, sr: int, start: float, end: float, n_fft: int
) -> tuple[np.ndarray, np.ndarray]:
    """区间平均幅度谱 (dB), 多声道取声道均值。"""
    hop = n_fft // 2
    i0, i1 = int(round(start * sr)), int(round(end * sr))
    i0, i1 = max(0, i0), min(len(x), i1)
    channels = _split_channels(x)
    acc = None
    for ch in channels:
        spec = stft(ch[i0:i1], n_fft, hop)
        if spec.shape[0] == 0:
            continue
        mag = np.mean(np.abs(spec), axis=0)
        acc = mag if acc is None else acc + mag
    if acc is None:
        acc = np.full(n_fft // 2 + 1, EPS)
    else:
        acc /= channels.shape[0]
    db = 20.0 * np.log10(acc + EPS)
    db = np.maximum(db, DB_FLOOR)
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / sr)
    return freqs, db


def waveform_peaks(x: np.ndarray, buckets: int = 2000) -> dict[str, np.ndarray]:
    """返回每个桶的 min/max 峰值, 供 Canvas 画波形。"""
    channels = _split_channels(x)
    n = channels.shape[1]
    buckets = max(64, min(buckets, max(64, n // 4)))
    edges = np.linspace(0, n, buckets + 1, dtype=int)
    mins, maxs = [], []
    for ch in channels:
        cmin, cmax = [], []
        for a, b in zip(edges[:-1], edges[1:]):
            part = ch[a:b]
            if part.size == 0:
                cmin.append(0.0)
                cmax.append(0.0)
            else:
                cmin.append(float(np.min(part)))
                cmax.append(float(np.max(part)))
        mins.append(cmin)
        maxs.append(cmax)
    return {
        "min": np.asarray(mins, dtype=np.float32),
        "max": np.asarray(maxs, dtype=np.float32),
    }


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.asarray(x, dtype=np.float64) ** 2) + EPS))
