"""Command-line interface.

  python -m jpeg_progressive_tool.cli make-samples DIR
  python -m jpeg_progressive_tool.cli analyze FILE.jpg
  python -m jpeg_progressive_tool.cli probe FILE.jpg --offset 12345
  python -m jpeg_progressive_tool.cli compare FILE.jpg --offset 12345 [--crop x0 y0 x1 y1]
  python -m jpeg_progressive_tool.cli export FILE.jpg OUTDIR
  python -m jpeg_progressive_tool.cli serve [--port 5000]
"""

from __future__ import annotations

import argparse
import json
import sys

from . import analyzer, compare, exporter, parser, samples


def _load(path):
    with open(path, "rb") as f:
        return f.read()


def cmd_make_samples(args):
    summary = samples.generate(args.dir)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def cmd_analyze(args):
    data = _load(args.file)
    st = parser.parse(data)
    d = st.to_dict()
    print(f"{'渐进式' if st.progressive else '普通(基线)'} JPEG  "
          f"{st.width}x{st.height}  {st.size} bytes  扫描数={len(st.scans)}")
    for s in st.segments:
        note = ""
        if s.marker == parser.SOS:
            note = (f"  扫描{s.scan_index}: 熵数据 [{s.entropy_start}, "
                    f"{s.entropy_end})"
                    + ("" if s.scan_complete else "  <不完整>"))
        print(f"[{s.index:2d}] {s.name:24s} @{s.offset:7d} .. {s.end:7d} "
              f"({s.length:6d}B){note}")
    if args.json:
        print(json.dumps(d, ensure_ascii=False, indent=2))


def cmd_probe(args):
    data = _load(args.file)
    offsets = [args.offset] if args.offset is not None else None
    if offsets is None:
        results = analyzer.probe_scan_boundaries(data)
    else:
        results = [analyzer.probe(data, o) for o in offsets]
    for r in results:
        print(f"@{r.offset:7d} 覆盖{r.coverage*100:6.2f}%  {r.state_label}"
              f"  已含扫描段{list(r.scan_indices)}"
              + ("  [截在段中间]" if r.mid_scan else "")
              + (f"  错误: {r.error}" if r.error else ""))


def cmd_compare(args):
    data = _load(args.file)
    early = analyzer.probe(data, args.offset).image
    full = analyzer.probe(data, len(data)).image
    res = compare.compare(early, full, crop=args.crop,
                          threshold=args.threshold)
    print(json.dumps(res.to_dict(), ensure_ascii=False, indent=2))


def cmd_export(args):
    data = _load(args.file)
    manifest = exporter.export(data, args.outdir, source_name=args.file)
    n_png = sum(1 for s in manifest["stages"] if s["png"])
    print(f"导出完成: {args.outdir}  (manifest.json + {n_png} 张阶段 PNG)")


def cmd_serve(args):
    from . import webapp
    webapp.app.run(host=args.host, port=args.port)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="jpeg-progressive-tool")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("make-samples")
    p.add_argument("dir")
    p.set_defaults(fn=cmd_make_samples)

    p = sub.add_parser("analyze")
    p.add_argument("file")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_analyze)

    p = sub.add_parser("probe")
    p.add_argument("file")
    p.add_argument("--offset", type=int, default=None)
    p.set_defaults(fn=cmd_probe)

    p = sub.add_parser("compare")
    p.add_argument("file")
    p.add_argument("--offset", type=int, required=True)
    p.add_argument("--crop", type=int, nargs=4, default=None,
                   metavar=("X0", "Y0", "X1", "Y1"))
    p.add_argument("--threshold", type=int, default=8)
    p.set_defaults(fn=cmd_compare)

    p = sub.add_parser("export")
    p.add_argument("file")
    p.add_argument("outdir")
    p.set_defaults(fn=cmd_export)

    p = sub.add_parser("serve")
    p.add_argument("--port", type=int, default=5000)
    p.add_argument("--host", default="127.0.0.1")
    p.set_defaults(fn=cmd_serve)

    args = ap.parse_args(argv)
    args.fn(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
