from __future__ import annotations

import argparse
import functools
import http.server
import socketserver
import webbrowser
from pathlib import Path

from .exporter import export_library, find_latest_export, verify_export
from .recorder import Recorder
from .world import advance, init_world, print_world_status, load_world
from .storage import Store
from .exporter import build_analysis
from .util import format_clock, format_duration


def add_root_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--root",
        type=Path,
        default=Path("demo_work"),
        help="实验工作目录，默认 ./demo_work",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python3 -m segment_recorder",
        description="本地滚动 HLS 清单收录/续收/重启/离线导出实验",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init", help="初始化剧本目录")
    add_root_argument(init_parser)
    init_parser.add_argument("--fake-media", action="store_true", help="不调用 ffmpeg，写伪媒体字节")
    init_parser.add_argument("--force", action="store_true", help="清空并重建 root")
    init_parser.add_argument("--window", type=int, default=4)
    init_parser.add_argument("--segment-seconds", type=float, default=1.0)

    tick_parser = subparsers.add_parser("tick", help="推进一个剧本节拍")
    add_root_argument(tick_parser)

    status_parser = subparsers.add_parser("status", help="查看剧本、收录状态、区间和缺口")
    add_root_argument(status_parser)
    status_parser.add_argument("--events", type=int, default=12)

    record_parser = subparsers.add_parser("record", help="运行收录进程")
    add_root_argument(record_parser)
    record_parser.add_argument("--once", action="store_true", help="只轮询一次，适合手动步进")
    record_parser.add_argument("--interval", type=float, default=0.6)
    record_parser.add_argument("--quiet", action="store_true")
    record_parser.add_argument("--show-repeats", action="store_true", default=True)
    record_parser.add_argument("--hide-repeats", dest="show_repeats", action="store_false")

    export_parser = subparsers.add_parser("export", help="导出自包含离线播放目录")
    add_root_argument(export_parser)
    export_parser.add_argument("--output", type=Path, default=None)
    export_parser.add_argument("--no-media", action="store_true", help="不尝试 concat MP4")

    verify_parser = subparsers.add_parser("verify", help="校验导出目录")
    verify_parser.add_argument("export_dir", nargs="?", type=Path, default=None)
    add_root_argument(verify_parser)
    verify_parser.add_argument("--decode", action="store_true", help="额外用 ffmpeg 全量解码 MP4")

    preview_parser = subparsers.add_parser("preview", help="打开或服务离线预览")
    add_root_argument(preview_parser)
    preview_parser.add_argument("--export", type=Path, default=None)
    preview_parser.add_argument("--range", dest="range_id", default=None)
    preview_parser.add_argument("--serve", action="store_true", help="启动本地 HTTP 服务而不是直接打开文件")
    preview_parser.add_argument("--port", type=int, default=8765)
    preview_parser.add_argument("--print", action="store_true", help="只打印路径，不打开浏览器")

    demo_parser = subparsers.add_parser("demo", help="运行可控端到端演示")
    add_root_argument(demo_parser)
    mode = demo_parser.add_mutually_exclusive_group()
    mode.add_argument("--auto", action="store_true", help="自动按时间推进（默认）")
    mode.add_argument("--step", action="store_true", help="每个节拍后等待 Enter")
    demo_parser.add_argument("--tick-seconds", type=float, default=1.2)
    demo_parser.add_argument("--recorder-interval", type=float, default=0.45)
    demo_parser.add_argument("--fake-media", action="store_true")
    demo_parser.add_argument("--force", action="store_true")
    demo_parser.add_argument("--delete-source", action="store_true", help="导出后删除 source 再校验一次")
    demo_parser.add_argument("--decode", action="store_true", help="最终用 ffmpeg 解码校验 MP4")

    return parser


def cmd_init(args: argparse.Namespace) -> int:
    state = init_world(
        args.root,
        fake_media=args.fake_media,
        force=args.force,
        window=args.window,
        segment_seconds=args.segment_seconds,
    )
    print(f"已初始化：{Path(state['root'])}")
    print("下一步：python3 -m segment_recorder tick --root", args.root)
    return 0


def cmd_tick(args: argparse.Namespace) -> int:
    result = advance(args.root)
    print(f"节拍 {result['tick']}")
    for event in result["events"]:
        print(" -", event)
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    root = Path(args.root)
    try:
        print(print_world_status(root))
    except Exception:
        print("尚未初始化剧本状态。")

    db = root / "archive" / "recorder.sqlite3"
    if not db.exists():
        print("收录数据库尚未创建。")
        return 0

    with Store(db) as store:
        counts = store.status_counts()
        print("\n收录状态计数：", counts)
        analysis = build_analysis(store)
        print(f"连续区间：{len(analysis['ranges'])}；缺口/边界：{len(analysis['gaps'])}")
        for item in analysis["ranges"]:
            print(
                f"  ✓ 区间{item['number']:02d} {item['id']}："
                f"{item['segment_count']} 段 / {format_duration(item['duration_sec'])} / "
                f"{format_clock(item['start_iso'])}"
            )
        for gap in analysis["gaps"]:
            print(
                f"  ! {gap['status']} {gap['epoch_id']} "
                f"({format_duration(gap.get('wall_duration_sec'))})"
            )
        print("\n最近事件：")
        for event in reversed(store.recent_events(limit=args.events)):
            print(
                f"  {event['at'][11:19]} {event['kind']:14s} "
                f"{event['message']}"
            )
    return 0


def cmd_record(args: argparse.Namespace) -> int:
    recorder = Recorder(
        args.root,
        interval=args.interval,
        verbose=not args.quiet,
        show_repeats=args.show_repeats,
    )
    try:
        if args.once:
            recorder.poll_once()
            recorder.close("once")
        else:
            recorder.run_forever()
    except KeyboardInterrupt:
        recorder.request_stop()
        recorder.close("interrupted")
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    path = export_library(args.root, args.output, make_media=not args.no_media)
    report = verify_export(path)
    print(f"导出完成：{path}")
    print(f"校验 ok={report['ok']} ranges={report['range_count']} gaps={report['gap_count']}")
    for error in report["errors"]:
        print("ERROR:", error)
    return 0 if report["ok"] else 1


def cmd_verify(args: argparse.Namespace) -> int:
    export_dir = args.export_dir or find_latest_export(args.root)
    if export_dir is None:
        print("找不到导出目录；请先 export 或传入 export_dir")
        return 2
    report = verify_export(export_dir, decode=args.decode)
    print(f"导出目录：{report['export_dir']}")
    print(f"ok={report['ok']} ranges={report['range_count']} gaps={report['gap_count']}")
    for check in report["checks"]:
        print(
            f"  {check['range']}: playlist={check['playlist_duration']:.3f}s "
            f"mp4={check['mp4_duration']:.3f}s"
        )
    for error in report["errors"]:
        print("ERROR:", error)
    return 0 if report["ok"] else 1


def _choose_preview_path(export_dir: Path, range_id: str | None) -> Path:
    if range_id:
        candidate = export_dir / range_id / "preview.mp4"
        if candidate.exists():
            return candidate
        playlist = export_dir / range_id / "playlist.m3u8"
        if playlist.exists():
            return playlist
        raise FileNotFoundError(range_id)
    index = export_dir / "index.html"
    if index.exists():
        return index
    return export_dir


def cmd_preview(args: argparse.Namespace) -> int:
    export_dir = args.export or find_latest_export(args.root)
    if export_dir is None:
        print("找不到导出目录；请先运行 export")
        return 2
    target = _choose_preview_path(export_dir, args.range_id)
    print(f"导出目录：{export_dir}")
    print(f"预览路径：{target}")

    if args.serve:
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(export_dir))
        with socketserver.TCPServer(("127.0.0.1", args.port), handler) as httpd:
            url = f"http://127.0.0.1:{args.port}/{target.name if target.is_file() and target.parent == export_dir else ''}"
            if target.parent != export_dir:
                rel = target.relative_to(export_dir)
                url = f"http://127.0.0.1:{args.port}/{rel}"
            print(f"Serving 离线目录 at {url}")
            print("按 Ctrl+C 停止服务。")
            if not args.print:
                webbrowser.open(url)
            try:
                httpd.serve_forever()
            except KeyboardInterrupt:
                print("\n已停止预览服务。")
        return 0

    if not args.print:
        webbrowser.open(target.as_uri())
    else:
        print(target)
    return 0


def cmd_demo(args: argparse.Namespace) -> int:
    from .demo import run_demo

    return run_demo(
        args.root,
        auto=not args.step,
        tick_seconds=args.tick_seconds,
        recorder_interval=args.recorder_interval,
        fake_media=args.fake_media,
        force=args.force,
        delete_source_after_export=args.delete_source,
        decode=args.decode,
    )


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    handlers = {
        "init": cmd_init,
        "tick": cmd_tick,
        "status": cmd_status,
        "record": cmd_record,
        "export": cmd_export,
        "verify": cmd_verify,
        "preview": cmd_preview,
        "demo": cmd_demo,
    }
    return int(handlers[args.command](args) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
