#!/usr/bin/env python3
"""FrameLab 启动入口。

用法:
  python3 -m framelab.cli serve [--port 8765] [--workspace .framelab_workspace]
  python3 -m framelab.cli analyze <视频路径> [--dst-fps 30] [--speed 1]
                                   [--method nearest|blend] [--json]
  python3 -m framelab.cli export  <视频路径> --dst-fps 30 [--speed 1.5]
                                   [--method blend] [--keep-pitch/--no-keep-pitch]
                                   [--workspace ...]
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from .core import pipeline
from .core.ffmpeg_tools import FFmpegError, ensure_ffmpeg
from .core.project_store import cache_key, new_project, project_path, save_project
from .server import create_server

HERE = os.path.dirname(os.path.abspath(__file__))
WEB_ROOT = os.path.join(HERE, "web")
SAMPLES_DIR = os.path.abspath(os.path.join(HERE, "..", "public", "samples"))


def _open_project(workspace: str, source: str) -> dict:
    project = new_project(source)
    save_project(workspace, project)
    pipeline.analyze_source(project)
    save_project(workspace, project)
    return project


def cmd_serve(args) -> int:
    ensure_ffmpeg()
    workspace = os.path.abspath(args.workspace)
    httpd = create_server(args.host, args.port, workspace, WEB_ROOT, SAMPLES_DIR)
    url = f"http://{args.host}:{args.port}/"
    print(f"FrameLab 已启动: {url}")
    print(f"项目工作区: {workspace}")
    print("按 Ctrl+C 停止")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    return 0


def cmd_analyze(args) -> int:
    workspace = os.path.abspath(args.workspace)
    project = _open_project(workspace, args.source)
    project["settings"].update(
        dst_fps=args.dst_fps, speed=args.speed, method=args.method
    )
    mapping = pipeline.compute_mapping(project)
    save_project(workspace, project)
    if args.json:
        print(json.dumps(mapping, ensure_ascii=False, indent=2))
    else:
        s = mapping["stats"]
        print(f"项目文件: {project_path(workspace, project['id'])}")
        print(f"源 {s['src_frame_count']} 帧 ({s['src_fps']}fps, "
              f"{s['src_duration']:.3f}s) → 输出 {s['out_frame_count']} 帧 "
              f"({s['dst_fps']}fps, {s['out_duration']:.3f}s), speed={s['speed']}")
        print(f"方式={s['method']}  精确={s['exact_frames']}  重复={s['duplicate_frames']} "
              f"(最长连重 {s['max_duplicate_run']})  丢帧行={s['drop_frames']} "
              f"混合={s['blend_frames']} (拖影 {s['ghost_frames']})")
        print("前 12 行映射:")
        for row in mapping["rows"][:12]:
            extra = (f" ← 混合 {row['src_index_2']} w={row['blend_weight']:.2f}"
                     if row["src_index_2"] is not None else "")
            print(f"  出{row['out_index']:>4} {row['out_timecode']} "
                  f"[{row['kind']:>9}] → 源{row['src_index']:>4} "
                  f"{row['src_timecode']}{extra}")
    return 0


def cmd_export(args) -> int:
    workspace = os.path.abspath(args.workspace)
    project = _open_project(workspace, args.source)
    project["settings"].update(
        dst_fps=args.dst_fps, speed=args.speed, method=args.method,
        keep_pitch=args.keep_pitch,
    )
    pipeline.compute_mapping(project)
    save_project(workspace, project)
    mapping = project["mapping_cache"][cache_key(project["settings"])]
    csv_path, json_path = pipeline.export_manifest(workspace, project, mapping)
    record = pipeline.export_video(workspace, project)
    print(f"视频: {record['output']}")
    print(f"清单: {os.path.basename(csv_path)} / {os.path.basename(json_path)}")
    print(f"命令: {' '.join(record['command'])}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="framelab", description="帧率转换与时间映射检查工具")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("serve", help="启动本地 Web 界面")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8765)
    s.add_argument("--workspace", default=".framelab_workspace")
    s.set_defaults(func=cmd_serve)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("source")
    common.add_argument("--dst-fps", type=float, default=30.0)
    common.add_argument("--speed", type=float, default=1.0)
    common.add_argument("--method", choices=["nearest", "blend"], default="nearest")
    common.add_argument("--workspace", default=".framelab_workspace")

    a = sub.add_parser("analyze", parents=[common], help="只分析并打印映射")
    a.add_argument("--json", action="store_true")
    a.set_defaults(func=cmd_analyze)

    e = sub.add_parser("export", parents=[common], help="分析并导出视频+清单")
    e.add_argument("--keep-pitch", dest="keep_pitch", action="store_true", default=True)
    e.add_argument("--no-keep-pitch", dest="keep_pitch", action="store_false")
    e.set_defaults(func=cmd_export)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except FFmpegError as e:
        print(f"错误: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
