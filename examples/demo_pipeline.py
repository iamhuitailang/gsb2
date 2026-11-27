"""一键端到端演示: 合成 -> 检测 -> 手动选区 -> 修补 -> 参考对比。

运行: python3 examples/demo_pipeline.py
产物在 tmp/demo_pipeline/ 下。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from badcol.badlist import BadList  # noqa: E402
from badcol.detect import ColumnSelection, detect_columns  # noqa: E402
from badcol.io_utils import load_frames  # noqa: E402
from badcol.repair import repair_batch  # noqa: E402
from badcol.report import (  # noqa: E402
    compare_with_clean,
    export_repaired,
    write_change_stats,
    write_comparison_report,
)
from badcol.synth import default_config, generate_batch, write_batch  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tmp" / "demo_pipeline"


def main() -> int:
    cfg = default_config(n_frames=8, seed=42)
    clean, defective, manifest = generate_batch(cfg)
    write_batch(OUT, cfg, defective, clean)
    print(f"[1/5] 合成 {cfg.n_frames} 帧, 注入 {len(cfg.defects)} 列坏线")

    det = detect_columns(defective)
    groups = det.columns_by_label()
    print(f"[2/5] 检测: 固定坏列 {groups['persistent']}")
    print(f"      偶发候选 {groups['intermittent']} (弱候选需人工确认)")

    # 模拟人工操作: 采纳全部强候选, 补选两帧出现的死列 255, 排除随机巧合列
    sel = ColumnSelection().apply_strong_only(det)
    sel.toggle_include(255, [0, 5])          # 已知偶发死列, 手动补选
    for e in det.evidences:
        if e.confidence == "weak" and e.col != 255:
            sel.excluded.add(e.col)
    sel.toggle_protect(120)                  # 演示保护: 噪声列暂不修
    eff = sel.effective(det)
    per_frame = [
        [c for c, fr in eff.items() if (fr is None or f in fr) and c not in sel.protected]
        for f in range(cfg.n_frames)
    ]
    bl = BadList.from_selection(
        eff, sel.protected, det.height, det.width, det.n_frames
    )
    bl.save(OUT / "badlist_curated.json", notes="人工确认后的坏列表")
    print(f"[3/5] 人工选区: 修补 {len(eff)} 列, 保护列 {sorted(sel.protected)}")

    result = repair_batch(defective, per_frame, sel.protected)
    names = [f"frame_{f:03d}.png" for f in range(cfg.n_frames)]
    export_repaired(OUT / "repaired", names, result)
    write_change_stats(OUT / "change_stats.csv", names, result)
    unreliable = result.unreliable_columns()
    print(f"[4/5] 修补完成, 不可靠位置: {unreliable or '无'}")

    cmp_ = compare_with_clean(
        defective, result.repaired, clean, per_frame, sel.protected
    )
    write_comparison_report(OUT / "clean_comparison.csv", cmp_)
    (OUT / "evidence.json").write_text(
        json.dumps([e.to_dict() for e in det.evidences], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"[5/5] 干净参考对比: 恢复MAE={cmp_['recovery_mae']:.3f} "
          f"误伤MAE={cmp_['damage_mae']:.3f}")
    print(f"      {cmp_['verdict']}")
    print(f"产物目录: {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
