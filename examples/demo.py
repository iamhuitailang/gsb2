"""端到端演示：生成样例 -> 从参考边估计 -> 双区域处理 -> 导出 -> 验证。

运行：``python3 examples/demo.py``（不需要界面）

这个脚本也是 CLI 里各步骤的等价串接，便于确认整条流水线在你机器上可用。
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402

from blurlab import synth  # noqa: E402
from blurlab.app import AppController  # noqa: E402
from blurlab.export import format_validation, validate_pair  # noqa: E402
from blurlab.image_io import load_image, load_meta  # noqa: E402
from blurlab.pipeline import process_regions  # noqa: E402
from blurlab.regions import RegionSet  # noqa: E402


def main(outdir: str = "out/demo") -> int:
    out = Path(outdir)
    paths = synth.save_sample_suite(out / "samples", width=900, height=600, seed=16317)
    print(f"[1] 样例已生成: {out / 'samples'}")

    # 用 30° / L=9 的全图拖影样例做估计
    sample = paths["variants"][0]
    ctl = AppController()
    ctl.load_blurred_sample(sample["path"])
    print(f"[2] 载入 {sample['path']}，真值 {sample['angle_deg']}° / L={sample['length_px']}")

    for edge in ctl.s.meta.get("edges", []):
        seg = (tuple(edge["probe"][0]), tuple(edge["probe"][1]))
        ctl.add_reference_edge(*seg)
    est = ctl.s.estimate
    assert est is not None
    print(
        f"    估计: 方法={est.method}  L={est.length_px:.2f}px  "
        f"θ={'未知' if est.angle_deg is None else f'{est.angle_deg:.1f}°'}  "
        f"置信度={est.confidence:.2f}"
    )
    for w in est.warnings:
        print(f"    ! {w}")

    # 双区域：分别用 meta 真值参数，演示重叠次序
    meta = ctl.s.meta
    specs = meta.get("blur_specs", [])
    if specs:
        from blurlab.deblur import DeblurParams

        for i, s in enumerate(specs):
            ctl.s.region_set.add(
                tuple(s["rect"]),
                DeblurParams(s["length_px"], s["angle_deg"]),
                label=s["label"],
                feather_px=s["feather_px"],
                priority=i,
            )
        pipe = ctl.preview()
        print(f"[3] 双区域处理完成 {pipe.elapsed_ms:.0f} ms")
        for note in pipe.notes:
            print(f"    {note}")
        exported = ctl.export(out / "result")
        print("[4] 导出:")
        for k, v in exported.items():
            print(f"    {k}: {v}")

        report = validate_pair(ctl.s.clean, ctl.s.image, pipe.result, meta)
        print("[5] 配对验证:")
        print(format_validation(report))

    # 单区域全图脱模糊示例
    ctl2 = AppController()
    ctl2.load_blurred_sample(sample["path"])
    ctl2.set_manual_estimate(sample["length_px"], sample["angle_deg"])
    ctl2.add_region((0, 0, ctl2.s.image.shape[1], ctl2.s.image.shape[0]), feather_px=0)
    pipe2 = ctl2.preview()
    rep2 = validate_pair(ctl2.s.clean, ctl2.s.image, pipe2.result, ctl2.s.meta)
    print("\n[6] 全图去模糊验证（已知真值）:")
    print(format_validation(rep2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
