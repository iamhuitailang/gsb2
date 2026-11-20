"""命令行入口：无界面批量换色。

用法:
  python3 cli.py generate-samples <目录>
  python3 cli.py run <工程.json> [--out 导出目录]
"""

from __future__ import annotations

import argparse
import sys

from pixel_recolor import samples
from pixel_recolor.batch import export_batch
from pixel_recolor.project import Project


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="像素风批量换色工具（命令行）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_gen = sub.add_parser("generate-samples", help="生成示例像素图")
    p_gen.add_argument("out_dir")

    p_run = sub.add_parser("run", help="按工程文件批量换色并导出")
    p_run.add_argument("project")
    p_run.add_argument("--out", default=None, help="导出目录（默认用工程内 output_dir）")

    args = parser.parse_args(argv)

    if args.cmd == "generate-samples":
        for p in samples.generate(args.out_dir):
            print("生成:", p)
        return 0

    if args.cmd == "run":
        project = Project.load(args.project)
        batch, json_path, csv_path = export_batch(project, args.out)
        for r in batch.results:
            mark = "OK " if r.ok else "FAIL"
            print(f"[{mark}] {r.path}  方案={r.scheme}  改动像素={r.changed_pixels}"
                  + (f"  错误={r.error}" if r.error else ""))
        print(f"清单: {json_path} / {csv_path}")
        return 0 if not batch.failed else 1

    return 2


if __name__ == "__main__":
    sys.exit(main())
