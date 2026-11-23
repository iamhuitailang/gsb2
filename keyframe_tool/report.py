"""核对记录：一份人读的 Markdown 和一份机读 JSON。

记录必须覆盖：要求范围、成品首尾显示帧、声音覆盖范围、无法判断的地方，
以及源片的轨道起点与探测告警，方便事后复盘「为什么文件多了一截」。
"""

from __future__ import annotations

import datetime
import json
import os

from . import times
from .probe import ProbeResult

MODE_NAME = {"fast": "快速裁切（流复制）", "accurate": "逐帧精确裁切（重编码）"}


def _frame_brief(pr: ProbeResult, mapping: dict) -> str:
    if mapping.get("source_idx") is None:
        return f"无法判断（{mapping['detail']}）"
    f = pr.frames[mapping["source_idx"]]
    conf = {"exact": "精确匹配", "high": "高可信", "medium": "中等可信", "unknown": "无法判断"}
    amb = "，源内有重复画面" if mapping.get("ambiguous") else ""
    return (
        f"源片第 {f.idx} 帧 / 显示 {times.hms(f.display_time)}"
        f"（{conf.get(mapping['confidence'], mapping['confidence'])}{amb}，{mapping['detail']}）"
    )


def build_reports(
    pr: ProbeResult,
    plan_dict: dict,
    verify_data: dict,
    output_path: str,
) -> tuple[str, dict]:
    mode = plan_dict["mode"]
    out = verify_data["output"]
    now = datetime.datetime.now().isoformat(timespec="seconds")

    required = {
        "in_display": plan_dict["target_in_display"],
        "out_display": plan_dict["target_out_display"],
        "in_frame_idx": plan_dict["target_in_idx"],
        "out_frame_idx_exclusive": plan_dict["target_out_idx"],
    }
    machine = {
        "generated_at": now,
        "source": {
            "path": pr.path,
            "format_start_time": pr.format_start,
            "format_duration": pr.format_duration,
            "video": pr.video,
            "audio": pr.audio,
            "warnings": pr.warnings,
            "notes": pr.notes,
        },
        "mode": mode,
        "required_range": required,
        "planned_actual_range": {
            "in_display": plan_dict["actual_in_display"],
            "out_display": plan_dict["actual_out_display"],
            "in_frame_idx": plan_dict["actual_in_idx"],
            "out_frame_idx_exclusive": plan_dict["actual_out_idx"],
        },
        "plan_note": plan_dict["note"],
        "output_file": os.path.abspath(output_path),
        "readback": verify_data,
    }

    lines = [
        f"# 裁切核对记录（{MODE_NAME.get(mode, mode)}）",
        "",
        f"- 生成时间：{now}",
        f"- 源文件：`{pr.path}`",
        f"- 成品文件：`{os.path.abspath(output_path)}`",
        f"- 容器/轨道起点：{times.hms(pr.format_start)}（显示时间线已扣除该起点）",
        f"- 源片显示时长：{times.hms(pr.format_duration)}，共 {len(pr.frames)} 帧",
        "",
        "## 1. 要求范围（用户指定，显示时间）",
        f"- 入点：{times.hms(required['in_display'])}（第 {required['in_frame_idx']} 帧）",
        f"- 出点：{times.hms(required['out_display'])}（半开区间，到第 {required['out_frame_idx_exclusive']} 帧前）",
        f"- 计划说明：{plan_dict['note']}",
        "",
        "## 2. 计划实际取到的范围",
        f"- 计划首帧：第 {plan_dict['actual_in_idx']} 帧 / {times.hms(plan_dict['actual_in_display'])}",
        f"- 计划尾界：第 {plan_dict['actual_out_idx']} 帧前 / {times.hms(plan_dict['actual_out_display'])}",
        "",
        "## 3. 成品读回结果（以此为准）",
        f"- 成品帧数：{out['nb_frames']}",
        f"- 成品首帧显示时间：{times.hms(out['first_display'])}，尾帧显示时间：{times.hms(out['last_display'])}",
        f"- 首帧来源：{_frame_brief(pr, verify_data['first_frame'])}",
        f"- 尾帧来源：{_frame_brief(pr, verify_data['last_frame'])}",
    ]
    if verify_data["actual_start_display"] is not None:
        lead = verify_data["actual_start_display"] - required["in_display"]
        lines.append(
            f"- 实际起点 vs 要求入点：{times.ms(lead)}"
            + ("（快速裁切向前扩张的部分）" if lead < -1e-6 else "（与要求一致）" if abs(lead) <= 1e-6 else "")
        )
    else:
        lines.append("- 实际起点：无法判断（见第 5 节）")

    lines += ["", "## 4. 声音覆盖范围"]
    ar = verify_data["audio"]
    if ar["status"] == "none":
        lines.append(f"- {ar['detail']}")
    elif ar["status"] == "missing":
        lines.append(f"- ⚠️ {ar['detail']}")
    else:
        lines += [
            f"- 声音在源片时间线上的覆盖：{times.hms(ar['source_display_start'])} ~ {times.hms(ar['source_display_end'])}",
            f"- 头部缺口：{ar['head_gap_ms']:+.1f} ms；尾部缺口：{ar['tail_gap_ms']:+.1f} ms",
            f"- 结论：{ar['detail']}",
        ]

    lines += ["", "## 5. 无法判断 / 需人工确认的地方"]
    if verify_data["unknowns"]:
        lines += [f"- {u}" for u in verify_data["unknowns"]]
    else:
        lines.append("- 无：首尾帧与声音覆盖均已成功核对")

    if pr.warnings or pr.notes:
        lines += ["", "## 6. 源片探测告警与说明"]
        lines += [f"- ⚠️ {w}" for w in pr.warnings]
        lines += [f"- {n}" for n in pr.notes]

    lines.append("")
    return "\n".join(lines), machine


def write_reports(
    pr: ProbeResult,
    plan_dict: dict,
    verify_data: dict,
    output_path: str,
    report_base: str,
) -> tuple[str, str]:
    md, machine = build_reports(pr, plan_dict, verify_data, output_path)
    md_path, json_path = f"{report_base}.md", f"{report_base}.json"
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(md)
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(machine, f, ensure_ascii=False, indent=2)
    return md_path, json_path
