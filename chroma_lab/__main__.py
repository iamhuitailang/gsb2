"""命令行入口:

  python -m chroma_lab view   [图片] [--down left] [--up center] [--nearest]
  python -m chroma_lab export [图片] -o 目录 [--down left] [--up center]
  python -m chroma_lab arrays 导出目录
  python -m chroma_lab batch  -o 目录
"""
from __future__ import annotations

import argparse

from . import core, testimages


def main():
    p = argparse.ArgumentParser(prog="chroma_lab",
                                description="4:2:0 色度抽样/还原实验工具")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_common(sp):
        sp.add_argument("--down", default="left", choices=core.SITING_ORDER,
                        help="压缩端取样约定 (默认 left)")
        sp.add_argument("--up", default="center", choices=core.SITING_ORDER,
                        help="还原端取样约定 (默认 center, 与 down 不同即可看到错位)")
        sp.add_argument("--nearest", action="store_true",
                        help="还原用最近邻 instead of 双线性")

    v = sub.add_parser("view", help="交互式查看器 (点击像素检查)")
    v.add_argument("image", nargs="?", help="图片路径, 缺省用内置演示图")
    add_common(v)

    e = sub.add_parser("export", help="导出还原图和通道阵列")
    e.add_argument("image", nargs="?", help="图片路径, 缺省用内置演示图")
    e.add_argument("-o", "--out", required=True, help="输出目录")
    add_common(e)

    a = sub.add_parser("arrays", help="重新打开导出的阵列, 核对取样位置和尺寸")
    a.add_argument("bundle", help="export 生成的目录")

    b = sub.add_parser("batch", help="批量生成程序对比图和指标")
    b.add_argument("-o", "--out", required=True, help="输出目录")

    args = p.parse_args()
    method = "nearest" if getattr(args, "nearest", False) else "bilinear"

    if args.cmd == "view":
        from .viewer import Viewer
        Viewer(testimages.load_or_default(args.image),
               down_siting=args.down, up_siting=args.up, method=method)
    elif args.cmd == "export":
        from . import store
        store.export_bundle(testimages.load_or_default(args.image),
                            args.down, args.up, method, args.out)
    elif args.cmd == "arrays":
        from . import store
        store.show_bundle(args.bundle)
    elif args.cmd == "batch":
        from . import batch
        batch.run(args.out)


if __name__ == "__main__":
    main()
