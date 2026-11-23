"""分段索引与结果报告导出。

- 索引 CSV：每个分段一行，列出源时间范围、序号、实际首帧与实测时长；
- 报告 JSON：比对 + 核验的完整结构化结果（供再次打开/机器处理）；
- 报告 Markdown：人读版，问题按类别分组，附共享边界表。
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

from .compare import CompareReport
from .verify import VerifyReport

KIND_TITLE = {
    "boundary_mismatch": "边界不重合",
    "missing_segment": "片段缺失",
    "unreadable": "索引存在但文件打不开",
    "duration_drift": "时长漂移",
    "first_frame_changed": "首帧被改动",
    "gap": "档内衔接断裂",
    "missing": "文件缺失",
}


def export_index_csv(manifest: dict, out_path: str | Path) -> Path:
    out = Path(out_path)
    fields = [
        "tier", "seq", "file", "source_start", "source_end",
        "planned_duration", "actual_duration", "frame_label",
        "global_frame", "openable", "error",
    ]
    with out.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        for tier in manifest["tiers"]:
            for s in tier["segments"]:
                writer.writerow({
                    "tier": tier["name"],
                    "seq": s["seq"],
                    "file": s["file"],
                    "source_start": f"{s['source_start']:.3f}",
                    "source_end": f"{s['source_end']:.3f}",
                    "planned_duration": f"{s['planned_duration']:.3f}",
                    "actual_duration": f"{s['actual_duration']:.3f}",
                    "frame_label": s.get("frame_label", ""),
                    "global_frame": s.get("global_frame", ""),
                    "openable": s.get("openable", True),
                    "error": s.get("error") or "",
                })
    return out


def export_report_json(
    manifest: dict,
    comparison: CompareReport,
    verification: VerifyReport,
    out_path: str | Path,
) -> Path:
    out = Path(out_path)
    payload = {
        "manifest_summary": {
            "schema_version": manifest.get("schema_version"),
            "source_duration": manifest.get("source_duration"),
            "source_fps": manifest.get("source_fps"),
            "tiers": [t["name"] for t in manifest.get("tiers", [])],
            "audio_track": manifest.get("audio_track"),
        },
        "comparison": comparison.to_dict(),
        "verification": verification.to_dict(),
    }
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return out


def export_report_markdown(
    manifest: dict,
    comparison: CompareReport,
    verification: VerifyReport,
    out_path: str | Path,
) -> Path:
    out = Path(out_path)
    lines: list[str] = []
    lines.append("# 分段对齐报告")
    lines.append("")
    lines.append(f"- 源总时长: {manifest.get('source_duration', 0):.3f}s，帧率: {manifest.get('source_fps')} fps")
    lines.append(f"- 档位: {', '.join(t['name'] for t in manifest.get('tiers', []))}")
    lines.append(f"- 连续音轨: {manifest.get('audio_track') or '无'}")
    lines.append(f"- 比对问题数: {len(comparison.issues)}；核验异常: {verification.summary()}")
    lines.append("")

    lines.append("## 横向比对问题")
    if not comparison.issues:
        lines.append("无：两档边界重合、覆盖完整、文件均可读。")
    for issue in comparison.issues:
        lines.append(
            f"- **{KIND_TITLE.get(issue.kind, issue.kind)}** "
            f"({issue.tier or '跨档'})：{issue.detail}"
        )
    lines.append("")

    lines.append("## 共享边界与实际首帧")
    lines.append("| 源时间(s) | " + " | ".join(comparison.tier_names) + " | 对齐 |")
    lines.append("|---|" + "|".join(["---"] * len(comparison.tier_names)) + "---|")
    for b in comparison.boundaries:
        cells = " | ".join(b.per_tier_frame_label.get(n) or "—" for n in comparison.tier_names)
        lines.append(f"| {b.source_time:.3f} | {cells} | {'✓' if b.aligned else '✗'} |")
    lines.append("")

    lines.append("## 重新打开后的实读核验")
    lines.append(f"- 音轨: {verification.audio_status} — {verification.audio_detail}")
    bad = [c for c in verification.checks if c.status != "ok"]
    if not bad:
        lines.append("- 全部分段实测时长与首帧哈希均与索引一致。")
    for c in bad:
        lines.append(
            f"- **{KIND_TITLE.get(c.status, c.status)}** "
            f"[{c.tier} #{c.seq} {c.file}] {c.detail}"
        )
    lines.append("")

    lines.append("## 分段索引明细")
    for tier in manifest.get("tiers", []):
        lines.append(f"### {tier['name']} ({tier['width']}x{tier['height']})")
        lines.append("| 序号 | 源起(s) | 源止(s) | 计划时长 | 实测时长 | 实际首帧 |")
        lines.append("|---|---|---|---|---|---|")
        for s in tier["segments"]:
            lines.append(
                f"| {s['seq']} | {s['source_start']:.3f} | {s['source_end']:.3f} "
                f"| {s['planned_duration']:.3f} | {s['actual_duration']:.3f} "
                f"| {s.get('frame_label', '')} |"
            )
        lines.append("")

    out.write_text("\n".join(lines), encoding="utf-8")
    return out
