"""命令行入口: python -m neg2pos <子命令>。

子命令:
  gen        生成模拟负片(不同片底色/曝光/污点) + 已知目标 targets.json
  calibrate  取片底与灰块 -> 卷级校准 calib.json(可看取样值并剔除异常点)
  convert    单张转正, 支持高光/暗处微调, 导出正片+预览+可重放参数
  analyze    截断警示、剩余层次、近片底/过深区域统计
  batch      批量转正, 单张失败不影响其他, 结果逐条记录
  chart      用已知目标颜色对比正片的灰阶与主要色块
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path

import numpy as np

from . import analyze as az
from . import sampling as sp
from .core import FrameAdjust, RollCalib, convert_image, load_frame_params, save_frame_params
from .imgio import list_images, load_image, save_image
from .simulate import BASES, generate_roll


def _rects(args_list):
    return [sp.parse_rect(s) for s in (args_list or [])]


def cmd_gen(a):
    out = generate_roll(a.out, frames=a.frames, base=a.base, stains=a.stains)
    print(f"已生成 {a.frames} 张模拟负片(片底={a.base} {BASES[a.base]}, 污点={a.stains}) -> {out}")
    print(f"已知目标颜色: {out/'targets.json'}; 未曝光片边宽度见 targets.json 的 border 字段")


def cmd_calibrate(a):
    img = load_image(a.image)
    base_rects = _rects(a.base_rect)
    gray_rects = _rects(a.gray_rect)
    if not base_rects or not gray_rects:
        sys.exit("需要至少一个 --base-rect(片底/片边) 和一个 --gray-rect(参考灰块), 格式 x,y,w,h")
    exclude = {int(i) for i in a.exclude.split(",")} if a.exclude else set()

    base_stats = sp.sample_rects(img, base_rects)
    gray_stats = sp.sample_rects(img, gray_rects)
    print("== 片底取样 ==")
    print(sp.format_stats(base_stats, sp.flag_outliers(base_stats), exclude))
    print("== 灰块取样 ==")
    print(sp.format_stats(gray_stats, sp.flag_outliers(gray_stats), exclude))

    base_rgb = sp.combine(base_stats, exclude)
    gray_rgb = sp.combine(gray_stats, exclude)
    roll = RollCalib(
        base_rgb=[round(float(v), 5) for v in base_rgb],
        gray_rgb=[round(float(v), 5) for v in gray_rgb],
        gray_target=a.gray_target,
        film_gamma=a.film_gamma,
        gamma=a.gamma,
        samples={
            "image": str(a.image),
            "base_rects": base_stats, "gray_rects": gray_stats,
            "excluded": sorted(exclude),
        },
    )
    roll.save(a.out)
    print(f"\n片底 RGB: {roll.base_rgb}  灰块 RGB: {roll.gray_rgb}")
    print(f"灰块密度(档): {[round(float(v),3) for v in roll.gray_densities()]}, "
          f"目标密度: {roll.target_density():.3f} 档 (film_gamma={roll.film_gamma})")
    print(f"卷级校准已保存 -> {a.out}  (同卷其他张直接用 --calib 引用)")
    if exclude:
        print(f"已手工剔除取样点: {sorted(exclude)}")


def _load_calib_and_adjust(a):
    if a.params:
        roll, adj = load_frame_params(a.params)
        print(f"从参数文件重放: {a.params}")
    else:
        roll = RollCalib.load(a.calib)
        adj = FrameAdjust(exposure=a.exposure, black=a.black, white=a.white, gamma=a.gamma)
    return roll, adj


def cmd_convert(a):
    roll, adj = _load_calib_and_adjust(a)
    img = load_image(a.image)
    pos = convert_image(img, roll, adj)
    save_image(pos, a.out)

    masks = az.region_masks(img, roll)
    rep = az.clipping_report(img, roll)
    summary = az.mask_summary(masks)
    print(az.format_report(rep))
    print("区域占比: " + ", ".join(f"{k}={v*100:.2f}%" for k, v in summary.items()))

    if a.preview:
        save_image(az.overlay_preview(pos, masks), a.preview)
        print(f"预览(蓝=近片底, 红=过深, 品红=截断) -> {a.preview}")

    params_path = a.params_out or str(Path(a.out).with_suffix(".params.json"))
    save_frame_params(params_path, roll, adj, calib_path=getattr(a, "calib", None))
    print(f"正片 -> {a.out}")
    print(f"可重放参数 -> {params_path}")
    print("卷级/单张关系(roll=卷级, frame_delta=单张增量, effective=生效):")
    print(json.dumps(adj.effective(roll), ensure_ascii=False, indent=2))


def cmd_analyze(a):
    roll = RollCalib.load(a.calib)
    img = load_image(a.image)
    rep = az.clipping_report(img, roll)
    print(az.format_report(rep))
    masks = az.region_masks(img, roll)
    summary = az.mask_summary(masks)
    print("区域占比: " + ", ".join(f"{k}={v*100:.2f}%" for k, v in summary.items()))
    if a.preview:
        pos = convert_image(img, roll, FrameAdjust())
        save_image(az.overlay_preview(pos, masks), a.preview)
        print(f"预览 -> {a.preview}")


def cmd_batch(a):
    outdir = Path(a.out)
    outdir.mkdir(parents=True, exist_ok=True)
    roll = RollCalib.load(a.calib)
    adj = FrameAdjust(exposure=a.exposure, black=a.black, white=a.white, gamma=a.gamma)
    files = list_images(a.indir)
    if not files:
        sys.exit(f"{a.indir} 下没有可处理的图像文件")
    results = []
    n_ok = 0
    for f in files:
        entry = {"file": f.name, "status": "ok", "outputs": {}, "message": ""}
        try:
            img = load_image(f)
            pos = convert_image(img, roll, adj)
            out_png = outdir / f"{f.stem}_pos.png"
            save_image(pos, out_png)
            params_path = outdir / f"{f.stem}.params.json"
            save_frame_params(params_path, roll, adj, calib_path=a.calib)
            rep = az.clipping_report(img, roll)
            entry["outputs"] = {"positive": str(out_png), "params": str(params_path)}
            entry["clipping_warning"] = rep["clipping_warning"]
            n_ok += 1
        except Exception as e:  # 单张失败不中断, 已成功的结果保留
            entry["status"] = "error"
            entry["message"] = f"{type(e).__name__}: {e}"
            traceback.print_exc()
        results.append(entry)
        print(f"[{entry['status']:>5s}] {f.name} {entry['message']}")
    (outdir / "batch_results.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2))
    print(f"\n完成 {n_ok}/{len(files)}, 明细 -> {outdir/'batch_results.json'}")
    if n_ok < len(files):
        sys.exit(1)


def cmd_chart(a):
    """用已知目标颜色检验正片: 灰阶中性度 + 主要色块偏差。"""
    targets = json.loads(Path(a.targets).read_text())
    pos = load_image(a.positive)
    rows = []
    gray_spread_worst = 0.0
    for p in targets["patches"]:
        x, y, w, h = p["rect"]
        m = 4  # 缩边取样, 避开边缘
        patch = pos[y + m:y + h - m, x + m:x + w - m].reshape(-1, 3)
        meas = np.median(patch, axis=0)
        tgt = np.asarray(p["rgb"])
        err = meas - tgt
        de = float(np.linalg.norm(err))
        spread = float(meas.max() - meas.min()) if p["name"].startswith(("gray", "ref")) else 0.0
        gray_spread_worst = max(gray_spread_worst, spread)
        rows.append({"name": p["name"], "target": p["rgb"],
                     "measured": [round(float(v), 4) for v in meas],
                     "delta": [round(float(v), 4) for v in err],
                     "err_norm": round(de, 4), "gray_spread": round(spread, 4)})
    print(f"{'色块':<10s} {'目标 R/G/B':<24s} {'实测 R/G/B':<24s} {'偏差':<24s} |Δ|")
    for r in rows:
        fmt = lambda v: f"{v[0]:.3f}/{v[1]:.3f}/{v[2]:.3f}"
        print(f"{r['name']:<10s} {fmt(r['target']):<24s} {fmt(r['measured']):<24s} "
              f"{fmt(r['delta']):<24s} {r['err_norm']:.4f}")
    print(f"\n灰阶最大通道离散(越小越中性): {gray_spread_worst:.4f}")
    if a.report:
        Path(a.report).write_text(json.dumps(
            {"patches": rows, "gray_spread_worst": round(gray_spread_worst, 4)},
            ensure_ascii=False, indent=2))
        print(f"报告 -> {a.report}")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="neg2pos", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("gen", help="生成模拟负片")
    g.add_argument("--out", required=True)
    g.add_argument("--frames", type=int, default=3)
    g.add_argument("--base", choices=sorted(BASES), default="orange")
    g.add_argument("--stains", type=int, default=0, help="片边污点数量")
    g.set_defaults(fn=cmd_gen)

    c = sub.add_parser("calibrate", help="片底+灰块 -> 卷级校准")
    c.add_argument("--image", required=True)
    c.add_argument("--base-rect", action="append", help="片底取样矩形 x,y,w,h, 可多次")
    c.add_argument("--gray-rect", action="append", help="灰块取样矩形 x,y,w,h, 可多次")
    c.add_argument("--exclude", default="", help="手工剔除的取样点序号, 逗号分隔")
    c.add_argument("--gray-target", type=float, default=0.18)
    c.add_argument("--film-gamma", type=float, default=1.0,
                   help="胶片特性曲线指数; 用本工具 gen 生成的模拟负片为 1.6")
    c.add_argument("--gamma", type=float, default=1.0)
    c.add_argument("--out", required=True)
    c.set_defaults(fn=cmd_calibrate)

    v = sub.add_parser("convert", help="单张转正")
    v.add_argument("--image", required=True)
    v.add_argument("--calib", help="卷级校准 json")
    v.add_argument("--params", help="直接重放此前导出的单张参数 json")
    v.add_argument("--exposure", type=float, default=0.0, help="曝光微调(档)")
    v.add_argument("--black", type=float, default=0.0, help="暗处黑点 [0,1)")
    v.add_argument("--white", type=float, default=1.0, help="高光白点 (0,1]")
    v.add_argument("--gamma", type=float, default=1.0, help="单张附加 gamma")
    v.add_argument("--preview", help="带区域标记的预览图路径")
    v.add_argument("--params-out", help="可重放参数输出路径")
    v.add_argument("--out", required=True)
    v.set_defaults(fn=cmd_convert)

    z = sub.add_parser("analyze", help="截断与区域分析")
    z.add_argument("--image", required=True)
    z.add_argument("--calib", required=True)
    z.add_argument("--preview")
    z.set_defaults(fn=cmd_analyze)

    b = sub.add_parser("batch", help="批量转正")
    b.add_argument("--indir", required=True)
    b.add_argument("--calib", required=True)
    b.add_argument("--out", required=True)
    b.add_argument("--exposure", type=float, default=0.0)
    b.add_argument("--black", type=float, default=0.0)
    b.add_argument("--white", type=float, default=1.0)
    b.add_argument("--gamma", type=float, default=1.0)
    b.set_defaults(fn=cmd_batch)

    t = sub.add_parser("chart", help="已知目标颜色对比")
    t.add_argument("--positive", required=True)
    t.add_argument("--targets", required=True)
    t.add_argument("--report")
    t.set_defaults(fn=cmd_chart)

    args = ap.parse_args(argv)
    if getattr(args, "cmd", None) == "convert" and not args.params and not args.calib:
        ap.error("convert 需要 --calib 或 --params 之一")
    args.fn(args)


if __name__ == "__main__":
    main()
