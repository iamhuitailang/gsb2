#!/usr/bin/env python3
"""三路分频实验(纯软件, 不接硬件)

分频方案: 线性相位 FIR 互补分频
  low  = LP_f1(x)                     群延迟 D
  rest = x延迟D - low                 (f1 处的高通补)
  mid  = LP_f2(rest)                  群延迟 2D
  high = rest延迟D - mid              (f2 处的高通补)
精确恒等式: delay(low, D) + mid + high == delay(x, 2D)
所以默认对齐规则下三段可以(在浮点/存储精度内)拼回原声。

头尾对齐规则(全程一致):
  - 滤波均为因果、头部补零;
  - 每路导出前按各自补偿量做整数样本平移, 不足补零;
  - 所有导出 wav 长度 == 输入长度, 尾部直接截断;
  - 误差参考 = 原信号延迟总延迟 2D 后截到同长。

子命令:
  gen     生成测试信号(脉冲 / 三个分频带纯音 / 分界频率纯音 / 立体声混合)
  split   读入 mono/stereo wav, 三路分频, 导出低/中/高 + 对齐合声 + report.json
  verify  重新读入某次导出的 wav, 核对声道数、样本长度和差值
  demo    一键跑完整实验并打印 PASS/FAIL
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import fftconvolve, firwin

BANDS = ("low", "mid", "high")
CN = {"low": "低", "mid": "中", "high": "高"}


# ---------------------------------------------------------------- wav IO
def _to_2d(x):
    return x[:, None] if x.ndim == 1 else x


def read_wav(path):
    """读 mono/stereo wav, 统一成 (n, ch) float64。"""
    fs, d = wavfile.read(str(path))
    if d.dtype == np.int16:
        x = d.astype(np.float64) / 32768.0
    elif d.dtype == np.int32:
        x = d.astype(np.float64) / 2147483648.0
    elif d.dtype == np.uint8:
        x = (d.astype(np.float64) - 128.0) / 128.0
    elif d.dtype in (np.float32, np.float64):
        x = d.astype(np.float64)
    else:
        raise ValueError(f"不支持的 wav 格式: {d.dtype}")
    x = _to_2d(x)
    if x.shape[1] not in (1, 2):
        raise ValueError(f"只支持单声道/立体声, 收到 {x.shape[1]} 声道")
    return fs, x


def write_wav(path, fs, x):
    """统一写 float32 wav(读回 bit-exact, 便于核对)。"""
    wavfile.write(str(path), fs, _to_2d(x).astype(np.float32))


def quantize(x):
    """模拟写盘: 转到 float32 再转回, 报告里的差值以写盘数据为准。"""
    return _to_2d(x).astype(np.float32).astype(np.float64)


# ---------------------------------------------------------------- DSP
def shift_rows(x, k, out_len=None):
    """整数样本平移: k>0 延后, k<0 提前; 头部补零, 尾部截断/补零到 out_len。"""
    n = x.shape[0] if out_len is None else out_len
    out = np.zeros((n, x.shape[1]))
    src0, dst0 = max(0, -k), max(0, k)
    m = min(x.shape[0] - src0, n - dst0)
    if m > 0:
        out[dst0:dst0 + m] = x[src0:src0 + m]
    return out


def design_crossover(fs, f1, f2, taps):
    if not 0 < f1 < f2 < fs / 2:
        raise ValueError(f"需要 0 < f1 < f2 < fs/2, 收到 f1={f1}, f2={f2}, fs={fs}")
    if taps % 2 == 0:
        taps += 1  # 奇数阶 -> 群延迟为整数样本
    lp1 = firwin(taps, f1, fs=fs)
    lp2 = firwin(taps, f2, fs=fs)
    return lp1, lp2, (taps - 1) // 2, taps


def split3(x, lp1, lp2, D):
    """互补三路分频, 返回全长度(未截断)的 low/mid/high。"""
    low = fftconvolve(x, lp1[:, None], axes=0)            # 群延迟 D
    rest = shift_rows(x, D, low.shape[0]) - low           # f1 高通补
    mid = fftconvolve(rest, lp2[:, None], axes=0)         # 群延迟 2D
    high = shift_rows(rest, D, mid.shape[0]) - mid        # f2 高通补
    return {"low": low, "mid": mid, "high": high}


def align_bands(bands, D, n):
    """默认对齐: 低路再补 D(中/高已是 2D), 全部截到输入长度 n。"""
    return {
        "low": shift_rows(bands["low"], D, n),
        "mid": shift_rows(bands["mid"], 0, n),
        "high": shift_rows(bands["high"], 0, n),
    }


def process(x, fs, f1, f2, taps, invert=(), shifts=None):
    """分频 -> (可选)人为反相/移位 -> 对齐 -> 合成 -> 误差。返回完整结果 dict。"""
    shifts = shifts or {}
    lp1, lp2, D, taps = design_crossover(fs, f1, f2, taps)
    bands = split3(x, lp1, lp2, D)

    tampered = dict(bands)
    for b in invert:
        tampered[b] = -tampered[b]
    for b, k in shifts.items():
        tampered[b] = shift_rows(tampered[b], k)

    n, latency = x.shape[0], 2 * D
    aligned = align_bands(tampered, D, n)
    total = aligned["low"] + aligned["mid"] + aligned["high"]
    ref = shift_rows(x, latency, n)          # 参考 = 原声延迟总延迟
    err = total - ref
    return {
        "fs": fs, "f1": f1, "f2": f2, "taps": taps, "D": D, "latency": latency,
        "n": n, "channels": x.shape[1],
        "bands": aligned, "sum": total, "ref": ref, "err": err,
        "invert": list(invert), "shifts": dict(shifts),
        "group_delay": {"low": D, "mid": 2 * D, "high": 2 * D},
        "align_comp": {"low": D, "mid": 0, "high": 0},
    }


def rms(a):
    return float(np.sqrt(np.mean(a ** 2))) if a.size else 0.0


def err_metrics(err, ref):
    r_ref, r_err = rms(ref), rms(err)
    return {
        "err_peak": float(np.max(np.abs(err))) if err.size else 0.0,
        "err_rms": r_err,
        "ref_rms": r_ref,
        "err_db": 20 * np.log10(r_err / r_ref) if r_ref > 0 and r_err > 0 else -np.inf,
    }


# ---------------------------------------------------------------- 报告
def print_report(rep, title=""):
    if title:
        print(f"\n=== {title} ===")
    print(f"采样率 {rep['fs']} Hz | 分界 {rep['f1']:.0f}/{rep['f2']:.0f} Hz | "
          f"FIR {rep['taps']} taps | 声道 {rep['channels']} | 长度 {rep['n']}")
    print("分频器固有延迟(群延迟, 样本):")
    for b in BANDS:
        gd = rep["group_delay"][b]
        print(f"  {CN[b]}路: {gd:6d} 样本 ({gd / rep['fs'] * 1e3:6.2f} ms), "
              f"对齐补偿 +{rep['align_comp'][b]} 样本")
    print(f"  总延迟(合成相对原声): {rep['latency']} 样本 "
          f"({rep['latency'] / rep['fs'] * 1e3:.2f} ms)")
    print("人为引入的错位:")
    if rep["invert"] or rep["shifts"]:
        for b in rep["invert"]:
            print(f"  {CN[b]}路: 反相")
        for b, k in rep["shifts"].items():
            print(f"  {CN[b]}路: 平移 {k:+d} 样本")
    else:
        print("  无")
    m = rep["metrics"]
    err_db_s = "低于 float32 精度(完全重合)" if m["err_db"] == -np.inf else f"{m['err_db']:.1f} dB"
    print(f"合成 vs 原声(延迟对齐后): 误差峰值 {m['err_peak']:.3e} | "
          f"误差 RMS {m['err_rms']:.3e} | 相对电平 {err_db_s}")
    if "baseline_err_db" in rep:
        b = rep["baseline_err_db"]
        b_s = "完全重合" if b == -np.inf else f"{b:.1f} dB"
        d_s = "从完全重合劣化" if b == -np.inf else f"恶化 {m['err_db'] - b:.1f} dB"
        print(f"  (未加人为错位的基线: {b_s}, 错位使误差{d_s})")


def make_report(res, err, ref):
    rep = {k: res[k] for k in ("fs", "f1", "f2", "taps", "D", "latency", "n",
                               "channels", "invert", "shifts", "group_delay",
                               "align_comp")}
    rep["metrics"] = err_metrics(err, ref)
    return rep


# ---------------------------------------------------------------- gen
def gen_signals(out_dir, fs, f1, f2, dur=1.0):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    n = int(fs * dur)
    t = np.arange(n) / fs

    f_low = f1 / 2.0
    f_mid = np.sqrt(f1 * f2)
    f_high = min(2.0 * f2, 0.45 * fs)

    # 1) 脉冲
    imp = np.zeros(n)
    p_imp = n // 4
    imp[p_imp] = 1.0
    write_wav(out / "impulse.wav", fs, imp)

    # 2) 三个分落在不同频带的纯音(顺序播放, 各占 1/3)
    tones = np.zeros(n)
    third = n // 3
    tone_freqs = [f_low, f_mid, f_high]
    for i, f in enumerate(tone_freqs):
        s = slice(i * third, (i + 1) * third if i < 2 else n)
        tones[s] = 0.8 * np.sin(2 * np.pi * f * t[s])
    write_wav(out / "tones.wav", fs, tones)

    # 3) 恰好落在分界上的纯音(前半 f1, 后半 f2)
    xo = np.zeros(n)
    half = n // 2
    xo[:half] = 0.8 * np.sin(2 * np.pi * f1 * t[:half])
    xo[half:] = 0.8 * np.sin(2 * np.pi * f2 * t[half:])
    write_wav(out / "xover_tone.wav", fs, xo)

    # 4) 立体声混合(验证立体声通路)
    left = 0.9 * tones + 0.8 * imp
    imp2 = shift_rows(imp[:, None], 1000)[:, 0]
    right = 0.6 * tones + 0.8 * imp2
    write_wav(out / "stereo_mix.wav", fs, np.column_stack([left, right]))

    meta = {"fs": fs, "f1": f1, "f2": f2, "n": n, "impulse_pos": p_imp,
            "tone_freqs": tone_freqs, "tone_seg_len": third}
    (out / "meta.json").write_text(json.dumps(meta, indent=2))
    print(f"测试信号已生成到 {out}/ (fs={fs}, f1={f1}, f2={f2})")
    print(f"  纯音频率: 低 {f_low:.0f} / 中 {f_mid:.0f} / 高 {f_high:.0f} Hz")
    return meta


# ---------------------------------------------------------------- split
def run_split(in_path, out_dir, f1, f2, taps, invert=(), shifts=None):
    fs, x = read_wav(in_path)
    res = process(x, fs, f1, f2, taps, invert=invert, shifts=shifts)

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    # 报告数值一律以写盘的 float32 数据为准, 保证 verify 能核对上
    qbands = {b: quantize(res["bands"][b]) for b in BANDS}
    qsum = quantize(res["sum"])
    qref = res["ref"]
    for b in BANDS:
        write_wav(out / f"{b}.wav", fs, qbands[b])
    write_wav(out / "sum_aligned.wav", fs, qsum)

    rep = make_report(res, qsum - qref, qref)
    if invert or shifts:
        base = process(x, fs, f1, f2, taps)  # 无错位的基线
        rep["baseline_err_db"] = err_metrics(quantize(base["sum"]) - qref, qref)["err_db"]
    rep["input"] = str(Path(in_path).resolve())
    (out / "report.json").write_text(json.dumps(rep, indent=2, ensure_ascii=False))
    print_report(rep, title=f"split: {Path(in_path).name} -> {out}/")
    print(f"已导出: low.wav / mid.wav / high.wav / sum_aligned.wav / report.json")
    return rep


# ---------------------------------------------------------------- verify
def run_verify(out_dir, tol_db=0.5):
    out = Path(out_dir)
    rep = json.loads((out / "report.json").read_text())
    fs_in, x = read_wav(rep["input"])
    ok = True

    def check(name, cond, detail=""):
        nonlocal ok
        ok &= bool(cond)
        print(f"  [{'PASS' if cond else 'FAIL'}] {name} {detail}")

    print(f"\n=== verify: {out}/ ===")
    check("采样率一致", fs_in == rep["fs"], f"({fs_in} Hz)")

    bands = {}
    for b in BANDS:
        fs_b, y = read_wav(out / f"{b}.wav")
        check(f"{CN[b]}路声道数", y.shape[1] == rep["channels"],
              f"({y.shape[1]} == {rep['channels']})")
        check(f"{CN[b]}路样本长度", y.shape[0] == rep["n"],
              f"({y.shape[0]} == {rep['n']})")
        check(f"{CN[b]}路采样率", fs_b == rep["fs"])
        bands[b] = y
    fs_s, s = read_wav(out / "sum_aligned.wav")
    check("合声声道数", s.shape[1] == rep["channels"])
    check("合声样本长度", s.shape[0] == rep["n"])
    check("合声采样率", fs_s == rep["fs"])

    # 重新合成: 读回的三路直接相加(盘上已是对齐后的), 与导出的合声比对
    resum = bands["low"] + bands["mid"] + bands["high"]
    d = float(np.max(np.abs(resum - s)))
    check("三路重加 == 导出合声", d < 1e-6, f"(max diff {d:.2e})")

    # 用重读的合声与原声重算差值, 与 report.json 核对
    ref = shift_rows(x, rep["latency"], rep["n"])
    m = err_metrics(s - ref, ref)
    rep_db = rep["metrics"]["err_db"]
    same = (m["err_db"] == rep_db) or abs(m["err_db"] - rep_db) < tol_db
    check("差值与报告一致", same,
          f"(重算 {m['err_db']:.1f} dB vs 报告 {rep_db:.1f} dB)")
    print(f"verify 总体: {'PASS' if ok else 'FAIL'}")
    return ok


# ---------------------------------------------------------------- demo 检查
def band_rms_db(y, s):
    seg = y[s]
    return 20 * np.log10(rms(seg) + 1e-30)


def demo_checks(gen_dir, out_root, meta, taps):
    fs, f1, f2 = meta["fs"], meta["f1"], meta["f2"]
    n, p_imp = meta["n"], meta["impulse_pos"]
    results = []

    def check(name, cond, detail=""):
        results.append(bool(cond))
        print(f"  [{'PASS' if cond else 'FAIL'}] {name} {detail}")

    # -- 脉冲: 峰位置对齐
    print("\n[检查 1] 脉冲: 默认对齐后峰位置")
    rep = run_split(gen_dir / "impulse.wav", out_root / "impulse", f1, f2, taps)
    _, s = read_wav(out_root / "impulse" / "sum_aligned.wav")
    peak = int(np.argmax(np.abs(s[:, 0])))
    expect = p_imp + rep["latency"]
    check("合声脉冲峰对上", peak == expect,
          f"(峰在 {peak}, 期望 输入{p_imp}+延迟{rep['latency']}={expect})")
    for b in BANDS:
        _, y = read_wav(out_root / "impulse" / f"{b}.wav")
        print(f"    {CN[b]}路峰位置: {int(np.argmax(np.abs(y[:, 0])))} "
              f"(对齐后, 期望 {expect})")

    # -- 纯音: 主要落进对应段
    print("\n[检查 2] 三个纯音: 能量主要落进对应段")
    run_split(gen_dir / "tones.wav", out_root / "tones", f1, f2, taps)
    seg_len = meta["tone_seg_len"]
    names = ["低", "中", "高"]
    for i, f in enumerate(meta["tone_freqs"]):
        s = slice(i * seg_len + seg_len // 4, (i + 1) * seg_len - seg_len // 4)
        lv = {}
        for b in BANDS:
            _, y = read_wav(out_root / "tones" / f"{b}.wav")
            lv[b] = band_rms_db(y[:, 0], s)
        dom = max(lv, key=lv.get)
        margin = lv[BANDS[i]] - max(lv[b] for b in BANDS if b != BANDS[i])
        print(f"    {f:7.1f} Hz -> 低 {lv['low']:6.1f} / 中 {lv['mid']:6.1f} / "
              f"高 {lv['high']:6.1f} dB")
        check(f"{f:.0f} Hz 主落{names[i]}段", dom == BANDS[i] and margin > 20,
              f"(领先 {margin:.1f} dB)")

    # -- 分界频率纯音: 相邻两段近似均分
    print("\n[检查 3] 分界频率纯音: 相邻两段近似均分(-6 dB 各自)")
    run_split(gen_dir / "xover_tone.wav", out_root / "xover_tone", f1, f2, taps)
    half = n // 2
    for (s, fx, pair) in ((slice(half // 4, half - half // 4), f1, ("low", "mid")),
                          (slice(half + half // 4, n - half // 4), f2, ("mid", "high"))):
        lv = {b: band_rms_db(read_wav(out_root / "xover_tone" / f"{b}.wav")[1][:, 0], s)
              for b in BANDS}
        other = (set(BANDS) - set(pair)).pop()
        print(f"    {fx:.0f} Hz -> 低 {lv['low']:6.1f} / 中 {lv['mid']:6.1f} / "
              f"高 {lv['high']:6.1f} dB")
        check(f"{fx:.0f} Hz 由{CN[pair[0]]}/{CN[pair[1]]}均分",
              abs(lv[pair[0]] - lv[pair[1]]) < 1.0 and lv[other] < lv[pair[0]] - 20,
              f"(相邻差 {abs(lv[pair[0]] - lv[pair[1]]):.2f} dB, "
              f"第三段低 {lv[pair[0]] - lv[other]:.1f} dB)")

    # -- 立体声 + 反相/移位对比
    print("\n[检查 4] 立体声混合: 干净合成 vs 人为错位")
    rep_clean = run_split(gen_dir / "stereo_mix.wav", out_root / "stereo_clean",
                          f1, f2, taps)
    check("立体声干净合成误差 < -100 dB",
          rep_clean["metrics"]["err_db"] < -100,
          f"({rep_clean['metrics']['err_db']:.1f} dB)")
    rep_t = run_split(gen_dir / "stereo_mix.wav", out_root / "stereo_tampered",
                      f1, f2, taps, invert=["mid"], shifts={"high": 7})
    check("人为错位使误差显著恶化",
          rep_t["metrics"]["err_db"] > rep_clean["metrics"]["err_db"] + 40,
          f"(干净 {rep_clean['metrics']['err_db']:.1f} dB -> "
          f"错位 {rep_t['metrics']['err_db']:.1f} dB)")

    # -- verify: 重读核对
    print("\n[检查 5] 重新读入核对 (verify)")
    for d in ("impulse", "tones", "xover_tone", "stereo_clean", "stereo_tampered"):
        results.append(run_verify(out_root / d))

    print(f"\n===== demo 总结: {sum(results)}/{len(results)} 项通过 =====")
    return all(results)


# ---------------------------------------------------------------- CLI
def parse_shifts(items):
    shifts = {}
    for it in items or []:
        b, k = it.split("=")
        if b not in BANDS:
            raise SystemExit(f"--shift 的路名须为 low/mid/high, 收到 {b}")
        shifts[b] = int(k)
    return shifts


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--f1", type=float, default=300.0, help="低/中分界 Hz")
        p.add_argument("--f2", type=float, default=3000.0, help="中/高分界 Hz")
        p.add_argument("--taps", type=int, default=2049, help="FIR 阶数(奇数)")

    p = sub.add_parser("gen", help="生成测试信号")
    p.add_argument("--out", required=True)
    p.add_argument("--fs", type=int, default=48000)
    p.add_argument("--dur", type=float, default=1.0)
    common(p)

    p = sub.add_parser("split", help="分频并导出三路 + 对齐合声")
    p.add_argument("--in", dest="inp", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--invert", choices=BANDS, nargs="*", default=[],
                   help="反相的路")
    p.add_argument("--shift", action="append", metavar="BAND=N",
                   help="某路额外平移 N 样本, 如 --shift high=7")
    common(p)

    p = sub.add_parser("verify", help="重新读入导出结果并核对")
    p.add_argument("--dir", required=True)

    p = sub.add_parser("demo", help="一键完整实验")
    p.add_argument("--out", default="demo_out")
    p.add_argument("--fs", type=int, default=48000)
    common(p)

    args = ap.parse_args(argv)
    if args.cmd == "gen":
        gen_signals(args.out, args.fs, args.f1, args.f2, args.dur)
    elif args.cmd == "split":
        run_split(args.inp, args.out, args.f1, args.f2, args.taps,
                  invert=args.invert, shifts=parse_shifts(args.shift))
    elif args.cmd == "verify":
        sys.exit(0 if run_verify(args.dir) else 1)
    elif args.cmd == "demo":
        gen = Path(args.out) / "gen"
        meta = gen_signals(gen, args.fs, args.f1, args.f2)
        ok = demo_checks(gen, Path(args.out), meta, args.taps)
        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
