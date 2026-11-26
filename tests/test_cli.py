"""命令行冒烟测试。"""

import json
import subprocess
import sys

from markfinder.cli import main


def test_cli_synthetic_validate_find(tmp_path):
    data = tmp_path / "synth"
    # 两张共 12 标记，避免小样本下单个误报就让查准剧烈波动
    rc = main(["synthetic", "--out", str(data), "--sheets", "2", "--marks", "6",
               "--seed", "5", "--shape", "asym"])
    assert rc == 0
    manifest = json.loads((data / "manifest.json").read_text(encoding="utf-8"))
    assert sum(s["total_marks"] for s in manifest["sheets"]) == 12

    rc = main([
        "validate", str(data),
        "--angle-step", "10", "--min-scale", "0.75", "--max-scale", "1.4",
        "--num-scales", "5", "--threshold", "0.6",
    ])
    assert rc == 0

    tpl = json.loads((data / "ground_truth.json").read_text(encoding="utf-8"))["template"]
    sheet = data / "sheets" / "sheet_00.png"
    out = tmp_path / "out"
    rc = main([
        "find", tpl, str(sheet), "--out", str(out),
        "--state", str(out / "state.json"),
        "--angle-step", "10", "--min-scale", "0.75", "--max-scale", "1.4",
        "--num-scales", "5", "--threshold", "0.6", "--quiet",
    ])
    assert rc == 0
    assert (out / "sheet_00_matches.csv").exists()
    assert (out / "sheet_00_annotated.png").exists()
    assert (out / "state.json").exists()
