"""项目保存/回放、对照模块与 CLI 端到端测试。"""

import json
import os
import subprocess
import sys

import numpy as np
import pytest
from PIL import Image

from seamsqueeze import MaskSet, SeamEngine
from seamsqueeze.compare import build_comparison, center_crop, normal_scale
from seamsqueeze.demo import make_sparse
from seamsqueeze.project import Project, sha256_file

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(REPO_ROOT, "tools", "cli.py")


def _save_source(tmp_path, name="sparse.png"):
    image, masks = make_sparse()
    path = str(tmp_path / name)
    Image.fromarray(image).save(path)
    return path, image, masks


def test_project_roundtrip_replay_is_pixel_identical(tmp_path):
    source_path, image, masks = _save_source(tmp_path)
    engine = SeamEngine(image, masks)
    engine.resize_to(460, 260, order="alternate")
    expected = engine.image.copy()

    project_path = str(tmp_path / "proj.json")
    from seamsqueeze.project import build_project

    project = build_project(source_path, masks, engine, "alternate")
    project.save(project_path)

    loaded = Project.load(project_path)
    replayed_engine, replayed = loaded.replay()
    assert np.array_equal(replayed, expected)
    # 源像素映射与被删位置也一致。
    assert replayed_engine.removed_ids == engine.removed_ids


def test_replay_rejects_tampered_source(tmp_path):
    source_path, image, masks = _save_source(tmp_path)
    engine = SeamEngine(image, masks)
    engine.resize_to(500, 280)
    project_path = str(tmp_path / "proj.json")
    from seamsqueeze.project import build_project

    build_project(source_path, masks, engine, "alternate").save(project_path)

    # 篡改源图（保留尺寸）。
    tampered = image.copy()
    tampered[::10, ::10] = 0
    Image.fromarray(tampered).save(source_path)
    with pytest.raises(Exception, match="哈希"):
        Project.load(project_path).replay()


def test_comparison_outputs_same_target_size(tmp_path):
    source_path, image, masks = _save_source(tmp_path)
    engine = SeamEngine(image, masks)
    # 只压宽度：水平方向保护行剩余自由像素足够，目标可稳定达成。
    engine.resize_to(600, engine.size[1])
    panels = build_comparison(image, engine.image, 600, engine.size[1])
    for name, arr in panels.items():
        assert arr.shape[1] == 600 and arr.shape[0] == engine.size[1], name
    # 普通缩放是均匀的：直接 resize 必须逐像素一致。
    assert np.allclose(
        panels["scale"], normal_scale(image, 600, engine.size[1]), atol=2
    )
    assert panels["crop"].shape[:2] == center_crop(
        image, 600, engine.size[1]
    ).shape[:2]


def test_cli_run_preview_replay(tmp_path):
    out = tmp_path / "out"
    preview = tmp_path / "preview"
    replay_out = tmp_path / "replay"
    source_path, _image, masks = _save_source(tmp_path)

    def rect_args(rects, flag):
        args = []
        for r in rects:
            args += [flag, f"{r.x0},{r.y0},{r.x1},{r.y1}:{r.name}"]
        return args

    cmd = [
        sys.executable, "-I", CLI, "run", source_path,
        "--out", str(out), "--target", "460", "260",
        "--order", "width_first",
    ]
    cmd += rect_args(masks.protect, "--protect")
    cmd += rect_args(masks.shrink, "--shrink")
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=REPO_ROOT)
    assert proc.returncode == 0, proc.stderr

    for fname in (
        "result_seam.png", "result_removed.png", "result_compare.png",
        "result_project.json", "result_report.md",
    ):
        assert (out / fname).exists(), fname

    # 源图未被覆盖。
    assert sha256_file(source_path)  # 文件仍可正常读取
    project = json.loads((out / "result_project.json").read_text())
    assert project["target_size"] == [460, 260]

    # preview 子命令。
    pv = [
        sys.executable, "-I", CLI, "preview", source_path,
        "--out", str(preview), "--target", "460", "260", "--every", "30",
    ]
    pv += rect_args(masks.protect, "--protect")
    pv += rect_args(masks.shrink, "--shrink")
    proc = subprocess.run(pv, capture_output=True, text=True, cwd=REPO_ROOT)
    assert proc.returncode == 0, proc.stderr
    assert any(p.name.startswith("step_") for p in preview.iterdir())

    # replay 子命令，从项目 + 源图复现。
    rp = [
        sys.executable, "-I", CLI, "replay",
        str(out / "result_project.json"), "--out", str(replay_out),
    ]
    proc = subprocess.run(rp, capture_output=True, text=True, cwd=REPO_ROOT)
    assert proc.returncode == 0, proc.stderr
    replayed = np.asarray(Image.open(replay_out / "replayed_result.png").convert("RGB"))
    direct = np.asarray(Image.open(out / "result_seam.png").convert("RGB"))
    assert np.array_equal(replayed, direct)


def test_cli_rejects_oversized_target(tmp_path):
    source_path, _image, masks = _save_source(tmp_path)
    proc = subprocess.run(
        [sys.executable, "-I", CLI, "run", source_path,
         "--out", str(tmp_path / "x"), "--target", "900", "400"],
        capture_output=True, text=True, cwd=REPO_ROOT,
    )
    assert proc.returncode == 2
    assert "拒绝" in proc.stderr or "保护" in proc.stderr or "大于" in proc.stderr
