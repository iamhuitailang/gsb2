"""端到端自测：生成素材 -> 探测 -> 两种裁切 -> 读回核对。

覆盖需求里的关键结论：
1. 入点落在关键帧上：快速裁切首帧 == 指定帧，不多内容；
2. 入点落在两关键帧之间：快速裁切首帧回退到前一个关键帧，精确裁切不回退；
3. 有声音 / 无声音素材都能裁；
4. 非零轨道起点素材：入点切中间，实际首帧不被源轨起点二次偏移；
5. 空区间 / 过短区间 / 读不全文件有明确报错。
"""

from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from keyframe_tool import cuts, genmedia, probe, report, verify  # noqa: E402
from keyframe_tool.ffmpeg_utils import FFmpegError  # noqa: E402

PASS, FAIL = "✅ 通过", "❌ 失败"
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{PASS if ok else FAIL} {name}" + (f" — {detail}" if detail else ""))


def run_selftest() -> int:
    workdir = tempfile.mkdtemp(prefix="kfcut_selftest_")
    sample_dir = os.path.join(workdir, "samples")
    out_dir = os.path.join(workdir, "outputs")
    print(f"工作目录: {workdir}\n")

    # ---------- 1. 生成素材 ----------
    manifest = genmedia.generate(sample_dir)
    sound = os.path.join(sample_dir, "sample_sound.mp4")
    silent = os.path.join(sample_dir, "sample_silent.mp4")
    offset = os.path.join(sample_dir, "sample_offset.mp4")
    check("生成 3 个测试素材", all(os.path.isfile(p) for p in (sound, silent, offset)))

    pr = probe.probe_media(sound)
    check(
        "关键帧间隔长短不一且与设计一致",
        [f.idx for f in pr.frames if f.is_keyframe] == manifest["keyframe_indices"],
        f"实际关键帧 {[f.idx for f in pr.frames if f.is_keyframe]}",
    )
    check("素材含重排帧(B帧)且按显示顺序排列", pr.video["reorder_detected"],
          f"帧序 0..{len(pr.frames) - 1} 单调递增"
          if all(pr.frames[i].display_time < pr.frames[i + 1].display_time
                 for i in range(len(pr.frames) - 1)) else "帧序异常")
    check("帧号素材逐帧哈希可用", pr.has_hash)
    check("提示音素材检测到音轨", pr.audio is not None)

    pr_silent = probe.probe_media(silent)
    check("无声音素材正确识别为无音轨", pr_silent.audio is None)

    pr_off = probe.probe_media(offset)
    check("偏移素材容器起点约为 1.300s（容器封装有量化误差）",
          abs(pr_off.format_start - genmedia.OFFSET_SECONDS) < 0.05,
          f"start_time={pr_off.format_start:.3f}")

    def do_cut(pr_obj: probe.ProbeResult, mode: str, in_t: float, out_t: float, tag: str):
        plan = cuts.build_plan(pr_obj, mode, in_t, out_t)
        out_path = os.path.join(out_dir, f"{tag}_{mode}.mp4")
        cuts.execute(pr_obj, plan, out_path)
        v = verify.verify_cut(pr_obj, plan.to_dict(), out_path)
        md, js = report.write_reports(pr_obj, plan.to_dict(), v, out_path,
                                      os.path.join(out_dir, f"{tag}_{mode}_report"))
        return plan, v, out_path, md, js

    # ---------- 2. 入点在两关键帧之间（有声音素材）----------
    kf = manifest["keyframe_indices"]
    mid_idx = (kf[0] + kf[1]) // 2          # 落在第 1、2 个关键帧之间
    in_t = pr.frames[mid_idx].display_time
    # 最后一个保留帧（半开区间的出点帧）；目标成品为 [mid_idx, out_idx]
    out_idx = min(kf[2] + 7, len(pr.frames) - 2)
    # 出点给该帧结束时刻（落在帧边界），验证吸附归属前一帧而非跳到下一帧
    out_f = pr.frames[out_idx]
    out_t = out_f.display_time + out_f.duration

    plan_fast, v_fast, _, md_fast, _ = do_cut(pr, "fast", in_t, out_t, "mid")
    plan_acc, v_acc, _, md_acc, _ = do_cut(pr, "accurate", in_t, out_t, "mid")

    check(
        "中间入点：快速裁切首帧回退到前一个关键帧",
        v_fast["first_frame"]["source_idx"] == kf[0] and plan_fast.actual_in_idx == kf[0],
        f"指定 #{mid_idx}，实际首帧 #{v_fast['first_frame']['source_idx']}",
    )
    check(
        "中间入点：快速裁切确实多出一截",
        v_fast["actual_start_display"] is not None
        and v_fast["actual_start_display"] + 1e-6 < plan_fast.target_in_display,
        f"提前 {(plan_fast.target_in_display - (v_fast['actual_start_display'] or 0)) * 1000:.1f} ms",
    )
    check(
        "中间入点：精确裁切首帧就是指定帧",
        v_acc["first_frame"]["source_idx"] == mid_idx
        and abs(v_acc["first_frame"]["delta_vs_target_ms"]) < 0.1,
        f"映射 #{v_acc['first_frame']['source_idx']}，置信度 {v_acc['first_frame']['confidence']}",
    )
    check("精确裁切尾帧命中指定尾帧",
          v_acc["last_frame"]["source_idx"] == out_idx
          and abs(v_acc["last_frame"]["delta_vs_target_ms"]) < 0.1,
          f"映射 #{v_acc['last_frame']['source_idx']}，置信度 {v_acc['last_frame']['confidence']}，"
          f"{v_acc['last_frame']['detail']}")
    check("两份核对记录均已落盘", os.path.isfile(md_fast) and os.path.isfile(md_acc))

    ar = v_acc["audio"]
    check(
        "有声音素材：声音覆盖到要求区间",
        ar["status"] == "ok" and abs(ar["head_gap_ms"]) < 60 and ar["tail_gap_ms"] >= -60,
        f"头缺口 {ar['head_gap_ms']} ms / 尾缺口 {ar['tail_gap_ms']} ms",
    )

    # ---------- 3. 入点正好在关键帧上 ----------
    key_idx = kf[2]
    in_t2 = pr.frames[key_idx].display_time
    plan_kf, v_kf, _, _, _ = do_cut(pr, "fast", in_t2, out_t, "onkey")
    check(
        "关键帧入点：快速裁切首帧 == 指定帧，不多内容",
        v_kf["first_frame"]["source_idx"] == key_idx
        and abs(v_kf["actual_start_display"] - in_t2) < 1e-6,
        f"首帧 #{v_kf['first_frame']['source_idx']}",
    )

    # ---------- 4. 无声音素材两种模式都能裁 ----------
    in_s = pr_silent.frames[mid_idx].display_time
    out_s_f = pr_silent.frames[out_idx]
    out_s = out_s_f.display_time + out_s_f.duration
    _, v_s_fast, _, _, _ = do_cut(pr_silent, "fast", in_s, out_s, "silent")
    _, v_s_acc, _, _, _ = do_cut(pr_silent, "accurate", in_s, out_s, "silent")
    check("无声音快速裁切成功且成品无音轨",
          v_s_fast["output"]["audio"] is None and v_s_fast["output"]["nb_frames"] > 1)
    check("无声音精确裁切成功且首帧命中",
          v_s_acc["first_frame"]["source_idx"] == mid_idx
          and v_s_acc["audio"]["status"] == "none")

    # ---------- 5. 非零轨道起点：入点切中间，起点不被二次偏移 ----------
    mid_off = (kf[1] + kf[2]) // 2
    in_o = pr_off.frames[mid_off].display_time
    out_o_f = pr_off.frames[min(kf[3] + 3, len(pr_off.frames) - 2)]
    out_o = out_o_f.display_time + out_o_f.duration
    plan_o, v_o, _, _, _ = do_cut(pr_off, "accurate", in_o, out_o, "offset")
    expect_start = pr_off.frames[mid_off].display_time
    ok_off = (
        v_o["first_frame"]["source_idx"] == mid_off
        and abs((v_o["actual_start_display"] or 0) - expect_start) < 1e-6
        and abs(v_o["output"]["first_display"]) < 0.05  # 成品时间线仍从 0 开始
    )
    check("偏移素材精确裁切：首帧命中且未把 1.3s 起点二次计入", ok_off,
          f"源首帧 #{v_o['first_frame']['source_idx']}，成品首显示 {v_o['output']['first_display']:.3f}s")
    plan_o_fast, v_o_fast, _, _, _ = do_cut(pr_off, "fast", in_o, out_o, "offset")
    check("偏移素材快速裁切：回退到关键帧而非回退到 1.3s 之前",
          v_o_fast["first_frame"]["source_idx"] == kf[1],
          f"首帧 #{v_o_fast['first_frame']['source_idx']}，期望 #{kf[1]}")

    # 入点就在第一个关键帧 #0：seek epsilon 不能越过下一个关键帧 #30
    in_first = pr_off.frames[0].display_time
    out_first_f = pr_off.frames[60]
    plan_first = cuts.build_plan(pr_off, "fast", in_first,
                                 out_first_f.display_time + out_first_f.duration)
    check("首个 GOP 的 seek epsilon 不越过下一关键帧",
          plan_first.seek_epsilon > 0
          and in_first + plan_first.seek_epsilon < pr_off.frames[kf[1]].display_time,
          f"epsilon={plan_first.seek_epsilon:.3f}s")
    _, v_first, _, _, _ = do_cut(pr_off, "fast", in_first,
                                 out_first_f.display_time + out_first_f.duration, "offfirst")
    check("偏移素材从首关键帧快速裁切仍以 #0 开头",
          v_first["first_frame"]["source_idx"] == 0,
          f"首帧 #{v_first['first_frame']['source_idx']}")

    # ---------- 6. 异常区间反馈 ----------
    def expect_error(mode, a, b, label):
        try:
            cuts.build_plan(pr, mode, a, b)
            check(label, False, "未报错")
        except cuts.CutValidationError as exc:
            check(label, True, str(exc)[:60])

    expect_error("fast", in_t, in_t, "空区间（入出点同帧）被拒绝")
    tiny = pr.frames[mid_idx].display_time
    expect_error("accurate", tiny, tiny, "零长度区间被拒绝")
    expect_error("fast", -1.0, 2.0, "负时间被拒绝")
    expect_error("fast", 5.0, 1.0, "出点早于入点被拒绝")
    expect_error("fast", in_t, pr.frames[-1].display_time + pr.frames[-1].duration + 5,
                 "超出素材时长被拒绝")

    # ---------- 7. 读不全 / 损坏文件反馈 ----------
    broken = os.path.join(workdir, "broken.mp4")
    with open(broken, "wb") as f:
        f.write(b"not a real media file" * 20)
    try:
        probe.probe_media(broken)
        check("损坏文件被明确报错", False)
    except FFmpegError as exc:
        check("损坏文件被明确报错", True, str(exc).splitlines()[0][:60])

    missing = os.path.join(workdir, "no_such.mp4")
    try:
        probe.probe_media(missing)
        check("缺失文件被明确报错", False)
    except FFmpegError as exc:
        check("缺失文件被明确报错", True, str(exc)[:60])

    # ---------- 汇总 ----------
    total, passed = len(results), sum(1 for _, ok, _ in results if ok)
    print(f"\n自测汇总：{passed}/{total} 通过")
    if passed != total:
        print("失败项：")
        for name, ok, detail in results:
            if not ok:
                print(f"  - {name}: {detail}")
    print(f"\n成品与核对记录保留在: {out_dir}")
    return 0 if passed == total else 1
