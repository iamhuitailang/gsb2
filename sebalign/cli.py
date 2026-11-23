"""sebalign 命令行入口。

子命令：
  init-samples  生成带编号源短片（含画面编号、拍点、连续节拍音）
  build         从源片构建两档分段 + 连续音轨 + manifest
  compare       横向比对两档边界/缺段/不可读
  verify        重新打开工作区实读核验
  report        导出索引 CSV 与 JSON/Markdown 报告
  serve         本地浏览器预览（换档决策 + 手动/计划换档）
  demo          一键生成“顺利换档”和“错位”两套例子
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .build import TierConfig, build_workspace, load_manifest
from .compare import compare_tiers
from .report import export_index_csv, export_report_json, export_report_markdown
from .samples import generate_source_clips
from .verify import verify_workspace


def _parse_cutpoints(text: str) -> list[float]:
    """解析逗号分隔的切分点，例如 '3,6,9,12'。"""
    if not text.strip():
        return []
    out = []
    for part in text.split(","):
        part = part.strip()
        if part:
            out.append(float(part))
    return sorted(set(out))


def _load_markers(src_dir: Path) -> dict:
    marker_path = src_dir / "markers.json"
    if marker_path.is_file():
        return json.loads(marker_path.read_text(encoding="utf-8"))
    return {}


def cmd_init_samples(args: argparse.Namespace) -> int:
    markers = generate_source_clips(args.src_dir)
    print(f"已在 {args.src_dir} 生成 {len(markers['frames'])} 帧的编号源片与 markers.json")
    return 0


def cmd_build(args: argparse.Namespace) -> int:
    src_dir = Path(args.src_dir)
    workspace = Path(args.workspace)
    tiers = [
        TierConfig(
            name=args.name_a, width=args.width_a, height=args.height_a,
            cutpoints=_parse_cutpoints(args.cuts_a),
        ),
        TierConfig(
            name=args.name_b, width=args.width_b, height=args.height_b,
            cutpoints=_parse_cutpoints(args.cuts_b),
        ),
    ]
    markers = _load_markers(src_dir)
    manifest = build_workspace(src_dir, workspace, tiers, markers=markers or None)
    for tier in manifest.tiers:
        print(f"\n[{tier.name}] {tier.width}x{tier.height}，切点(吸附后): "
              f"{[round(x, 3) for x in tier.cutpoints_effective]}")
        for s in tier.segments:
            flag = "" if s.openable else "  [不可读!]"
            print(f"  #{s.seq:02d} 源 {s.source_start:6.3f}-{s.source_end:6.3f}s "
                  f"计划 {s.planned_duration:5.3f}s 实测 {s.actual_duration:5.3f}s "
                  f"首帧 {s.frame_label}{flag}")
    print(f"\nmanifest: {workspace / 'manifest.json'}")
    print(f"连续音轨: {manifest.audio_track or '源片无音频'}")
    return 0


def _load_and_compare(workspace: Path):
    manifest = load_manifest(workspace)
    comparison = compare_tiers(workspace, manifest)
    return manifest, comparison


def cmd_compare(args: argparse.Namespace) -> int:
    manifest, comparison = _load_and_compare(Path(args.workspace))
    print(f"档位: {', '.join(comparison.tier_names)}")
    print("\n共享/单档边界（源时间 → 各档实际首帧）:")
    for b in comparison.boundaries:
        cells = ", ".join(f"{n}={b.per_tier_frame_label.get(n) or '—'}"
                          for n in comparison.tier_names)
        print(f"  {b.source_time:7.3f}s  {cells}  {'对齐' if b.aligned else '★ 不重合'}")
    if not comparison.issues:
        print("\n结论：未发现边界不重合、片段缺失或不可读问题。")
        return 0
    print(f"\n发现 {len(comparison.issues)} 个问题:")
    for i, issue in enumerate(comparison.issues, 1):
        scope = f"[{issue.tier}] " if issue.tier else "[跨档] "
        print(f"  {i}. {scope}{issue.kind}: {issue.detail}")
    return 1


def cmd_verify(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace)
    manifest = load_manifest(workspace)
    report = verify_workspace(workspace, manifest)
    print(f"音轨: {report.audio_status} — {report.audio_detail}")
    for c in report.checks:
        if c.status == "ok":
            print(f"  ok   [{c.tier} #{c.seq}] 实测 {c.actual_duration:.3f}s "
                  f"(索引 {c.indexed_duration:.3f}s) 首帧 {c.indexed_frame_label}")
        else:
            print(f"  {c.status.upper():18s} [{c.tier} #{c.seq} {c.file}] {c.detail}")
    print(f"\n汇总: {report.summary()}")
    return 1 if report.has_errors else 0


def cmd_report(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace)
    manifest, comparison = _load_and_compare(workspace)
    verification = verify_workspace(workspace, manifest)
    csv_path = export_index_csv(manifest, workspace / "segment_index.csv")
    json_path = export_report_json(manifest, comparison, verification, workspace / "report.json")
    md_path = export_report_markdown(manifest, comparison, verification, workspace / "report.md")
    print(f"已导出:\n  {csv_path}\n  {json_path}\n  {md_path}")
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    from .server import serve

    # 指定端口被占时自动顺延几个端口，而不是直接抛 traceback
    httpd = None
    last_err = None
    for port in range(args.port, args.port + 10):
        try:
            httpd = serve(args.workspace, host=args.host, port=port)
            break
        except OSError as exc:
            last_err = exc
    if httpd is None:
        print(f"错误: 端口 {args.port} 起连续 10 个都不可用: {last_err}", file=sys.stderr)
        return 2
    url = f"http://{args.host}:{port}/"
    print(f"预览服务已启动（仅本机访问）: {url}")
    print("按 Ctrl+C 退出。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()
    return 0


def cmd_demo(args: argparse.Namespace) -> int:
    """生成两套例子：good（共享切点，可顺利换档）与 bad（错位+坏文件）。"""
    base = Path(args.out)
    src_dir = base / "sources"
    good_ws = base / "workspace_good"
    bad_ws = base / "workspace_bad"

    print("== 1/4 生成编号源短片 ==")
    markers = generate_source_clips(src_dir)
    total = sum(f["time"] for f in markers["frames"][-1:]) + 1 / markers["fps"]
    print(f"   源片 {len([p for p in src_dir.glob('*.mp4')])} 个，总时长约 {total:.2f}s")

    # good：两档完全相同的切点（3s 网格），所有边界共享
    shared_cuts = "3,6,9,12"
    print("\n== 2/4 构建顺利换档例子 workspace_good ==")
    good_tiers = [
        TierConfig("low", 320, 180, _parse_cutpoints(shared_cuts)),
        TierConfig("high", 640, 360, _parse_cutpoints(shared_cuts)),
    ]
    build_workspace(src_dir, good_ws, good_tiers, markers=markers)
    good_cmp = compare_tiers(good_ws, load_manifest(good_ws))
    print(f"   比对问题数: {len(good_cmp.issues)}（预期 0）")

    # bad：低档 3s 网格，高档故意用 2.5s 网格 → 边界系统性错位；
    # 再删掉高档一个分段文件，制造“索引写了但文件打不开”
    print("\n== 3/4 构建错位例子 workspace_bad ==")
    bad_tiers = [
        TierConfig("low", 320, 180, _parse_cutpoints("3,6,9,12")),
        TierConfig("high", 640, 360, _parse_cutpoints("2.5,5,7.5,10,12.5")),
    ]
    manifest_bad = build_workspace(src_dir, bad_ws, bad_tiers, markers=markers)
    victim = bad_ws / manifest_bad.tiers[1].segments[2].file
    victim.unlink()
    print(f"   已故意删除 {victim.name} 制造不可读分段")
    bad_cmp = compare_tiers(bad_ws, load_manifest(bad_ws))
    kinds = sorted({i.kind for i in bad_cmp.issues})
    print(f"   比对问题数: {len(bad_cmp.issues)}，类型: {kinds}（预期含 boundary_mismatch/unreadable）")

    print("\n== 4/4 导出报告 ==")
    for ws in (good_ws, bad_ws):
        m = load_manifest(ws)
        cmp_ = compare_tiers(ws, m)
        ver = verify_workspace(ws, m)
        export_index_csv(m, ws / "segment_index.csv")
        export_report_json(m, cmp_, ver, ws / "report.json")
        export_report_markdown(m, cmp_, ver, ws / "report.md")
        print(f"   {ws}: report.md / report.json / segment_index.csv")

    print("\n预览：")
    print(f"  python -m sebalign serve {good_ws}")
    print(f"  python -m sebalign serve {bad_ws}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="sebalign", description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)

    sp = sub.add_parser("init-samples", help="生成带编号源短片")
    sp.add_argument("src_dir")
    sp.set_defaults(func=cmd_init_samples)

    bp = sub.add_parser("build", help="构建两档分段与连续音轨")
    bp.add_argument("src_dir")
    bp.add_argument("workspace")
    bp.add_argument("--name-a", default="low")
    bp.add_argument("--width-a", type=int, default=320)
    bp.add_argument("--height-a", type=int, default=180)
    bp.add_argument("--cuts-a", default="", help="A 档切分点(秒, 逗号分隔)")
    bp.add_argument("--name-b", default="high")
    bp.add_argument("--width-b", type=int, default=640)
    bp.add_argument("--height-b", type=int, default=360)
    bp.add_argument("--cuts-b", default="", help="B 档切分点(秒, 逗号分隔)")
    bp.set_defaults(func=cmd_build)

    cp = sub.add_parser("compare", help="横向比对两档")
    cp.add_argument("workspace")
    cp.set_defaults(func=cmd_compare)

    vp = sub.add_parser("verify", help="重新打开工作区实读核验")
    vp.add_argument("workspace")
    vp.set_defaults(func=cmd_verify)

    rp = sub.add_parser("report", help="导出索引与报告")
    rp.add_argument("workspace")
    rp.set_defaults(func=cmd_report)

    sv = sub.add_parser("serve", help="启动本地预览")
    sv.add_argument("workspace")
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=8765)
    sv.set_defaults(func=cmd_serve)

    dp = sub.add_parser("demo", help="一键生成顺利/错位两套例子")
    dp.add_argument("out", nargs="?", default="demo_data",
                    help="输出根目录（默认 demo_data）")
    dp.set_defaults(func=cmd_demo)
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (FileNotFoundError, ValueError, KeyError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 2
