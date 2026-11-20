"""maptiler 命令行入口。

用法示例：
  python3 -m maptiler slice assets/sample_map.png -o out --tile 256x256 --overlap 16 --levels 3 --edge pad
  python3 -m maptiler slice assets/sample_map.png -o out --region 300,200,512,384   # 区域增量重切
  python3 -m maptiler estimate assets/sample_map.png --tile 256x256 --overlap 16 --levels 3
  python3 -m maptiler locate assets/sample_map.png --tile 256x256 --tile-id 1,3,2
  python3 -m maptiler locate assets/sample_map.png --tile 256x256 --point 800,600 --level 1
  python3 -m maptiler verify out/manifest.json
  python3 -m maptiler restore out/manifest.json --level 0 -o restored.png
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

from . import core

PREVIEW_TEMPLATE = Path(__file__).resolve().parent.parent / "preview" / "preview_template.html"


def _parse_size(s: str) -> tuple[int, int]:
    try:
        w, h = s.lower().split("x")
        return int(w), int(h)
    except ValueError:
        raise argparse.ArgumentTypeError(f"尺寸格式应为 WxH，如 256x256: {s!r}")


def _parse_rect(s: str) -> tuple[int, int, int, int]:
    parts = s.split(",")
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("区域格式应为 x,y,w,h")
    return tuple(int(p) for p in parts)


def _add_cfg_args(p: argparse.ArgumentParser):
    p.add_argument("--tile", type=_parse_size, default=(256, 256),
                   help="瓦片宽高，如 256x256（默认 256x256）")
    p.add_argument("--overlap", type=int, default=0, help="相邻瓦片重叠边缘像素数（默认 0）")
    p.add_argument("--levels", type=int, default=1, help="缩放层级数，level 0 为原图（默认 1）")
    p.add_argument("--edge", choices=["pad", "crop"], default="pad",
                   help="边缘不足整块时：pad 补透明边 / crop 裁切（默认 pad）")


def _cfg_from(args) -> core.TileConfig:
    (tw, th) = args.tile
    return core.TileConfig(tw, th, args.overlap, args.levels, args.edge)


def _fmt_bytes(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{n}B"
        n /= 1024
    return f"{n}B"


def cmd_estimate(args) -> int:
    cfg = _cfg_from(args)
    with Image.open(args.source) as im:
        w, h = im.size
    # 用源图实际文件大小推算 bytes/pixel，估算更贴近真实输出
    src_bytes = Path(args.source).stat().st_size
    bpp = src_bytes / (w * h) if w * h else 0.35
    est = core.estimate(w, h, cfg, bpp)
    print(f"源图: {w}x{h}  瓦片: {cfg.tile_w}x{cfg.tile_h}  重叠: {cfg.overlap}px  "
          f"层级: {cfg.levels}  边缘: {cfg.edge}")
    print(f"{'层级':>4} {'缩放':>6} {'尺寸':>12} {'网格':>9} {'瓦片数':>7} {'预计体积':>10}")
    for li in est["levels"]:
        print(f"{li['level']:>4} {li['scale']:>6.3f} "
              f"{li['width']:>6}x{li['height']:<5} "
              f"{li['cols']:>4}x{li['rows']:<4} {li['tiles']:>7} {_fmt_bytes(li['est_bytes']):>10}")
    print(f"合计: {est['total_tiles']} 块瓦片，预计输出 {_fmt_bytes(est['est_bytes'])}")
    return 0


def cmd_slice(args) -> int:
    cfg = _cfg_from(args)
    out_dir = Path(args.output)
    manifest_path = out_dir / "manifest.json"
    region = args.region
    if region is not None and not manifest_path.exists():
        print("注意: 指定了 --region 但输出目录无已有清单，将执行全量切片。", file=sys.stderr)
        region = None
    manifest = core.slice_map(
        args.source, out_dir, cfg, region=region,
        manifest_path=manifest_path if manifest_path.exists() else None)
    _write_preview(out_dir)
    stats = manifest["_stats"]
    total = len(manifest["tiles"])
    print(f"完成: 共 {total} 块瓦片（新写 {stats['written']}，未变化跳过 {stats['skipped']}）")
    print(f"清单: {manifest_path}")
    print(f"预览: {out_dir / 'preview.html'}（浏览器直接打开）")
    return 0


def _write_preview(out_dir: Path):
    """把预览页拷进输出目录，并内嵌清单（file:// 下 fetch 不到本地 JSON）。"""
    template = PREVIEW_TEMPLATE.read_text(encoding="utf-8")
    manifest = (out_dir / "manifest.json").read_text(encoding="utf-8")
    html = template.replace("/*__MANIFEST__*/null", manifest, 1)
    (out_dir / "preview.html").write_text(html, encoding="utf-8")


def cmd_locate(args) -> int:
    cfg = _cfg_from(args)
    with Image.open(args.source) as im:
        w, h = im.size
    if args.tile_id:
        level, col, row = (int(v) for v in args.tile_id.split(","))
        lw, lh = core.level_size(w, h, level)
        x, y, tw, th = core.tile_level_rect(col, row, cfg, lw, lh)
        sx, sy, sw, sh = core.tile_src_rect(level, col, row, cfg, w, h)
        print(f"瓦片 level={level} col={col} row={row}")
        print(f"  层级图位置: x={x} y={y} 尺寸 {tw}x{th}（缩放 1/{1 << level}）")
        print(f"  源图位置:   x={sx} y={sy} 尺寸 {sw}x{sh}")
        print(f"  文件名:     {core.tile_filename(level, col, row)}")
    if args.point:
        px, py = (float(v) for v in args.point.split(","))
        level = args.level
        hits = core.tiles_at_point(px, py, level, cfg, w, h)
        print(f"源图点 ({px:g}, {py:g}) 在 level {level} 命中 {len(hits)} 块瓦片:")
        for c, r in hits:
            print(f"  col={c} row={r}  {core.tile_filename(level, c, r)}")
    return 0


def cmd_verify(args) -> int:
    report = core.verify_manifest(args.manifest)
    total = report["total"]
    print(f"清单共 {total} 块瓦片: 完好 {len(report['ok'])}，"
          f"缺失 {len(report['missing'])}，内容不符 {len(report['mismatched'])}")
    for t in report["missing"]:
        print(f"  缺失: {t['file']}  (level={t['level']} col={t['col']} row={t['row']})")
    for t in report["mismatched"]:
        print(f"  内容不符: {t['file']}")
    return 0 if not report["missing"] and not report["mismatched"] else 1


def cmd_restore(args) -> int:
    out = core.restore_map(args.manifest, args.level, args.output)
    print(f"已按清单还原 level {args.level} 完整地图: {out}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="maptiler", description="大地图切片工具")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("estimate", help="预计切片数量与输出体积")
    p.add_argument("source")
    _add_cfg_args(p)
    p.set_defaults(fn=cmd_estimate)

    p = sub.add_parser("slice", help="切片并导出清单与预览页")
    p.add_argument("source")
    p.add_argument("-o", "--output", required=True, help="输出目录")
    p.add_argument("--region", type=_parse_rect, default=None,
                   help="只重新生成与源图区域 x,y,w,h 相交的瓦片（增量）")
    _add_cfg_args(p)
    p.set_defaults(fn=cmd_slice)

    p = sub.add_parser("locate", help="瓦片坐标 <-> 源图坐标 换算")
    p.add_argument("source")
    p.add_argument("--tile-id", help="瓦片坐标 level,col,row -> 源图位置")
    p.add_argument("--point", help="源图坐标 x,y -> 覆盖它的瓦片")
    p.add_argument("--level", type=int, default=0, help="--point 查询所用层级")
    _add_cfg_args(p)
    p.set_defaults(fn=cmd_locate)

    p = sub.add_parser("verify", help="重新导入清单，校验瓦片完整性")
    p.add_argument("manifest")
    p.set_defaults(fn=cmd_verify)

    p = sub.add_parser("restore", help="按清单把瓦片拼回完整地图")
    p.add_argument("manifest")
    p.add_argument("--level", type=int, default=0)
    p.add_argument("-o", "--output", required=True)
    p.set_defaults(fn=cmd_restore)

    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
