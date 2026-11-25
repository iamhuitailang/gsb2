"""End-to-end smoke test driven entirely from the sample images.

Run from repo root:  python3 -I tools/smoke_test.py
Exercises EXIF parsing, alignment, ghost detection + manual marks, fusion,
tonemapping, failure handling and project save/load — without a browser.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hdrtool import engine  # noqa: E402
from hdrtool.session import Session  # noqa: E402

SAMPLES = [Path("samples/sample_dark.jpg"),
           Path("samples/sample_mid.jpg"),
           Path("samples/sample_bright.jpg")]
failures: list[str] = []


def check(cond: bool, label: str) -> None:
    print(("  ✓ " if cond else "  ✗ ") + label)
    if not cond:
        failures.append(label)


def main() -> int:
    print("1) EXIF 曝光信息")
    exifs = [engine.read_exif(str(p)) for p in SAMPLES]
    for p, e in zip(SAMPLES, exifs):
        print(f"   {p.name}: EV={e['ev']:.3f} t={e['exposure_time']} f={e['f_number']} iso={e['iso']}")
    check(all(e["ev"] is not None for e in exifs), "三张样例都读到 EXIF EV")
    check(exifs[0]["ev"] > exifs[1]["ev"] > exifs[2]["ev"], "EV 顺序为暗>中>亮")

    print("2) 缺失 EXIF 时的亮度估算")
    imgs = [engine.read_image_bgr(str(p)) for p in SAMPLES]
    est = engine.estimate_evs(imgs)
    check(est[0] > est[1] > est[2], "估算 EV 仍保持暗>中>亮顺序")

    print("3) 位移校准（直方图匹配 + NCC）")
    aligned, shifts, reports = engine.align_images(imgs)
    for name, s, r in zip([p.name for p in SAMPLES], shifts, reports):
        print(f"   {name}: shift={s} -> {r['message']}")
    check(all(r["aligned"] for r in reports), "三帧全部对齐成功")
    check(any(s != (0, 0) for s in shifts), "确实检测到了人为加入的位移")

    print("4) 重影检测（移动的红球）")
    pair_masks = engine.detect_ghost_masks(aligned)
    union = engine.union_masks(pair_masks)
    coverage = (union > 0).mean()
    print(f"   重影覆盖率: {coverage * 100:.2f}%")
    check(0.002 < coverage < 0.25, f"重影区域合理（0.2%~25%，实际 {coverage * 100:.2f}%）")

    print("5) 人工重影标记 + 来源取舍")
    # Polygon around the ball's position in the middle frame.
    mark = engine.GhostMark(
        mark_id="m1",
        points=[[0.36, 0.55], [0.54, 0.55], [0.54, 0.78], [0.36, 0.78]],
        source_index=1, label="红球取中间帧")
    fused_marked = engine.fuse_exposures(aligned, marks=[mark], auto_union=union)
    fused_plain = engine.fuse_exposures(aligned)
    diff = np.abs(fused_marked - fused_plain).mean()
    check(fused_marked.shape == imgs[0].shape, "融合输出与输入同尺寸")
    check(diff > 1e-4, f"标记区域改变了融合结果（平均差异 {diff:.5f}）")

    print("6) 色调映射（输入不被修改）")
    before = imgs[1].copy()
    out_default = engine.tonemap(fused_marked)
    out_lifted = engine.tonemap(fused_marked, exposure=0.5, shadows=0.8,
                                highlights=0.6, saturation=1.2)
    check(out_default.dtype == np.uint8 and out_default.shape == imgs[0].shape,
          "默认色调映射输出 8-bit 同尺寸")
    check(np.array_equal(before, imgs[1]), "输入图像未被修改")
    check(out_lifted.mean() != out_default.mean(), "调整参数产生不同预览")

    print("7) 对齐失败保护（构造低纹理图 + 不相关场景图）")
    flat = np.full_like(imgs[0], 128)
    _, _, rep_flat = engine.align_images([imgs[0], flat])
    check(rep_flat[1]["status"] == "error", "低纹理帧报告对齐失败而不是崩溃")
    # A genuinely unrelated frame (random content, no shared structure) must
    # be rejected by the correlation confidence gate rather than force-aligned.
    rng = np.random.default_rng(0)
    unrelated = rng.integers(0, 255, imgs[0].shape, dtype=np.uint8)
    _, _, rep_bad = engine.align_images([imgs[0], unrelated])
    check(rep_bad[1]["status"] == "error", "不相关场景被置信门槛拦截并保留原图")

    print("8) Session 全流程 + 工程保存/恢复")
    with tempfile.TemporaryDirectory() as td:
        sess = Session()
        infos = [sess.add_image(p.name, p.read_bytes()) for p in SAMPLES]
        check(all(i.ev is not None for i in infos), "Session 读到全部 EV")
        g = sess.create_group("样例场景", [i.image_id for i in infos])
        sess.align_group(g.group_id)
        sess.detect_ghosts(g.group_id)
        sess.add_mark(g.group_id, mark.points, 1, "红球取中间帧")
        sess.fuse_group(g.group_id, use_auto_ghost=True)
        params = {"exposure": 0.3, "shadows": 0.5, "highlights": 0.4, "saturation": 1.1}
        preview = sess.tonemap_preview(g.group_id, params)
        check(preview[:2] == b"\xff\xd8", "色调预览返回 JPEG 字节")

        exported = sess.export(g.group_id, Path(td) / "out", params)
        check(all(Path(v).exists() for v in exported.values()), "PNG/TIFF/参数记录均已导出")
        record = json.loads(Path(exported["params"]).read_text(encoding="utf-8"))
        check(record["tonemap_params"] == params, "参数记录内容正确")
        check(len(record["frames"]) == 3 and all(f["status"] == "ok" for f in record["frames"]),
              "参数记录含每帧状态")

        proj_path = sess.save_project(Path(td) / "p.hdrproj.json")
        payload = json.loads(proj_path.read_text(encoding="utf-8"))
        restored = Session.from_project(payload)
        rg = next(iter(restored.groups.values()))
        check(len(rg.image_ids) == 3, "恢复后图片组完整（3 帧）")
        check(len(rg.marks) == 1 and rg.marks[0].source_index == 1,
              "恢复后重影标记与来源帧完整")
        check(restored.load_ghost_union(rg.group_id) is not None,
              "恢复后自动重影掩膜完整")
        check(all(inf.aligned for inf in restored.info.values()),
              "恢复后校准状态完整")
        restored.fuse_group(rg.group_id, use_auto_ghost=True)
        check(np.allclose(restored.get_fused(rg.group_id),
                          sess.get_fused(g.group_id), atol=1e-5),
              "恢复后重新合成结果一致")

    print()
    if failures:
        print(f"失败 {len(failures)} 项:")
        for f in failures:
            print("  - " + f)
        return 1
    print("全部冒烟测试通过 ✅")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
