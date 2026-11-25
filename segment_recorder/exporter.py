from __future__ import annotations

import html
import json
import shutil
from pathlib import Path
from datetime import timedelta
from typing import Any

from . import media
from .playlist import parse_playlist
from .storage import Store
from .util import (
    clock_range,
    ensure_dir,
    format_clock,
    format_duration,
    now_iso,
    parse_iso,
    safe_filename,
    seconds_to_vtt_timestamp,
    sha256_file,
)


# ----------------------------------------------------------------------
# Analysis: continuous ranges and gaps
# ----------------------------------------------------------------------

def _segment_start(segment: dict[str, Any]):
    return parse_iso(segment.get("planned_at")) or parse_iso(segment.get("first_seen_at"))


def _segment_end(segment: dict[str, Any]):
    start = _segment_start(segment)
    if start is None:
        return None
    return start + timedelta(seconds=_duration_seconds(segment))


def _duration_seconds(segment: dict[str, Any]) -> float:
    try:
        value = float(segment.get("duration") or 0.0)
    except (TypeError, ValueError):
        value = 0.0
    if value > 0:
        return value
    probed = media.probe_duration(segment.get("archive_path", ""))
    return probed or 0.0


def build_analysis(store: Store) -> dict[str, Any]:
    segments = [dict(row) for row in store.saved_segments()]
    for segment in segments:
        segment["duration"] = _duration_seconds(segment)
        segment["start_iso"] = (_segment_start(segment).isoformat(timespec="seconds")
                                if _segment_start(segment) else None)
        segment["end_iso"] = (_segment_end(segment).isoformat(timespec="seconds")
                              if _segment_end(segment) else None)
        segment["archive_exists"] = bool(
            segment.get("archive_path") and Path(segment["archive_path"]).exists()
        )

    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for segment in segments:
        key = (segment.get("stream_id") or "local", segment["epoch_id"])
        groups.setdefault(key, []).append(segment)

    epoch_summaries: list[dict[str, Any]] = []
    all_ranges: list[dict[str, Any]] = []
    all_gaps: list[dict[str, Any]] = []
    range_number = 0

    ordered_keys = sorted(
        groups,
        key=lambda key: (
            min(
                (s.get("epoch_index") if s.get("epoch_index") is not None else 10**9)
                for s in groups[key]
            ),
            min(_segment_start(s) or parse_iso(now_iso()) for s in groups[key]),
        ),
    )

    for key in ordered_keys:
        stream_id, epoch_id = key
        items = groups[key]
        epoch_index = min((s.get("epoch_index") or 10**9) for s in items)
        by_sequence: dict[int, list[dict[str, Any]]] = {}
        for item in items:
            by_sequence.setdefault(int(item["sequence"]), []).append(item)

        primary: list[dict[str, Any]] = []
        duplicate_revisions: list[dict[str, Any]] = []
        for sequence in sorted(by_sequence):
            revisions = sorted(
                by_sequence[sequence],
                key=lambda s: (s.get("completed_at") or "", s["id"]),
            )
            primary.append(revisions[0])
            duplicate_revisions.extend(revisions[1:])

        primary.sort(key=lambda s: int(s["sequence"]))
        runs: list[list[dict[str, Any]]] = []
        current: list[dict[str, Any]] = []
        for segment in primary:
            if not current or int(segment["sequence"]) == int(current[-1]["sequence"]) + 1:
                current.append(segment)
            else:
                runs.append(current)
                current = [segment]
        if current:
            runs.append(current)

        epoch_start = min((_segment_start(s) for s in primary if _segment_start(s)), default=None)
        epoch_end = max((_segment_end(s) for s in primary if _segment_end(s)), default=None)
        epoch_summaries.append(
            {
                "stream_id": stream_id,
                "epoch_id": epoch_id,
                "epoch_index": epoch_index if epoch_index != 10**9 else None,
                "segment_count": len(items),
                "primary_sequence_count": len(primary),
                "duplicate_revision_count": len(duplicate_revisions),
                "start": epoch_start.isoformat(timespec="seconds") if epoch_start else None,
                "end": epoch_end.isoformat(timespec="seconds") if epoch_end else None,
            }
        )

        for run in runs:
            range_number += 1
            start_seq = int(run[0]["sequence"])
            end_seq = int(run[-1]["sequence"])
            range_id = safe_filename(
                f"range{range_number:02d}_e{epoch_index:04d}_{start_seq:04d}-{end_seq:04d}"
            )
            total_duration = sum(float(s["duration"]) for s in run)
            start_time = _segment_start(run[0])
            end_time = _segment_end(run[-1])
            cumulative = 0.0
            for segment in run:
                segment["cumulative_start"] = cumulative
                cumulative += float(segment["duration"])
                segment["cumulative_end"] = cumulative

            all_ranges.append(
                {
                    "number": range_number,
                    "id": range_id,
                    "stream_id": stream_id,
                    "epoch_id": epoch_id,
                    "epoch_index": epoch_index if epoch_index != 10**9 else None,
                    "start_sequence": start_seq,
                    "end_sequence": end_seq,
                    "segment_count": len(run),
                    "segments": run,
                    "duration_sec": total_duration,
                    "timeline_span_sec": (
                        (end_time - start_time).total_seconds()
                        if start_time and end_time
                        else total_duration
                    ),
                    "start_iso": start_time.isoformat(timespec="seconds") if start_time else None,
                    "end_iso": end_time.isoformat(timespec="seconds") if end_time else None,
                    "duplicate_revisions": [
                        s for s in duplicate_revisions
                        if int(s["sequence"]) >= start_seq and int(s["sequence"]) <= end_seq
                    ],
                }
            )

        for previous_run, next_run in zip(runs, runs[1:]):
            before = previous_run[-1]
            after = next_run[0]
            before_seq = int(before["sequence"])
            after_seq = int(after["sequence"])
            missing = list(range(before_seq + 1, after_seq))
            gap_start = _segment_end(before)
            gap_end = _segment_start(after)
            all_gaps.append(
                {
                    "type": "missing-sequence",
                    "status": "永久空缺（迟到段未补入）",
                    "epoch_id": epoch_id,
                    "epoch_index": epoch_index if epoch_index != 10**9 else None,
                    "after_sequence": before_seq,
                    "before_sequence": after_seq,
                    "missing_sequences": missing,
                    "start_iso": gap_start.isoformat(timespec="seconds") if gap_start else None,
                    "end_iso": gap_end.isoformat(timespec="seconds") if gap_end else None,
                    "wall_duration_sec": (
                        (gap_end - gap_start).total_seconds()
                        if gap_start and gap_end
                        else len(missing) * 0.0
                    ),
                    "expected_duration_sec": len(missing)
                    * float(before.get("duration") or after.get("duration") or 0.0),
                    "note": "同一 epoch 中序号不连续；若迟到段之后补入，相邻区间会自动合并。",
                }
            )

        # 迟到但最终补入的段：最终区间已经连续，仍保留曾经空缺/补入的时间证据。
        for index, segment in enumerate(primary):
            seq = int(segment["sequence"])
            higher = next((item for item in primary if int(item["sequence"]) > seq), None)
            if higher is None:
                continue
            seen_at = parse_iso(segment.get("first_seen_at"))
            higher_seen_at = parse_iso(higher.get("first_seen_at"))
            seen_later_by_clock = bool(seen_at and higher_seen_at and seen_at > higher_seen_at)
            # 快速自动化测试里多个事件可能落在同一秒，自增 id 能保留真实发现顺序。
            seen_later_by_id = int(segment["id"]) > int(higher["id"])
            if not (seen_later_by_clock or seen_later_by_id):
                continue

            previous = primary[index - 1] if index > 0 and int(primary[index - 1]["sequence"]) == seq - 1 else None
            scheduled_start = _segment_end(previous) if previous else _segment_start(segment)
            scheduled_end = _segment_start(higher)
            all_gaps.append(
                {
                    "type": "late-filled",
                    "status": "迟到段已补入，连续区间已合并",
                    "epoch_id": epoch_id,
                    "epoch_index": epoch_index if epoch_index != 10**9 else None,
                    "after_sequence": seq - 1,
                    "before_sequence": int(higher["sequence"]),
                    "missing_sequences": [seq],
                    "start_iso": scheduled_start.isoformat(timespec="seconds") if scheduled_start else None,
                    "end_iso": scheduled_end.isoformat(timespec="seconds") if scheduled_end else None,
                    "wall_duration_sec": (
                        (scheduled_end - scheduled_start).total_seconds()
                        if scheduled_start and scheduled_end
                        else float(segment.get("duration") or 0.0)
                    ),
                    "observed_start_iso": higher.get("first_seen_at"),
                    "observed_end_iso": segment.get("first_seen_at"),
                    "observed_duration_sec": (
                        max(0.0, (seen_at - higher_seen_at).total_seconds())
                        if seen_at and higher_seen_at
                        else 0.0
                    ),
                    "expected_duration_sec": float(segment.get("duration") or 0.0),
                    "note": (
                        f"收录端先看到 seq {int(higher['sequence']):04d}，"
                        f"之后才第一次看到 seq {seq:04d}；缺口已被该迟到段填补。"
                    ),
                }
            )

    # Epoch/轮次边界：序号归零不是中间段缺失，而是新一轮内容。
    for previous_epoch, next_epoch in zip(epoch_summaries, epoch_summaries[1:]):
        gap_start = parse_iso(previous_epoch.get("end"))
        gap_end = parse_iso(next_epoch.get("start"))
        all_gaps.append(
            {
                "type": "epoch-restart",
                "status": "断档后序号重新开始",
                "epoch_id": f"{previous_epoch['epoch_id']} → {next_epoch['epoch_id']}",
                "epoch_index": next_epoch.get("epoch_index"),
                "after_sequence": None,
                "before_sequence": None,
                "missing_sequences": [],
                "start_iso": gap_start.isoformat(timespec="seconds") if gap_start else None,
                "end_iso": gap_end.isoformat(timespec="seconds") if gap_end else None,
                "wall_duration_sec": (
                    (gap_end - gap_start).total_seconds() if gap_start and gap_end else 0.0
                ),
                "expected_duration_sec": None,
                "note": "两个 epoch 的 0000 序号可能对应不同内容；归档按 SHA-256 分开保存，不覆盖。",
            }
        )

    all_gaps.sort(key=lambda gap: gap.get("start_iso") or "")
    return {
        "exported_at": now_iso(),
        "segments": segments,
        "epochs": epoch_summaries,
        "ranges": all_ranges,
        "gaps": all_gaps,
    }


# ----------------------------------------------------------------------
# Export
# ----------------------------------------------------------------------

def _write_range_playlist(range_dir: Path, item: dict[str, Any]) -> Path:
    target_duration = max(1, int(max((s["duration"] for s in item["segments"]), default=1) + 0.999))
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:6",
        f"#EXT-X-TARGETDURATION:{target_duration}",
        f"#EXT-X-MEDIA-SEQUENCE:{item['start_sequence']}",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXT-X-INDEPENDENT-SEGMENTS",
    ]
    for segment in item["segments"]:
        lines.extend(
            [
                f"#EXT-X-PROGRAM-DATE-TIME:{segment.get('start_iso') or now_iso()}",
                f"#EXTINF:{float(segment['duration']):.3f},{segment['epoch_id']} seq {segment['sequence']}",
                segment["export_uri"],
            ]
        )
    lines.append("#EXT-X-ENDLIST")
    path = range_dir / "playlist.m3u8"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def _write_vtt(range_dir: Path, item: dict[str, Any]) -> Path:
    lines = ["WEBVTT", ""]
    for segment in item["segments"]:
        start = seconds_to_vtt_timestamp(segment["cumulative_start"])
        end = seconds_to_vtt_timestamp(segment["cumulative_end"])
        lines.append(f"{start} --> {end}")
        lines.append(
            f"{segment['epoch_id']} / seq {segment['sequence']:04d} / "
            f"{format_clock(segment.get('start_iso'))}"
        )
        lines.append("")
    path = range_dir / "chapters.vtt"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def export_library(
    root: Path | str,
    output_dir: Path | str | None = None,
    *,
    make_media: bool = True,
) -> Path:
    root = Path(root)
    store = Store(root / "archive" / "recorder.sqlite3")
    try:
        analysis = build_analysis(store)
    finally:
        store.close()

    if not analysis["ranges"]:
        raise RuntimeError("还没有任何已保存区间，先运行 demo 或 record --once")

    if output_dir is None:
        output_dir = root / "exports" / f"offline-{now_iso().replace(':', '').replace('-', '')}"
    output_dir = Path(output_dir)
    if output_dir.exists():
        suffix = 1
        candidate = output_dir
        while candidate.exists():
            candidate = output_dir.with_name(output_dir.name + f"-{suffix}")
            suffix += 1
        output_dir = candidate
    ensure_dir(output_dir)

    catalog: dict[str, Any] = {
        "exported_at": analysis["exported_at"],
        "source_root": str(root.resolve()),
        "offline": True,
        "ranges": [],
        "gaps": analysis["gaps"],
        "epochs": analysis["epochs"],
        "segments": [],
    }

    for range_item in analysis["ranges"]:
        range_dir = output_dir / range_item["id"]
        segments_dir = range_dir / "segments"
        segments_dir.mkdir(parents=True, exist_ok=True)

        export_segments: list[Path] = []
        catalog_range_segments = []
        for index, segment in enumerate(range_item["segments"]):
            source_blob = Path(segment["archive_path"])
            suffix = source_blob.suffix or ".ts"
            export_name = f"{index:04d}_{segment['sha256'][:12]}{suffix}"
            destination = segments_dir / export_name
            shutil.copy2(source_blob, destination)
            segment["export_uri"] = f"segments/{export_name}"
            segment["export_path"] = str(destination.relative_to(output_dir))
            export_segments.append(destination)
            catalog_range_segments.append(
                {
                    "sequence": segment["sequence"],
                    "epoch_id": segment["epoch_id"],
                    "sha256": segment["sha256"],
                    "duration_sec": segment["duration"],
                    "planned_at": segment.get("planned_at"),
                    "cumulative_start": segment["cumulative_start"],
                    "cumulative_end": segment["cumulative_end"],
                    "file": str(destination.relative_to(range_dir)),
                }
            )
            catalog["segments"].append(
                {
                    "epoch_id": segment["epoch_id"],
                    "sequence": segment["sequence"],
                    "sha256": segment["sha256"],
                    "file": segment["export_path"],
                }
            )

        playlist_path = _write_range_playlist(range_dir, range_item)
        vtt_path = _write_vtt(range_dir, range_item)

        mp4_relative = None
        mp4_duration = None
        media_note = "未生成 MP4"
        if make_media and export_segments and media.probe_duration(export_segments[0]) is not None:
            mp4_path = range_dir / "preview.mp4"
            ok, detail = media.concat_to_mp4(
                export_segments,
                mp4_path,
                expected_duration=float(range_item["duration_sec"]),
            )
            if ok:
                mp4_relative = "preview.mp4"
                mp4_duration = media.probe_duration(mp4_path)
                media_note = f"MP4 已生成（{detail}）"
            else:
                media_note = f"MP4 生成失败，可使用 playlist.m3u8：{detail}"

        catalog["ranges"].append(
            {
                "number": range_item["number"],
                "id": range_item["id"],
                "epoch_id": range_item["epoch_id"],
                "start_sequence": range_item["start_sequence"],
                "end_sequence": range_item["end_sequence"],
                "segment_count": range_item["segment_count"],
                "duration_sec": range_item["duration_sec"],
                "start_iso": range_item["start_iso"],
                "end_iso": range_item["end_iso"],
                "playlist": str(playlist_path.relative_to(output_dir)),
                "vtt": str(vtt_path.relative_to(output_dir)),
                "mp4": f"{range_item['id']}/preview.mp4" if mp4_relative else None,
                "mp4_duration_sec": mp4_duration,
                "media_note": media_note,
                "segments": catalog_range_segments,
            }
        )

    (output_dir / "catalog.json").write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    _write_markdown_notes(output_dir, catalog, analysis)
    _write_html_index(output_dir, catalog)
    _update_latest_symlink(root, output_dir)
    return output_dir


def _update_latest_symlink(root: Path, output_dir: Path) -> None:
    """维护 root/exports/latest，方便 README 和 preview 命令定位。"""
    export_root = root / "exports"
    if output_dir.parent.resolve() != export_root.resolve():
        return
    export_root.mkdir(parents=True, exist_ok=True)
    latest = export_root / "latest"
    try:
        if latest.is_symlink() or latest.exists():
            if latest.is_symlink() or latest.is_file():
                latest.unlink()
            else:
                # 非符号链接的真实目录不替用户删除，避免误删。
                return
        latest.symlink_to(output_dir.name, target_is_directory=True)
    except OSError:
        # 某些文件系统/权限不支持符号链接；时间戳目录仍可直接使用。
        pass


def _md_table(headers: list[str], rows: list[list[Any]]) -> str:
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for row in rows:
        escaped = [str(value).replace("|", "\\|").replace("\n", "<br>") for value in row]
        lines.append("| " + " | ".join(escaped) + " |")
    return "\n".join(lines)


def _write_markdown_notes(output_dir: Path, catalog: dict[str, Any], analysis: dict[str, Any]) -> None:
    range_rows = []
    for item in catalog["ranges"]:
        range_rows.append(
            [
                item["number"],
                item["id"],
                item["epoch_id"],
                f"{item['start_sequence']:04d}-{item['end_sequence']:04d}",
                item["segment_count"],
                format_duration(item["duration_sec"]),
                clock_range(item["start_iso"], item["end_iso"]),
                f"[playlist]({item['playlist']}) / [MP4]({item['mp4']})" if item["mp4"] else f"[playlist]({item['playlist']})",
            ]
        )

    gap_rows = []
    for gap in catalog["gaps"]:
        if gap["type"] == "missing-sequence":
            desc = f"缺 seq {gap['after_sequence'] + 1}..{gap['before_sequence'] - 1}"
        elif gap["type"] == "late-filled":
            desc = f"迟到 seq {','.join(f'{n:04d}' for n in gap['missing_sequences'])}（已补入）"
        else:
            desc = "epoch/序号归零边界"
        note = gap["note"]
        if gap.get("observed_start_iso") and gap.get("observed_end_iso"):
            note += (
                " 收录端实际观察窗口："
                f"{format_clock(gap['observed_start_iso'])} → "
                f"{format_clock(gap['observed_end_iso'])}，"
                f"约 {gap.get('observed_duration_sec', 0):.2f} 秒。"
            )
        gap_rows.append(
            [
                gap["epoch_id"],
                desc,
                gap["status"],
                clock_range(gap["start_iso"], gap["end_iso"]),
                format_duration(gap.get("wall_duration_sec")),
                note,
            ]
        )

    inventory_rows = []
    for segment in analysis["segments"]:
        inventory_rows.append(
            [
                segment["epoch_id"],
                f"{segment['sequence']:04d}",
                f"r{segment['revision']}",
                (segment["sha256"] or "")[:12],
                format_duration(segment["duration"]),
                segment.get("seen_count", 1),
                format_clock(segment.get("completed_at")),
                Path(segment.get("archive_path") or "").name,
            ]
        )

    text = f"""# 本地滚动清单收录说明

- 导出时间：{format_clock(catalog['exported_at'])}
- 实验根目录：`{catalog['source_root']}`
- 离线目录：`{output_dir.resolve()}`
- 已保存短片：{len(analysis['segments'])} 段
- 连续可播放区间：{len(catalog['ranges'])} 段
- 空缺/断档标记：{len(catalog['gaps'])} 处

## 怎么离线打开

1. 最简单：用浏览器打开 `index.html`，每个连续区间都有独立 `<video>` 预览。
2. 也可以用 VLC / IINA / mpv 打开各区间目录里的 `playlist.m3u8`。
3. 若已生成 `preview.mp4`，可直接打开该文件；它不依赖原始 `source/playlist.m3u8`。
4. 播放时对照下表的累计时间、`catalog.json` 中每段 `cumulative_start/end`，以及 m3u8 中的 `#EXTINF` 时长。

即使删除实验目录下原来的 `source/playlist.m3u8` 和源短片，本导出目录已经复制了所需媒体，仍可播放这些连续区间。

## 连续区间

{_md_table(['#', '目录', 'Epoch', '序号', '段数', '清单总时长', '节目时间范围', '打开'], range_rows)}

## 空缺时间与断档

{_md_table(['Epoch/边界', '缺口', '状态', '空缺节目时间', '节目缺口时长', '说明'], gap_rows) if gap_rows else '无中间缺口。'}

## 身份与防覆盖说明

- 同一段在滚动清单中重复出现时，数据库只增加 `seen_count`，不会重复复制。
- 每段最终以 SHA-256 为内容身份，保存为 `archive/blobs/<sha256>.ts`。
- 断档后序号从 `0000` 重新开始时，使用新的 `epoch_id` 区分；即使源文件名同样是 `seg_0000.ts` 且内容已被覆盖，旧 blob 也不会被覆盖。
- 半截文件先写入 `archive/tmp/<sha256>.part`；下一轮核对源前缀后从已有字节继续追加，完成并校验 SHA-256 后才原子改名入库。
- 收录状态在 `archive/recorder.sqlite3`；进程重启后从该数据库和 `.part` 文件继续。

## 片段清单

{_md_table(['Epoch', 'Seq', '修订', 'SHA256', '时长', '清单出现次数', '完成时间', '归档文件'], inventory_rows)}

## 机器可读数据

- `catalog.json`：区间、缺口、每段 SHA-256 与累计时间。
- `*/playlist.m3u8`：自包含 VOD 清单，末尾有 `#EXT-X-ENDLIST`。
- `*/chapters.vtt`：每段对应的时间轴章节。
"""
    notes_path = output_dir / "收录说明.md"
    notes_path.write_text(text, encoding="utf-8")


def _write_html_index(output_dir: Path, catalog: dict[str, Any]) -> None:
    range_sections = []
    for item in catalog["ranges"]:
        rows = []
        for seg in item["segments"]:
            rows.append(
                "<tr>"
                f"<td>{seg['sequence']:04d}</td>"
                f"<td>{seg['cumulative_start']:.2f}s – {seg['cumulative_end']:.2f}s</td>"
                f"<td>{seg['duration_sec']:.3f}s</td>"
                f"<td><code>{seg['sha256'][:12]}</code></td>"
                f"<td>{html.escape(format_clock(seg.get('planned_at')))}</td>"
                "</tr>"
            )
        video = (
            f'<video controls preload="metadata" src="{html.escape(item["mp4"])}"></video>'
            if item.get("mp4")
            else '<p class="warn">未生成 MP4，请用 VLC 打开 playlist.m3u8。</p>'
        )
        range_sections.append(
            f"""
<section class="range">
  <h2>区间 {item['number']}：{html.escape(item['id'])}</h2>
  <p>Epoch <code>{html.escape(item['epoch_id'])}</code>，序号
     <b>{item['start_sequence']:04d}–{item['end_sequence']:04d}</b>，
     {item['segment_count']} 段，清单总时长 <b>{item['duration_sec']:.3f} 秒</b>。</p>
  {video}
  <p class="links">
    <a href="{html.escape(item['playlist'])}">打开 playlist.m3u8</a>
    <a href="{html.escape(item['vtt'])}">chapters.vtt</a>
    {f'<a href="{html.escape(item["mp4"])}">preview.mp4</a>' if item.get('mp4') else ''}
  </p>
  <table><thead><tr><th>序号</th><th>播放进度累计区间</th><th>EXTINF 时长</th><th>SHA</th><th>节目时间</th></tr></thead>
  <tbody>{''.join(rows)}</tbody></table>
</section>
"""
        )

    gap_items = "".join(
        "<li>"
        f"<b>{html.escape(gap['status'])}</b>：{html.escape(str(gap['epoch_id']))}，"
        f"{html.escape(clock_range(gap['start_iso'], gap['end_iso']))}，"
        f"节目缺口约 {gap.get('wall_duration_sec', 0):.2f} 秒。"
        f"{html.escape(gap['note'])}"
        + (
            f" 实际观察窗口约 {gap.get('observed_duration_sec', 0):.2f} 秒。"
            if gap.get("observed_duration_sec") is not None
            else ""
        )
        + "</li>"
        for gap in catalog["gaps"]
    ) or "<li>无中间缺口。</li>"

    page = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>离线收录区间预览</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f5f7fb; color: #172033; }}
  main {{ max-width: 1080px; margin: 0 auto; padding: 28px 20px 60px; }}
  h1 {{ margin-top: 0; }}
  .range {{ background: white; border: 1px solid #dfe5ef; border-radius: 14px; padding: 20px; margin: 22px 0; box-shadow: 0 8px 24px rgba(20,40,80,.06); }}
  video {{ width: 100%; max-height: 520px; background: #000; border-radius: 10px; }}
  table {{ border-collapse: collapse; width: 100%; margin-top: 14px; font-size: 14px; }}
  th, td {{ border-bottom: 1px solid #e7ebf3; padding: 7px 8px; text-align: left; }}
  th {{ background: #f2f5fa; }}
  code {{ background: #eef2f8; padding: 1px 5px; border-radius: 5px; }}
  .links a {{ margin-right: 16px; }}
  .warn {{ color: #9a5b00; background: #fff5df; padding: 10px; border-radius: 8px; }}
  .gaps {{ background: #fff; border: 1px solid #ead7b8; border-radius: 14px; padding: 16px 22px; }}
</style>
</head>
<body><main>
<h1>离线收录区间预览</h1>
<p>导出时间：{html.escape(format_clock(catalog['exported_at']))}。此页面和所有媒体均在导出目录内，不依赖原始滚动清单。</p>
<p><a href="收录说明.md">打开收录说明 Markdown</a> · <a href="catalog.json">catalog.json</a></p>
<div class="gaps"><h2>空缺与断档</h2><ul>{gap_items}</ul></div>
{''.join(range_sections)}
</main></body></html>
"""
    (output_dir / "index.html").write_text(page, encoding="utf-8")


# ----------------------------------------------------------------------
# Verification
# ----------------------------------------------------------------------

def verify_export(export_dir: Path | str, *, decode: bool = False) -> dict[str, Any]:
    export_dir = Path(export_dir)
    catalog_path = export_dir / "catalog.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    errors: list[str] = []
    checks: list[dict[str, Any]] = []

    for range_item in catalog.get("ranges", []):
        playlist_path = export_dir / range_item["playlist"]
        if not playlist_path.exists():
            errors.append(f"缺少清单：{playlist_path}")
            continue
        parsed = parse_playlist(playlist_path)
        extinf_total = sum(segment.duration for segment in parsed.segments)
        catalog_total = float(range_item["duration_sec"])
        if abs(extinf_total - catalog_total) > 0.05:
            errors.append(
                f"{range_item['id']} EXTINF 总时长 {extinf_total:.3f} 与 catalog {catalog_total:.3f} 不一致"
            )

        for segment_ref in parsed.segments:
            media_path = segment_ref.resolved_path(playlist_path)
            try:
                media_path.relative_to(export_dir.resolve())
            except ValueError:
                errors.append(f"{range_item['id']} 引用了导出目录之外的文件：{segment_ref.uri}")
                continue
            if not media_path.exists() or media_path.stat().st_size == 0:
                errors.append(f"{range_item['id']} 缺少媒体文件：{media_path}")

        if decode:
            playlist_ok, playlist_detail = media.decode_check(playlist_path)
            if not playlist_ok:
                errors.append(f"m3u8 解码校验失败 {playlist_path}: {playlist_detail}")

        mp4_relative = range_item.get("mp4")
        if mp4_relative:
            mp4_path = export_dir / mp4_relative
            if not mp4_path.exists():
                errors.append(f"缺少 MP4：{mp4_path}")
            else:
                mp4_duration = media.probe_duration(mp4_path)
                if mp4_duration is None:
                    errors.append(f"ffprobe 无法读取 MP4 时长：{mp4_path}")
                elif abs(mp4_duration - extinf_total) > max(0.45, extinf_total * 0.12):
                    errors.append(
                        f"{range_item['id']} MP4 时长 {mp4_duration:.3f} 与清单 {extinf_total:.3f} 偏差过大"
                    )
                else:
                    checks.append(
                        {
                            "range": range_item["id"],
                            "playlist_duration": extinf_total,
                            "mp4_duration": mp4_duration,
                        }
                    )
                if decode:
                    ok, detail = media.decode_check(mp4_path)
                    if not ok:
                        errors.append(f"MP4 解码校验失败 {mp4_path}: {detail}")

    notes = export_dir / "收录说明.md"
    index = export_dir / "index.html"
    if not notes.exists():
        errors.append("缺少 收录说明.md")
    if not index.exists():
        errors.append("缺少 index.html")

    # catalog 中记录的 SHA 与导出副本逐一核对。
    for item in catalog.get("segments", []):
        path = export_dir / item["file"]
        if not path.exists():
            errors.append(f"catalog 媒体不存在：{item['file']}")
            continue
        actual = sha256_file(path)
        if actual != item["sha256"]:
            errors.append(f"SHA256 不一致：{item['file']}")

    return {
        "ok": not errors,
        "export_dir": str(export_dir.resolve()),
        "errors": errors,
        "checks": checks,
        "range_count": len(catalog.get("ranges", [])),
        "gap_count": len(catalog.get("gaps", [])),
    }


def find_latest_export(root: Path | str) -> Path | None:
    export_root = Path(root) / "exports"
    if not export_root.exists():
        return None
    candidates = [path for path in export_root.iterdir() if path.is_dir() and (path / "catalog.json").exists()]
    if not candidates:
        return None
    return max(candidates, key=lambda path: path.stat().st_mtime)
