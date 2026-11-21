#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成虚构跑道与试跑数据（纯标准库，确定性输出）。

产物：
  data/track.json          跑道几何（折线点列、检查点、交叉点、分段长度）
  data/runs/<id>.json      每趟试跑的原始采样 + 检查点硬件触发记录
  data/data.js             上述内容的打包文件，供 file:// 直接打开的页面加载

重新生成：python3 tools/generate_data.py
"""
import json
import math
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA_DIR = os.path.join(ROOT, "data")
RUN_DIR = os.path.join(DATA_DIR, "runs")

# --- 跑道参数 -------------------------------------------------------------
RAW_STEPS = 20000          # 原始参数曲线采样数
GRID_N = 2400              # 输出折线点列数（等弧长重采样）
TARGET_LEN = 4000.0        # 一圈目标长度（米）
CP_FRACTIONS = [0.0, 0.14, 0.30, 0.50, 0.66, 0.82, 1.0]
CP_NAMES = ["起点/终点线", "CP1", "CP2", "CP3", "CP4", "CP5", "终点线（同起点）"]
TRACK_ID = "fig8-lemnis-4000"

# --- 判定阈值（与 js/importer.js 保持一致）--------------------------------
V_MAX = 80.0               # 可信瞬时速度上限 m/s，超过视为跳变
MAX_INTERP_S = 10.0        # 缺失 <= 该秒数且两端有可信采样才允许线性插值


def build_track():
    """Gerono 双纽线 x=a cos t, y=a sin t cos t —— 自交叉的 8 字形闭环。"""
    raw = []
    for i in range(RAW_STEPS + 1):
        t = 2.0 * math.pi * i / RAW_STEPS
        raw.append((math.cos(t), math.sin(t) * math.cos(t)))

    # 累计弦长，再缩放到目标长度
    cum = [0.0]
    for i in range(1, len(raw)):
        dx = raw[i][0] - raw[i - 1][0]
        dy = raw[i][1] - raw[i - 1][1]
        cum.append(cum[-1] + math.hypot(dx, dy))
    scale = TARGET_LEN / cum[-1]

    def xy_at_raw_len(length):
        target = length
        lo, hi = 0, len(cum) - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if cum[mid] < target:
                lo = mid + 1
            else:
                hi = mid
        i = max(1, lo)
        frac = (target - cum[i - 1]) / max(cum[i] - cum[i - 1], 1e-12)
        x = raw[i - 1][0] + frac * (raw[i][0] - raw[i - 1][0])
        y = raw[i - 1][1] + frac * (raw[i][1] - raw[i - 1][1])
        return x * scale, y * scale

    waypoints = []
    for i in range(GRID_N + 1):
        length = TARGET_LEN * i / GRID_N
        x, y = xy_at_raw_len(length / scale)
        waypoints.append({"s": round(length, 3), "x": round(x, 3), "y": round(y, 3)})

    # 交叉点：参数 t = pi/2、3pi/2 处都经过 (0,0)，换算成两个不同的弧长位置
    def s_of_param(t):
        # 在原始累计长度上二分找 t
        target_idx = t / (2.0 * math.pi) * RAW_STEPS
        return cum[int(round(target_idx))] * scale

    crossings = sorted({round(s_of_param(math.pi / 2), 3),
                        round(s_of_param(3.0 * math.pi / 2), 3)})

    checkpoints = []
    for cp_id, (frac, name) in enumerate(zip(CP_FRACTIONS, CP_NAMES)):
        s = round(TARGET_LEN * frac, 3)
        checkpoints.append({
            "id": "cp%d" % cp_id,
            "name": name,
            "s": s,
            "isFinish": frac == 1.0,
        })

    track = {
        "schema": "ghost-run/1.0",
        "trackId": TRACK_ID,
        "name": "虚构双纽线练习跑道",
        "lengthM": TARGET_LEN,
        "maxPlausibleSpeed": V_MAX,
        "maxInterpGapSec": MAX_INTERP_S,
        "waypoints": waypoints,
        "crossings": crossings,
        "checkpoints": checkpoints,
    }
    return track


def simulate(track, seg_means, rate_hz, seed, phase=0.0):
    """按分段平均速度 + 正弦微调做时间-弧长积分，返回 (tt 表, 采样列表)。"""
    rng = random.Random(seed)
    wps = track["waypoints"]
    n = len(wps) - 1
    cps = track["checkpoints"]

    def seg_index(s):
        for i in range(len(cps) - 1):
            if s <= cps[i + 1]["s"] + 1e-9:
                return i
        return len(cps) - 2

    # t(s) 积分表
    tt = [0.0]
    for i in range(1, n + 1):
        s_mid = (wps[i]["s"] + wps[i - 1]["s"]) / 2.0
        v = seg_means[seg_index(s_mid)] * (1.0 + 0.05 * math.sin(2.0 * math.pi * s_mid / 850.0 + phase))
        ds = wps[i]["s"] - wps[i - 1]["s"]
        tt.append(tt[-1] + ds / v)
    total_t = tt[-1]

    def s_at_time(t):
        lo, hi = 0, n
        while lo < hi:
            mid = (lo + hi) // 2
            if tt[mid] < t:
                lo = mid + 1
            else:
                hi = mid
        i = max(1, lo)
        frac = (t - tt[i - 1]) / max(tt[i] - tt[i - 1], 1e-12)
        return wps[i - 1]["s"] + frac * (wps[i]["s"] - wps[i - 1]["s"])

    def xy_at_s(s):
        pos = s / TARGET_LEN * n
        i = min(n - 1, max(0, int(pos)))
        frac = pos - i
        x = wps[i]["x"] + frac * (wps[i + 1]["x"] - wps[i]["x"])
        y = wps[i]["y"] + frac * (wps[i + 1]["y"] - wps[i]["y"])
        return x, y

    samples = []
    k = 0
    while True:
        t = k / rate_hz
        if t > total_t:
            break
        s = s_at_time(t)
        x, y = xy_at_s(s)
        # 普通定位噪声 ±0.6m
        x += rng.uniform(-0.6, 0.6)
        y += rng.uniform(-0.6, 0.6)
        samples.append({
            "t": round(t * 1000),
            "s": round(s, 2),
            "x": round(x, 2),
            "y": round(y, 2),
        })
        k += 1

    # 检查点真实通过时间（模拟硬件触发，页面端只认记录里的触发事件）
    cp_times = {}
    for cp in cps[1:]:
        lo, hi = 0, n
        while lo < hi:
            mid = (lo + hi) // 2
            if wps[mid]["s"] < cp["s"]:
                lo = mid + 1
            else:
                hi = mid
        i = max(1, lo)
        frac = (cp["s"] - wps[i - 1]["s"]) / max(wps[i]["s"] - wps[i - 1]["s"], 1e-12)
        ct = tt[i - 1] + frac * (tt[i] - tt[i - 1])
        cp_times[cp["id"]] = round(ct * 1000 + rng.uniform(-30, 30))
    return tt, total_t, samples, cp_times, xy_at_s


def drop_window(samples, t0_s, t1_s):
    return [q for q in samples if not (t0_s * 1000 <= q["t"] <= t1_s * 1000)]


def make_run(track, run_id, label, seg_means, rate_hz, seed, notes,
             anomalies=None, triggers_to_omit=None, truncate_s=None,
             reverse_from=None, phase=0.0):
    tt, total_t, samples, cp_times, xy_at_s = simulate(
        track, seg_means, rate_hz, seed, phase)
    anomalies = anomalies or []
    triggers_to_omit = triggers_to_omit or []

    if reverse_from is not None:
        # 逆向：从 reverse_from 处向 s 减小方向行驶到 0
        rev = []
        rate_ms = 1000.0 / rate_hz
        t_ms = 0
        s = reverse_from
        while s > 0:
            x, y = xy_at_s(s)
            rev.append({"t": round(t_ms), "s": round(s, 2),
                        "x": round(x, 2), "y": round(y, 2)})
            t_ms += rate_ms
            s -= 44.0 / rate_hz  # 近似匀速倒车
        samples = rev
        total_t = t_ms / 1000.0
        cp_times = {}

    for kind, payload in anomalies:
        if kind == "gap":
            samples = drop_window(samples, payload[0], payload[1])
        elif kind == "spike":
            # 明显倒退：把目标时刻最近的采样点向后挪 30m
            target_ms = payload[0] * 1000
            idx = min(range(len(samples)),
                      key=lambda i: abs(samples[i]["t"] - target_ms))
            s_back = max(0.0, samples[idx]["s"] - 30.0)
            x, y = xy_at_s(s_back)
            samples[idx]["s"] = round(s_back, 2)
            samples[idx]["x"] = round(x, 2)
            samples[idx]["y"] = round(y, 2)
        elif kind == "cut":
            # 抄近路：极短时间内弧长跳变（动力学上不可能），模拟漏检查点。
            # 按时间切开，丢弃跳变目标弧长之前的旧轨迹残段，从桥点直接续上，
            # 保证跳变之后的证据链起点在目标弧长之后（不会把漏掉的 CP 包回链内）。
            t0, s_from, s_to = payload
            t0_ms = t0 * 1000
            kept = [q for q in samples if q["t"] < t0_ms]
            after = [q for q in samples if q["t"] > t0_ms and q["s"] >= s_to]
            if after:
                x, y = xy_at_s(s_to)
                bridge = {"t": round(t0_ms), "s": round(s_to, 2),
                          "x": round(x, 2), "y": round(y, 2)}
                shift = t0_ms + 200 - after[0]["t"]   # 桥点与下一点留 0.2s
                shifted = [dict(q, t=q["t"] + shift) for q in after]
                samples = sorted(kept + [bridge] + shifted, key=lambda q: q["t"])
            else:
                samples = kept

    if truncate_s is not None:
        samples = [q for q in samples if q["s"] <= truncate_s]

    checkpoints = []
    if reverse_from is None:
        max_s = max((q["s"] for q in samples), default=0.0)
        for cp in track["checkpoints"][1:]:
            if cp["id"] in triggers_to_omit:
                continue
            if cp["s"] > max_s + 25.0:
                continue  # 没到的检查点不会有触发记录
            checkpoints.append({"id": cp["id"], "t": cp_times[cp["id"]]})

    run = {
        "schema": "ghost-run/1.0",
        "trackId": TRACK_ID,
        "runId": run_id,
        "label": label,
        "kart": "虚构卡丁车 K-%d" % seed,
        "sampleRateHz": rate_hz,
        "notes": notes,
        "samples": samples,
        "checkpoints": checkpoints,
    }
    return run


def main():
    os.makedirs(RUN_DIR, exist_ok=True)
    track = build_track()

    runs = []

    # A：完整一圈，5Hz，数据干净
    runs.append(make_run(
        track, "trial-A", "试跑 A（基准候选）",
        [44, 40, 46, 43, 48, 45], 5.0, 101,
        "完整一圈，5Hz 均匀采样，无异常。", phase=0.0))

    # B：完整一圈，4Hz，含短缺失、倒退跳变、段内长缺失（不覆盖任何检查点）
    runs.append(make_run(
        track, "trial-B", "试跑 B（带信号问题）",
        [46, 38, 49, 42, 45, 43], 4.0, 202,
        "完整一圈，4Hz；63-69s 短时丢星（可插值），约 80s 一次明显倒退跳变，"
        "14-27.5s 长缺失落在 CP1-CP2 分段内部（无证据位置，检查点仍有硬件触发）。",
        anomalies=[("gap", (14.0, 27.5)),
                   ("gap", (63.0, 69.0)),
                   ("spike", (80.0,))],
        phase=0.7))

    # C：漏检查点（CP3 处动力学不可能的弧长跳变 = 抄近路）
    runs.append(make_run(
        track, "trial-C", "试跑 C（漏 CP3）",
        [45, 39, 47, 44, 47, 44], 5.0, 303,
        "CP3 前后在 2 秒内跨越约 390m 弧长，超过可信速度上限，判定为漏检查点。",
        anomalies=[("cut", (41.0, 1820.0, 2210.0))],
        triggers_to_omit={"cp3"}, phase=1.3))

    # D：中途退出，s≈2520 处停止，无终点触发
    runs.append(make_run(
        track, "trial-D", "试跑 D（中途退出）",
        [45, 40, 46, 43, 47, 44], 5.0, 404,
        "行驶到约 2520m 处退出，没有终点线触发，只记录到 CP3。",
        truncate_s=2520.0, phase=0.4))

    # E：逆向，从 s≈3200 倒着开回起点
    runs.append(make_run(
        track, "trial-E", "试跑 E（逆向）",
        [44, 40, 46, 43, 48, 45], 4.0, 505,
        "从 s≈3200m 处逆向行驶回起点，弧长单调减小。",
        reverse_from=3200.0))

    with open(os.path.join(DATA_DIR, "track.json"), "w", encoding="utf-8") as f:
        json.dump(track, f, ensure_ascii=False, indent=1)

    for run in runs:
        path = os.path.join(RUN_DIR, run["runId"] + ".json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(run, f, ensure_ascii=False, indent=1)

    bundle = {"track": track, "runs": runs}
    with open(os.path.join(DATA_DIR, "data.js"), "w", encoding="utf-8") as f:
        f.write("// 由 tools/generate_data.py 自动生成，请勿手工修改。\n")
        f.write("window.GHOST_DATA = ")
        json.dump(bundle, f, ensure_ascii=False)
        f.write(";\n")

    # 控制台摘要，方便核对生成结果
    print("track length: %.1f m, waypoints: %d, crossings at s=%s"
          % (track["lengthM"], len(track["waypoints"]), track["crossings"]))
    for run in runs:
        ts = [q["t"] for q in run["samples"]]
        print("%-8s samples=%4d  duration=%6.1fs  triggers=%s"
              % (run["runId"], len(run["samples"]),
                 (max(ts) - min(ts)) / 1000.0 if ts else 0.0,
                 [c["id"] for c in run["checkpoints"]]))


if __name__ == "__main__":
    main()
