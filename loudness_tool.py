#!/usr/bin/env python3
"""批量音频响度检查与校正工具（本地处理，依赖 ffmpeg/ffprobe）。

分析指标遵循 EBU R128 / ITU-R BS.1770：
  - 整体响度 Integrated Loudness (LUFS)
  - 真峰值 True Peak (dBFS，过采样)
  - 响度范围 LRA (LU)

批次状态保存在批次目录的 batch.json 中，重新打开结果一致。
源文件永不修改；校正版本导出为 24-bit WAV，并生成 CSV 报告。
"""

import argparse
import csv
import json
import os
import re
import subprocess
import sys
import tempfile

BATCH_FILE = "batch.json"
DEFAULT_TARGET_LUFS = -16.0
DEFAULT_PEAK_CEILING = -1.0
LOUDNESS_FLOOR = -70.0          # ebur128 的绝对门限，低于此视为无法测量
SHORT_FILE_SECONDS = 3.0        # 低于此时长，整体响度参考价值有限
ESTIMATE_MIN_SECONDS = 0.4      # 低于此时长 ebur128 无完整 400ms 块，用 RMS 估计


# ---------------------------------------------------------------- 基础工具

def die(msg, code=1):
    print(f"错误: {msg}", file=sys.stderr)
    sys.exit(code)


def run(cmd):
    """运行外部命令，返回 (returncode, stdout+stderr)。"""
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def check_ffmpeg():
    for tool in ("ffmpeg", "ffprobe"):
        code, _ = run([tool, "-version"])
        if code != 0:
            die(f"未找到 {tool}，请先安装 ffmpeg（如 brew install ffmpeg）")


def fmt_loudness(v):
    return "-inf" if v is None else f"{v:+.1f}"


def fmt_peak(v):
    return "-inf" if v is None else f"{v:.1f}"


def fmt_duration(sec):
    if sec is None:
        return "--:--"
    m, s = divmod(sec, 60)
    return f"{int(m)}:{s:04.1f}"


# ---------------------------------------------------------------- 分析

def probe_file(path):
    code, out = run([
        "ffprobe", "-v", "error",
        "-show_entries", "stream=codec_type,channels,sample_rate,codec_name",
        "-show_entries", "format=duration",
        "-of", "json", path,
    ])
    if code != 0:
        raise RuntimeError(f"ffprobe 失败: {out.strip().splitlines()[-1] if out.strip() else '未知错误'}")
    info = json.loads(out)
    streams = [s for s in info.get("streams", []) if s.get("codec_type") == "audio"]
    if not streams:
        raise RuntimeError("文件中没有音频流")
    st = streams[0]
    try:
        duration = float(info["format"]["duration"])
    except (KeyError, ValueError):
        duration = None
    return {
        "duration": duration,
        "channels": st.get("channels"),
        "sample_rate": int(st["sample_rate"]) if st.get("sample_rate") else None,
        "codec": st.get("codec_name"),
    }


def parse_float(token):
    return None if token in ("-inf", "inf") else float(token)


def measure_ebur128(path):
    """返回 integrated_lufs, lra_lu, true_peak_dbfs（单位见名称）。"""
    code, out = run([
        "ffmpeg", "-hide_banner", "-nostats", "-i", path,
        "-af", "ebur128=peak=true", "-f", "null", "-",
    ])
    if code != 0:
        raise RuntimeError(f"ffmpeg 解码失败: {out.strip().splitlines()[-1] if out.strip() else '未知错误'}")

    def last(pattern):
        matches = re.findall(pattern, out)
        if not matches:
            raise RuntimeError("无法解析 ebur128 输出")
        return parse_float(matches[-1])

    integrated = last(r"I:\s+(-?[\d.]+|-inf)\s+LUFS")
    lra = last(r"LRA:\s+(-?[\d.]+|-inf)\s+LU")
    peak = last(r"Peak:\s+(-?[\d.]+|-inf)\s+dBFS")
    return integrated, lra, peak


def measure_rms_db(path):
    """兜底：整体 RMS 电平（dB），用于过短文件的经验估计。"""
    code, out = run([
        "ffmpeg", "-hide_banner", "-nostats", "-i", path,
        "-af", "astats=measure_overall=RMS_level:measure_perchannel=none",
        "-f", "null", "-",
    ])
    if code != 0:
        raise RuntimeError("RMS 测量失败")
    m = re.findall(r"RMS level dB:\s+(-?[\d.]+|-inf)", out)
    if not m:
        raise RuntimeError("无法解析 RMS 测量结果")
    return parse_float(m[-1])


def analyze_file(path):
    """分析单个文件，返回分析结果 dict；失败抛 RuntimeError。"""
    if not os.path.isfile(path):
        raise RuntimeError("文件不存在")
    meta = probe_file(path)
    integrated, lra, peak = measure_ebur128(path)

    flags = []
    estimate = False
    duration = meta["duration"]

    silent = peak is None  # 真峰值 -inf：整个文件没有任何可闻信号
    if silent:
        integrated = None
        lra = None
        flags.append("静音")
    else:
        if integrated is None or integrated <= LOUDNESS_FLOOR:
            # 过短（<400ms 无完整分析块）或电平极低：用 RMS 经验估计
            rms = measure_rms_db(path)
            integrated = None if rms is None else rms - 0.691
            estimate = integrated is not None
            flags.append("过短/极低电平，响度为RMS估计值")
        elif duration is not None and duration < SHORT_FILE_SECONDS:
            flags.append("短音频(<3s)，整体响度仅供参考")

    return {
        **meta,
        "integrated_lufs": integrated,
        "lra_lu": lra,
        "true_peak_dbfs": peak,
        "loudness_is_estimate": estimate,
        "flags": flags,
    }


# ---------------------------------------------------------------- 批次存储

def new_batch():
    return {
        "version": 1,
        "files": [],          # {id, path, name, group, status, error, analysis}
        "groups": {
            "default": {"target_lufs": DEFAULT_TARGET_LUFS,
                        "peak_ceiling_dbfs": DEFAULT_PEAK_CEILING}
        },
        "exports": [],
    }


def batch_path(batch_dir):
    return os.path.join(batch_dir, BATCH_FILE)


def load_batch(batch_dir):
    path = batch_path(batch_dir)
    if not os.path.isfile(path):
        die(f"批次不存在: {batch_dir}（先用 add 命令创建）")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_batch(batch_dir, batch):
    fd, tmp = tempfile.mkstemp(dir=batch_dir, prefix=".batch-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(batch, f, ensure_ascii=False, indent=2)
    os.replace(tmp, batch_path(batch_dir))


def find_files(batch, refs):
    """按 id 或文件名定位文件条目。"""
    found, missing = [], []
    for ref in refs:
        hit = None
        if ref.isdigit():
            hit = next((f for f in batch["files"] if f["id"] == int(ref)), None)
        if hit is None:
            hit = next((f for f in batch["files"] if f["name"] == ref), None)
        (found if hit else missing).append(hit or ref)
    return found, missing


def next_id(batch):
    return max((f["id"] for f in batch["files"]), default=0) + 1


def group_target(batch, group):
    return batch["groups"].get(group) or batch["groups"]["default"]


# ---------------------------------------------------------------- 校正计划

def build_plan(batch):
    """为每个分析成功的文件计算校正计划。"""
    plan = []
    for f in batch["files"]:
        if f["status"] != "ok":
            continue
        a = f["analysis"]
        tgt = group_target(batch, f["group"])
        entry = {
            "file": f,
            "target_lufs": tgt["target_lufs"],
            "ceiling": tgt["peak_ceiling_dbfs"],
            "gain_db": None,
            "predicted_peak": None,
            "will_clip": False,
            "note": "",
        }
        if a["integrated_lufs"] is None:
            entry["note"] = "静音文件，跳过校正"
        else:
            gain = tgt["target_lufs"] - a["integrated_lufs"]
            predicted = a["true_peak_dbfs"] + gain
            entry["gain_db"] = gain
            entry["predicted_peak"] = predicted
            if predicted > entry["ceiling"]:
                entry["will_clip"] = True
                max_gain = entry["ceiling"] - a["true_peak_dbfs"]
                entry["note"] = (
                    f"会削波：预测峰值 {predicted:.1f} dBFS > 上限 {entry['ceiling']:.1f} dBFS；"
                    f"该文件安全目标上限约 {a['integrated_lufs'] + max_gain:.1f} LUFS"
                )
        plan.append(entry)
    return plan


def print_plan(batch):
    plan = build_plan(batch)
    if not plan:
        print("没有可校正的文件（先 add 并确保分析成功）")
        return plan
    rows = []
    for e in plan:
        f, a = e["file"], e["file"]["analysis"]
        rows.append([
            f["id"], f["name"], f["group"],
            fmt_loudness(a["integrated_lufs"]),
            f"{e['target_lufs']:+.1f}",
            "--" if e["gain_db"] is None else f"{e['gain_db']:+.1f}",
            "--" if e["predicted_peak"] is None else f"{e['predicted_peak']:.1f}",
            f"{e['ceiling']:.1f}",
            "削波!" if e["will_clip"] else ("跳过" if e["gain_db"] is None else "OK"),
        ])
    print_table(["ID", "文件", "组", "响度(LUFS)", "目标", "增益(dB)",
                 "预测峰值", "峰值上限", "结论"], rows)
    for e in plan:
        if e["note"]:
            print(f"  [{e['file']['id']}] {e['file']['name']}: {e['note']}")
    # 按组给出安全目标建议
    by_group = {}
    for e in plan:
        if e["will_clip"]:
            a = e["file"]["analysis"]
            safe = a["integrated_lufs"] + (e["ceiling"] - a["true_peak_dbfs"])
            g = e["file"]["group"]
            by_group[g] = min(by_group.get(g, 0.0), safe)
    for g, safe in by_group.items():
        print(f"  建议: 组 '{g}' 目标响度降至 {safe:.1f} LUFS 可避免所有削波"
              f"（loudness_tool.py target <批次> --group {g} --lufs {safe:.1f}）")
    return plan


def print_table(header, rows):
    cols = list(zip(*([header] + rows))) if rows else [header]
    widths = [max(len(str(c)) for c in col) for col in cols]
    line = "  ".join(str(h).ljust(w) for h, w in zip(header, widths))
    print(line)
    print("  ".join("-" * w for w in widths))
    for row in rows:
        print("  ".join(str(c).ljust(w) for c, w in zip(row, widths)))


# ---------------------------------------------------------------- 命令

def cmd_add(args):
    check_ffmpeg()
    os.makedirs(args.batch, exist_ok=True)
    batch = load_batch(args.batch) if os.path.isfile(batch_path(args.batch)) else new_batch()
    if args.group and args.group not in batch["groups"]:
        batch["groups"][args.group] = dict(batch["groups"]["default"])

    for path in args.files:
        abspath = os.path.abspath(path)
        name = os.path.basename(abspath)
        if any(f["path"] == abspath for f in batch["files"]):
            print(f"跳过（已在批次中）: {name}")
            continue
        entry = {
            "id": next_id(batch),
            "path": abspath,
            "name": name,
            "group": args.group or "default",
            "status": "pending",
            "error": None,
            "analysis": None,
        }
        batch["files"].append(entry)
        try:
            entry["analysis"] = analyze_file(abspath)
            entry["status"] = "ok"
            a = entry["analysis"]
            print(f"[{entry['id']}] {name}: {fmt_loudness(a['integrated_lufs'])} LUFS, "
                  f"峰值 {fmt_peak(a['true_peak_dbfs'])} dBFS, {fmt_duration(a['duration'])}"
                  + (f"  ({'；'.join(a['flags'])})" if a["flags"] else ""))
        except RuntimeError as e:
            entry["status"] = "failed"
            entry["error"] = str(e)
            print(f"[{entry['id']}] {name}: 分析失败 - {e}（可用 retry 重试）")
    save_batch(args.batch, batch)


def cmd_retry(args):
    check_ffmpeg()
    batch = load_batch(args.batch)
    if args.refs:
        targets, missing = find_files(batch, args.refs)
        for m in missing:
            print(f"未找到文件: {m}")
    else:
        targets = [f for f in batch["files"] if f["status"] == "failed"]
    if not targets:
        print("没有需要重试的文件")
        return
    for f in targets:
        try:
            f["analysis"] = analyze_file(f["path"])
            f["status"] = "ok"
            f["error"] = None
            a = f["analysis"]
            print(f"[{f['id']}] {f['name']}: 重试成功 {fmt_loudness(a['integrated_lufs'])} LUFS")
        except RuntimeError as e:
            f["status"] = "failed"
            f["error"] = str(e)
            print(f"[{f['id']}] {f['name']}: 仍失败 - {e}")
    save_batch(args.batch, batch)


def cmd_list(args):
    batch = load_batch(args.batch)
    if not batch["files"]:
        print("批次为空")
        return
    rows = []
    for f in batch["files"]:
        if f["status"] == "ok":
            a = f["analysis"]
            tgt = group_target(batch, f["group"])
            dev = "--" if a["integrated_lufs"] is None else f"{a['integrated_lufs'] - tgt['target_lufs']:+.1f}"
            rows.append([
                f["id"], f["name"], f["group"],
                fmt_duration(a["duration"]),
                f"{a['channels']}ch" if a["channels"] else "?",
                fmt_loudness(a["integrated_lufs"]),
                fmt_peak(a["true_peak_dbfs"]),
                "--" if a["lra_lu"] is None else f"{a['lra_lu']:.1f}",
                dev,
                "；".join(a["flags"]) or "-",
            ])
        else:
            rows.append([f["id"], f["name"], f["group"], "-", "-", "-", "-", "-", "-",
                         f"分析失败: {f['error']}"])
    print_table(["ID", "文件", "组", "时长", "声道", "响度(LUFS)",
                 "真峰值(dBFS)", "LRA(LU)", "与目标差", "备注"], rows)
    print("\n目标设置:")
    for g, t in batch["groups"].items():
        n = sum(1 for f in batch["files"] if f["group"] == g)
        print(f"  {g}: {t['target_lufs']:+.1f} LUFS / 峰值上限 {t['peak_ceiling_dbfs']:.1f} dBFS  ({n} 个文件)")


def cmd_group(args):
    batch = load_batch(args.batch)
    if args.name not in batch["groups"]:
        batch["groups"][args.name] = dict(batch["groups"]["default"])
    targets, missing = find_files(batch, args.refs)
    for m in missing:
        print(f"未找到文件: {m}")
    for f in targets:
        f["group"] = args.name
        print(f"[{f['id']}] {f['name']} -> 组 '{args.name}'")
    save_batch(args.batch, batch)


def cmd_target(args):
    batch = load_batch(args.batch)
    g = batch["groups"].setdefault(args.group, dict(batch["groups"]["default"]))
    if args.lufs is not None:
        g["target_lufs"] = args.lufs
    if args.peak is not None:
        g["peak_ceiling_dbfs"] = args.peak
    save_batch(args.batch, batch)
    print(f"组 '{args.group}': 目标 {g['target_lufs']:+.1f} LUFS, "
          f"峰值上限 {g['peak_ceiling_dbfs']:.1f} dBFS")


def cmd_plan(args):
    print_plan(load_batch(args.batch))


def cmd_export(args):
    check_ffmpeg()
    batch = load_batch(args.batch)
    plan = build_plan(batch)
    if not plan:
        die("没有可导出的文件")

    clippers = [e for e in plan if e["will_clip"]]
    if clippers and not args.allow_clip:
        print("以下文件按当前目标校正会削波，已中止导出：")
        for e in clippers:
            print(f"  [{e['file']['id']}] {e['file']['name']}: {e['note']}")
        print("\n请降低对应组的目标响度（target 命令），或加 --allow-clip 强制导出")
        sys.exit(2)

    out_dir = os.path.abspath(args.out or os.path.join(args.batch, "export"))
    os.makedirs(out_dir, exist_ok=True)

    report_rows = []
    export_record = {"out_dir": out_dir, "files": []}
    for e in plan:
        f, a = e["file"], e["file"]["analysis"]
        tgt = group_target(batch, f["group"])
        row = {
            "id": f["id"], "file": f["name"], "group": f["group"],
            "duration_s": "" if a["duration"] is None else f"{a['duration']:.2f}",
            "channels": a["channels"] or "",
            "sample_rate": a["sample_rate"] or "",
            "source_integrated_lufs": "" if a["integrated_lufs"] is None else f"{a['integrated_lufs']:.2f}",
            "source_true_peak_dbfs": "" if a["true_peak_dbfs"] is None else f"{a['true_peak_dbfs']:.2f}",
            "source_lra_lu": "" if a["lra_lu"] is None else f"{a['lra_lu']:.2f}",
            "loudness_is_estimate": "yes" if a["loudness_is_estimate"] else "no",
            "flags": ";".join(a["flags"]),
            "target_lufs": f"{tgt['target_lufs']:.2f}",
            "peak_ceiling_dbfs": f"{tgt['peak_ceiling_dbfs']:.2f}",
            "gain_db": "", "output_file": "",
            "output_integrated_lufs": "", "output_true_peak_dbfs": "",
            "status": "", "note": e["note"],
        }
        stem = os.path.splitext(f["name"])[0]
        if e["gain_db"] is None:
            row["status"] = "skipped"
            row["note"] = row["note"] or "静音文件，未处理"
            print(f"[{f['id']}] {f['name']}: 跳过（{row['note']}）")
        else:
            out_name = f"{f['id']:03d}_{stem}_norm.wav"
            out_path = os.path.join(out_dir, out_name)
            code, out = run([
                "ffmpeg", "-y", "-hide_banner", "-nostats", "-i", f["path"],
                "-af", f"volume={e['gain_db']:.2f}dB",
                "-c:a", "pcm_s24le", out_path,
            ])
            if code != 0:
                row["status"] = "export_failed"
                row["note"] = out.strip().splitlines()[-1] if out.strip() else "ffmpeg 失败"
                print(f"[{f['id']}] {f['name']}: 导出失败 - {row['note']}")
            else:
                try:
                    oa = analyze_file(out_path)
                    row.update({
                        "gain_db": f"{e['gain_db']:+.2f}",
                        "output_file": out_name,
                        "output_integrated_lufs": "" if oa["integrated_lufs"] is None else f"{oa['integrated_lufs']:.2f}",
                        "output_true_peak_dbfs": "" if oa["true_peak_dbfs"] is None else f"{oa['true_peak_dbfs']:.2f}",
                        "status": "clipped" if e["will_clip"] else "ok",
                    })
                    print(f"[{f['id']}] {f['name']} -> {out_name}: "
                          f"{fmt_loudness(oa['integrated_lufs'])} LUFS, "
                          f"峰值 {fmt_peak(oa['true_peak_dbfs'])} dBFS"
                          + ("  (削波!)" if e["will_clip"] else ""))
                except RuntimeError as ex:
                    row["status"] = "verify_failed"
                    row["note"] = str(ex)
        report_rows.append(row)
        export_record["files"].append({"id": f["id"], "output": row["output_file"],
                                       "status": row["status"]})

    csv_path = os.path.join(out_dir, "report.csv")
    fields = ["id", "file", "group", "duration_s", "channels", "sample_rate",
              "source_integrated_lufs", "source_true_peak_dbfs", "source_lra_lu",
              "loudness_is_estimate", "flags", "target_lufs", "peak_ceiling_dbfs",
              "gain_db", "output_file", "output_integrated_lufs",
              "output_true_peak_dbfs", "status", "note"]
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as fp:
        writer = csv.DictWriter(fp, fieldnames=fields)
        writer.writeheader()
        writer.writerows(report_rows)

    batch["exports"].append(export_record)
    save_batch(args.batch, batch)
    ok = sum(1 for r in report_rows if r["status"] in ("ok", "clipped"))
    print(f"\n完成: {ok} 个文件导出到 {out_dir}，报告: {csv_path}")


# ---------------------------------------------------------------- 入口

def main():
    p = argparse.ArgumentParser(
        description="批量音频响度检查与校正工具（EBU R128，本地处理）")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_batch_arg(sp):
        sp.add_argument("batch", help="批次目录（状态保存在 <批次>/batch.json）")

    sp = sub.add_parser("add", help="导入音频并分析")
    add_batch_arg(sp)
    sp.add_argument("files", nargs="+", help="音频文件路径")
    sp.add_argument("--group", help="分配到指定文件组（默认 default）")
    sp.set_defaults(func=cmd_add)

    sp = sub.add_parser("retry", help="重试分析失败的文件")
    add_batch_arg(sp)
    sp.add_argument("refs", nargs="*", help="文件 ID 或文件名；省略则重试全部失败项")
    sp.set_defaults(func=cmd_retry)

    sp = sub.add_parser("list", help="查看批次分析结果")
    add_batch_arg(sp)
    sp.set_defaults(func=cmd_list)

    sp = sub.add_parser("group", help="把文件分配到组")
    add_batch_arg(sp)
    sp.add_argument("name", help="组名")
    sp.add_argument("refs", nargs="+", help="文件 ID 或文件名")
    sp.set_defaults(func=cmd_group)

    sp = sub.add_parser("target", help="设置组的目标响度/峰值上限")
    add_batch_arg(sp)
    sp.add_argument("--group", default="default", help="组名（默认 default）")
    sp.add_argument("--lufs", type=float, help="目标整体响度 (LUFS)")
    sp.add_argument("--peak", type=float, help="真峰值上限 (dBFS)")
    sp.set_defaults(func=cmd_target)

    sp = sub.add_parser("plan", help="预览校正增益与削波风险")
    add_batch_arg(sp)
    sp.set_defaults(func=cmd_plan)

    sp = sub.add_parser("export", help="导出校正版本和 CSV 报告")
    add_batch_arg(sp)
    sp.add_argument("--out", help="输出目录（默认 <批次>/export）")
    sp.add_argument("--allow-clip", action="store_true",
                    help="即使预测会削波也强制导出")
    sp.set_defaults(func=cmd_export)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
