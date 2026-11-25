"""命令行入口: sample / plan / preview / compare / export / edit / verify / report。"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .ffmpegutil import FFmpegError, load_json, probe, dump_json
from .planner import plan as run_plan
from .render import (
    contact_sheet,
    export_vertical,
    render_compare,
    render_preview,
)
from .report import build_report
from .samplegen import generate as gen_sample
from .timeline import add_override, list_overrides, list_segments, remove_override, update_motion
from .tracks import load_tracks
from .verify import check_av, check_export_vs_schedule, cut_frames


def _resolve(base: Path, name: str) -> Path:
    p = Path(name)
    return p if p.is_absolute() else (base / p)


def cmd_sample(args: argparse.Namespace) -> None:
    out = Path(args.outdir)
    res = gen_sample(out, args.prefix)
    print(f"样例视频: {res['video']}")
    print(f"关注框轨迹: {res['tracks']}")


def _load_for_plan(args: argparse.Namespace) -> tuple[Any, Path]:
    tracks_path = Path(args.tracks)
    doc = load_tracks(tracks_path)
    if args.video:
        doc.source = str(Path(args.video).name)
    return doc, tracks_path


def cmd_plan(args: argparse.Namespace) -> None:
    doc, tracks_path = _load_for_plan(args)
    schedule = run_plan(doc)
    schedule["tracks_file"] = str(tracks_path)
    out = Path(args.output)
    dump_json(schedule, out)
    print(f"取景时间表: {out}  ({schedule['frames']} 帧, {len(schedule['keyframes'])} 个裁框关键帧)")
    for s in schedule["segments"]:
        print(f"  {s['start']:5.1f}-{s['end']:5.1f}s [{s['transition']:6s}] 主策略={s['dominant_strategy']}")
    for w in schedule["warnings"]:
        print(f"  ! {w}", file=sys.stderr)


def _rel_video(tracks_path: Path, video: str | None) -> Path:
    if video:
        return Path(video)
    doc = load_json(tracks_path)
    return tracks_path.parent / doc["source"]


def cmd_preview(args: argparse.Namespace) -> None:
    schedule = load_json(args.schedule)
    tracks_path = Path(schedule.get("tracks_file") or args.tracks)
    tracks_doc = load_json(tracks_path)
    video = _rel_video(tracks_path, args.video)
    work = Path(args.workdir)
    work.mkdir(parents=True, exist_ok=True)
    render_preview(video, schedule, tracks_doc, args.output, work)
    print(f"横版预览: {args.output}")


def cmd_compare(args: argparse.Namespace) -> None:
    schedule = load_json(args.schedule)
    tracks_path = Path(schedule.get("tracks_file") or args.tracks)
    tracks_doc = load_json(tracks_path)
    video = _rel_video(tracks_path, args.video)
    work = Path(args.workdir)
    work.mkdir(parents=True, exist_ok=True)
    render_compare(video, schedule, tracks_doc, args.output, work)
    print(f"横竖对照: {args.output}")


def cmd_export(args: argparse.Namespace) -> None:
    schedule = load_json(args.schedule)
    tracks_path = Path(schedule.get("tracks_file") or args.tracks)
    video = _rel_video(tracks_path, args.video)
    work = Path(args.workdir)
    work.mkdir(parents=True, exist_ok=True)
    export_vertical(video, schedule, args.output, work)
    info = probe(args.output)
    print(f"竖版成片: {args.output}  {info['width']}x{info['height']} "
          f"{info['duration']:.2f}s 音频={'有' if info['has_audio'] else '无'}")


def cmd_edit(args: argparse.Namespace) -> None:
    path = Path(args.schedule)
    schedule = load_json(path)
    if args.list:
        print("分段:")
        for s in list_segments(schedule):
            print(f"  {s['start']:.2f}-{s['end']:.2f}s [{s['transition']}] {s['dominant_strategy']}")
        print("人工取景点:")
        for o in list_overrides(schedule):
            print(f"  {o['start']:.2f}-{o['end']:.2f}s center_x={o['center_x_norm']:.3f} ({o.get('name')})")
        return
    changed = False
    if args.add_override:
        start, end, cx = args.add_override
        ov = add_override(schedule, start, end, cx, args.name)
        print(f"加入人工取景: {ov}")
        changed = True
    if args.remove_override:
        n = remove_override(schedule, args.remove_override)
        print(f"删除 {n} 段人工取景")
        changed = True
    if args.max_speed is not None or args.dwell is not None or args.hysteresis is not None:
        update_motion(
            schedule,
            max_speed_px_s=args.max_speed,
            dwell_s=args.dwell,
            hysteresis_px=args.hysteresis,
        )
        changed = True
    if not changed:
        print("没有要修改的内容, 用 --list 查看或参考 --help", file=sys.stderr)
        return 2
    # 编辑后基于原轨迹重算 (原片不动), 保留新的 overrides / motion
    tracks_path = Path(schedule.get("tracks_file") or args.tracks)
    doc = load_tracks(tracks_path)
    doc.config.setdefault("motion", {}).update(schedule["motion"])
    new_schedule = run_plan(doc, overrides=schedule["overrides"])
    new_schedule["tracks_file"] = str(tracks_path)
    out = Path(args.output) if args.output else path
    dump_json(new_schedule, out)
    print(f"已更新时间表: {out}")


def cmd_verify(args: argparse.Namespace) -> None:
    schedule = load_json(args.schedule)
    tracks_path = Path(schedule.get("tracks_file") or args.tracks)
    tracks_doc = load_json(tracks_path)
    video = _rel_video(tracks_path, args.video)
    work = Path(args.workdir)
    work.mkdir(parents=True, exist_ok=True)

    cuts = cut_frames(schedule, tracks_doc)
    print("转场帧裁框归属:")
    for r in cuts:
        print(f"  t={r['t']:.2f}s 帧{r['frame']} [{r['transition']}] "
              f"跳变 {r['jump_px']}px -> {r['strategy_after']}")

    frame_check = check_export_vs_schedule(video, args.vertical, schedule, work)
    print(f"逐帧裁框一致性 (亮度平面, 容差 {frame_check['tolerance']:.0%}):")
    for r in frame_check["rows"]:
        print(f"  帧{r['frame']:4d} t={r['t']:5.2f}s crop_x={r['crop_x_px']:4d} "
              f"亮度差异 {r['luma_diff_ratio']:.2%} "
              f"{'一致' if r['identical'] else '不一致!!'}")
    av = check_av(video, args.vertical, schedule)
    print(f"音视频: 时长差 {av['duration_diff_s']}s, 原音={av['source_has_audio']}->"
          f"{av['output_has_audio']}, 尺寸 {av['output_size']}")

    ok = frame_check["ok"] and av["ok"]
    if args.json:
        dump_json({"cut_frames": cuts, "frame_check": frame_check, "av": av, "ok": ok}, args.json)
    return 0 if ok else 1


def cmd_report(args: argparse.Namespace) -> None:
    schedule = load_json(args.schedule)
    sheet = None
    if args.sheet_video:
        times = [kf["t"] for kf in schedule["keyframes"][:: max(1, len(schedule["keyframes"]) // 9)]]
        sheet = Path(args.workdir) / "contact_sheet.jpg"
        contact_sheet(args.sheet_video, times[:9], sheet)
    verify_data = None
    if args.vertical:
        tracks_path = Path(schedule.get("tracks_file") or args.tracks)
        video = _rel_video(tracks_path, args.video)
        work = Path(args.workdir)
        tracks_doc = load_json(tracks_path)
        verify_data = {
            "cut_frames": cut_frames(schedule, tracks_doc),
            "frame_check": check_export_vs_schedule(video, args.vertical, schedule, work),
            "av": check_av(video, args.vertical, schedule),
        }
    build_report(schedule, args.output, sheet, verify_data)
    print(f"报告: {args.output}")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="reframer", description="横片转竖版取景重排工具 (Python + ffmpeg)")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("sample", help="生成带编号方块的样例横片和轨迹")
    s.add_argument("outdir")
    s.add_argument("--prefix", default="sample")
    s.set_defaults(func=cmd_sample)

    s = sub.add_parser("plan", help="由关注框轨迹生成取景时间表")
    s.add_argument("tracks")
    s.add_argument("-o", "--output", required=True)
    s.add_argument("--video", help="覆盖轨迹里记录的源片文件名")
    s.set_defaults(func=cmd_plan)

    def add_common(parser: argparse.ArgumentParser, need_video: bool = True) -> None:
        parser.add_argument("schedule")
        parser.add_argument("-o", "--output", required=True)
        parser.add_argument("--video")
        parser.add_argument("--tracks", help="时间表未记录轨迹文件路径时手动指定")
        parser.add_argument("--workdir", default=".reframer_work")

    s = sub.add_parser("preview", help="横版预览: 取景框移动 + 关注框 + 安全区")
    add_common(s)
    s.set_defaults(func=cmd_preview)

    s = sub.add_parser("compare", help="横竖对照预览")
    add_common(s)
    s.set_defaults(func=cmd_compare)

    s = sub.add_parser("export", help="导出竖版 (保留原音和时长)")
    add_common(s)
    s.set_defaults(func=cmd_export)

    s = sub.add_parser("edit", help="重开时间表, 只改某段 (原片不动)")
    s.add_argument("schedule")
    s.add_argument("--list", action="store_true")
    s.add_argument("--add-override", nargs=3, type=float, metavar=("START", "END", "CENTER_X_NORM"))
    s.add_argument("--remove-override", metavar="NAME")
    s.add_argument("--name", default="manual")
    s.add_argument("--max-speed", type=float)
    s.add_argument("--dwell", type=float)
    s.add_argument("--hysteresis", type=float)
    s.add_argument("-o", "--output")
    s.add_argument("--tracks")
    s.set_defaults(func=cmd_edit)

    s = sub.add_parser("verify", help="转场帧/逐帧一致性/音视频检查")
    s.add_argument("schedule")
    s.add_argument("vertical")
    s.add_argument("--video")
    s.add_argument("--tracks")
    s.add_argument("--workdir", default=".reframer_work")
    s.add_argument("--json", help="把检查结果写到 JSON")
    s.set_defaults(func=cmd_verify)

    s = sub.add_parser("report", help="导出 HTML 报告")
    s.add_argument("schedule")
    s.add_argument("-o", "--output", required=True)
    s.add_argument("--sheet-video", help="用该视频抽帧生成联系表 (通常传竖版成片)")
    s.add_argument("--vertical", help="传入成片则报告内含一致性检查")
    s.add_argument("--video")
    s.add_argument("--tracks")
    s.add_argument("--workdir", default=".reframer_work")
    s.set_defaults(func=cmd_report)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args) or 0
    except (FFmpegError, KeyError, ValueError, FileNotFoundError) as e:
        print(f"错误: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
