"""抢救执行层:扫描结果 -> 导出文件 + 文字/JSON 报告。"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path

from . import ffmpeg_wrap
from .scanner import (
    FRAG_BROKEN_MDAT,
    FRAG_BROKEN_MOOF,
    FRAG_COMPLETE,
    FRAG_MISSING_MDAT,
    ScanResult,
    scan,
)

STATUS_CN = {
    FRAG_COMPLETE: "完整",
    FRAG_BROKEN_MOOF: "断在分段说明 moof 内",
    FRAG_BROKEN_MDAT: "断在媒体数据 mdat 内",
    FRAG_MISSING_MDAT: "moof 完整但 mdat 缺失",
}

ISSUE_CN = {
    "ok": "正常",
    "gap": "掉段",
    "duplicate": "重复段",
    "unordered": "序号乱序",
}


@dataclass
class RescueOutcome:
    source: str
    accepted: bool
    reject_reason: str
    rescued_fmp4: str | None
    rescued_mp4: str | None
    report_txt: str
    report_json: str
    video_seconds_prefix: float
    audio_seconds_prefix: float
    audio_stop_note: str
    decode_ok: bool


def _fmt_time(seconds: float) -> str:
    return f"{seconds:.3f}s"


def build_text_report(result: ScanResult) -> str:
    lines: list[str] = []
    lines.append("=" * 72)
    lines.append(f"抢救报告: {result.path}")
    lines.append("=" * 72)
    lines.append(f"文件大小: {result.file_size} 字节; ftyp: {'有' if result.ftyp_present else '无'}"
                 f"; 分段结构(fMP4): {'是' if result.is_fragmented else '否'}")

    if not result.readable:
        lines.append("")
        lines.append(f"[拒绝修复] {result.reject_reason}")
        return "\n".join(lines) + "\n"

    # 轨道清单
    lines.append("")
    lines.append("轨道清单(moov/trex 声明):")
    for tid, meta in result.tracks.items():
        extra = ""
        if meta.kind == "video":
            extra = f", {meta.width:.0f}x{meta.height:.0f}"
        lines.append(
            f"  - 轨道 {tid}: {meta.kind}, timescale={meta.timescale}{extra}, "
            f"默认样本时长={meta.default_sample_duration}"
        )

    # 分段明细
    lines.append("")
    lines.append(f"分段明细(共 {len(result.fragments)} 个分段):")
    for frag in result.fragments:
        seq = "?" if frag.sequence_number is None else str(frag.sequence_number)
        head = (
            f"  分段 {frag.index:>2} [mfhd={seq:>2}] 字节 {frag.moof_offset}"
            f"~{frag.end_offset}  状态: {STATUS_CN.get(frag.status, frag.status)}"
        )
        lines.append(head)
        if frag.parse_note:
            lines.append(f"      断点说明: {frag.parse_note}")
        for run in frag.runs:
            kind = result.track_kind(run.track_id)
            meta = result.tracks.get(run.track_id)
            ts = meta.timescale if meta else 1
            start_s = run.cumulative_start / ts
            end_s = run.cumulative_end / ts
            local_s = run.tfdt / ts
            issue = f" [{ISSUE_CN.get(run.issue, run.issue)}: {run.issue_detail}]" if run.issue != "ok" else ""
            lines.append(
                f"      · {kind}(轨 {run.track_id}): 样本 {run.sample_count} 个, "
                f"全局播放 {_fmt_time(start_s)}~{_fmt_time(end_s)} "
                f"(本段 tfdt 相对 {_fmt_time(local_s)}), "
                f"占用 mdat {run.declared_data_size} 字节{issue}"
            )
        if frag.status == FRAG_BROKEN_MDAT and frag.mdat_available is not None:
            expected = frag.mdat_size - 8 if frag.mdat_size else 0
            lines.append(
                f"      数据缺口: mdat 声明 {expected} 字节,实际只剩 "
                f"{frag.mdat_available} 字节,缺 {max(0, expected - frag.mdat_available)} 字节"
            )

    # 连续性
    lines.append("")
    lines.append("连续性检查:")
    any_issue = False
    for tl in result.timelines.values():
        if tl.issues:
            any_issue = True
            for note in tl.issues:
                lines.append(f"  ! {result.track_kind(tl.track_id)}(轨 {tl.track_id}): {note}")
    if not any_issue:
        lines.append("  mfhd 序号严格连续,未发现掉段或重复段。")
    if result.trailing_bytes:
        lines.append(f"  文件尾部另有 {result.trailing_bytes} 个不成盒子的残余字节(忽略)。")

    # 导出计划
    lines.append("")
    lines.append("导出计划(连续前缀,不跨断点/缺口拼接):")
    lines.append(f"  可导出完整分段数: {result.export_fragment_count} / {len(result.fragments)}")
    lines.append(f"  导出字节范围: [0, {result.export_cut_offset}) / 共 {result.file_size} 字节")
    for tl in result.timelines.values():
        lines.append(
            f"  - {tl.kind}(轨 {tl.track_id}): 前缀可播放 {_fmt_time(tl.prefix_seconds)}"
            f", 文件内声明总跨度 {_fmt_time(tl.total_seconds)}"
        )
    return "\n".join(lines) + "\n"


def build_json_report(result: ScanResult) -> dict:
    payload = {
        "path": result.path,
        "file_size": result.file_size,
        "ftyp_present": result.ftyp_present,
        "is_fragmented": result.is_fragmented,
        "readable": result.readable,
        "reject_reason": result.reject_reason,
        "tracks": {
            str(tid): {
                "kind": m.kind,
                "timescale": m.timescale,
                "width": m.width,
                "height": m.height,
                "default_sample_duration": m.default_sample_duration,
            }
            for tid, m in result.tracks.items()
        },
        "fragments": [
            {
                "index": f.index,
                "sequence_number": f.sequence_number,
                "status": f.status,
                "moof_offset": f.moof_offset,
                "end_offset": f.end_offset,
                "mdat_available": f.mdat_available,
                "parse_note": f.parse_note,
                "runs": [
                    {
                        "track_id": r.track_id,
                        "kind": result.track_kind(r.track_id),
                        "tfdt": r.tfdt,
                        "sample_count": r.sample_count,
                        "span_media_time": r.span_media_time,
                        "declared_data_size": r.declared_data_size,
                        "issue": r.issue,
                        "issue_detail": r.issue_detail,
                    }
                    for r in f.runs
                ],
            }
            for f in result.fragments
        ],
        "timelines": {
            str(tid): {
                "kind": tl.kind,
                "timescale": tl.timescale,
                "total_seconds": round(tl.total_seconds, 6),
                "prefix_seconds": round(tl.prefix_seconds, 6),
                "issues": tl.issues,
            }
            for tid, tl in result.timelines.items()
        },
        "export": {
            "cut_offset": result.export_cut_offset,
            "fragment_count": result.export_fragment_count,
            "has_issues": result.has_issues,
        },
    }
    return payload


def rescue_file(
    source: Path,
    out_dir: Path,
    *,
    do_verify: bool = True,
) -> RescueOutcome:
    """抢救单个文件。任何异常都收敛成返回值,不向上抛(批量场景隔离用)。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = source.name.replace(" ", "_")
    report_txt = out_dir / f"{stem}.report.txt"
    report_json = out_dir / f"{stem}.report.json"

    try:
        data = source.read_bytes()
        result = scan(data, str(source))
    except OSError as exc:
        fail = RescueOutcome(
            source=str(source), accepted=False, reject_reason=f"读取失败: {exc}",
            rescued_fmp4=None, rescued_mp4=None,
            report_txt=str(report_txt), report_json=str(report_json),
            video_seconds_prefix=0.0, audio_seconds_prefix=0.0,
            audio_stop_note="", decode_ok=False,
        )
        report_txt.write_text(f"[拒绝修复] {fail.reject_reason}\n", encoding="utf-8")
        report_json.write_text(json.dumps(asdict(fail), ensure_ascii=False, indent=2), encoding="utf-8")
        return fail

    text_report = build_text_report(result)
    report_json.write_text(
        json.dumps(build_json_report(result), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    if not result.readable or result.export_fragment_count == 0:
        if result.readable and result.export_fragment_count == 0:
            text_report += "\n[拒绝修复] 没有任何完整可导出的分段。\n"
        report_txt.write_text(text_report, encoding="utf-8")
        return RescueOutcome(
            source=str(source), accepted=False, reject_reason=result.reject_reason or "无完整分段",
            rescued_fmp4=None, rescued_mp4=None,
            report_txt=str(report_txt), report_json=str(report_json),
            video_seconds_prefix=0.0, audio_seconds_prefix=0.0,
            audio_stop_note="", decode_ok=False,
        )

    # 1) 切出连续前缀,先存为 .rescued.fmp4(仍是 fMP4 字节流)
    prefix = data[:result.export_cut_offset]
    fmp4_path = out_dir / f"{stem}.rescued.fmp4"
    mp4_path = out_dir / f"{stem}.rescued.mp4"
    fmp4_path.write_bytes(prefix)

    # 2) 重封装为普通 MP4
    ffmpeg_wrap.remux_to_mp4(str(fmp4_path), str(mp4_path))

    # 3) 解码校验 + 音视频实际停点
    decode_ok = True
    extra_notes: list[str] = []
    if do_verify:
        report = ffmpeg_wrap.verify_decodable(str(fmp4_path), is_fmp4=True)
        decode_ok = report.ok
        if report.errors:
            extra_notes.append("ffmpeg 解码告警: " + "; ".join(report.errors[:5]))

    video_tl = next((t for t in result.timelines.values() if t.kind == "video"), None)
    audio_tl = next((t for t in result.timelines.values() if t.kind == "audio"), None)
    v_sec = video_tl.prefix_seconds if video_tl else 0.0
    a_sec = audio_tl.prefix_seconds if audio_tl else 0.0

    audio_note = ""
    if audio_tl is not None:
        try:
            got_samples, rate = ffmpeg_wrap.count_audio_samples(str(fmp4_path), is_fmp4=True)
            actual_a_sec = got_samples / rate if rate else a_sec
            # 0.15s 阈值用来排除 AAC priming(~0.02s)与帧封装造成的固有短差,
            # 真正少一截(缺整段/整帧)的差量远大于此
            if video_tl is not None and actual_a_sec + 0.15 < v_sec:
                audio_note = (
                    f"音频比视频早停(疑似音频缺帧/缺段): 视频到 {_fmt_time(v_sec)}, "
                    f"音频实际停点约 {_fmt_time(actual_a_sec)}(解码 {got_samples} 样本 @ {rate}Hz); "
                    f"差异 {_fmt_time(v_sec - actual_a_sec)} 已超出 AAC 封装固有延迟"
                )
            else:
                audio_note = (
                    f"音频实际停点约 {_fmt_time(actual_a_sec)}(解码 {got_samples} 样本 @ {rate}Hz,"
                    f"与视频差 {_fmt_time(max(0.0, v_sec - actual_a_sec))},属编码器封装正常范围)"
                )
        except ffmpeg_wrap.FfmpegError as exc:
            audio_note = f"音频停点无法测量: {exc}"

    if audio_note:
        extra_notes.append(audio_note)
    if extra_notes:
        text_report += "\n停点与校验:\n" + "\n".join(f"  {n}" for n in extra_notes) + "\n"
    text_report += (
        f"\n导出完成: {mp4_path.name}(普通 MP4) / {fmp4_path.name}(抢救前缀原字节)\n"
        f"解码校验: {'通过' if decode_ok else '存在告警,见上'}\n"
    )
    report_txt.write_text(text_report, encoding="utf-8")

    return RescueOutcome(
        source=str(source), accepted=True, reject_reason="",
        rescued_fmp4=str(fmp4_path), rescued_mp4=str(mp4_path),
        report_txt=str(report_txt), report_json=str(report_json),
        video_seconds_prefix=round(v_sec, 3),
        audio_seconds_prefix=round(a_sec, 3),
        audio_stop_note=audio_note, decode_ok=decode_ok,
    )


def rescue_batch(sources: list[Path], out_dir: Path, *, do_verify: bool = True) -> list[RescueOutcome]:
    """批量抢救:单个文件失败不影响其它文件,每份独立出报告。"""
    outcomes: list[RescueOutcome] = []
    for source in sources:
        try:
            outcome = rescue_file(source, out_dir, do_verify=do_verify)
        except Exception as exc:  # 兜底:批量任务绝不因单文件异常中断
            outcome = RescueOutcome(
                source=str(source), accepted=False,
                reject_reason=f"工具内部异常(已隔离,不影响其它文件): {type(exc).__name__}: {exc}",
                rescued_fmp4=None, rescued_mp4=None,
                report_txt="", report_json="",
                video_seconds_prefix=0.0, audio_seconds_prefix=0.0,
                audio_stop_note="", decode_ok=False,
            )
        outcomes.append(outcome)
    return outcomes
