"""Run all static and dynamic checks in one shot.

* compiles every module (catches syntax errors),
* imports the package (catches import-time errors),
* runs the self-test (end-to-end correctness on synthetic ground truth),
* generates the demo sample and runs a CLI restore against the sharp reference.

Usage::

    python3 -m deblur_lab.verify            # fast
    python3 -m deblur_lab.verify --full     # also the sweep + batch

The exit code is non-zero on the first failure.
"""

from __future__ import annotations

import argparse
import compileall
import json
import subprocess
import sys
import tempfile
from pathlib import Path


def _step(title: str) -> None:
    print(f"\n=== {title} ===", flush=True)


def _run(cmd: list[str]) -> tuple[int, str]:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    out = (proc.stdout or "") + (proc.stderr or "")
    return proc.returncode, out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="verify deblur_lab")
    parser.add_argument("--full", action="store_true", help="also run sweep and batch")
    args = parser.parse_args(argv)

    pkg = Path(__file__).resolve().parent
    py = sys.executable

    _step("compile")
    ok = compileall.compile_dir(str(pkg), quiet=1, force=True)
    print("compile ok" if ok else "COMPILE FAILED")
    if not ok:
        return 1

    _step("import")
    code, out = _run([py, "-c", "import deblur_lab, deblur_lab.cli, deblur_lab.gui, deblur_lab.selftest; print('import ok')"])
    print(out.strip() or "(no output)")
    if code != 0:
        return code

    _step("selftest")
    code, out = _run([py, "-m", "deblur_lab.selftest"])
    print(out)
    if code != 0:
        return code

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        _step("gen + restore + checks")
        code, out = _run([py, "-m", "deblur_lab.cli", "gen", "--out", str(tmp / "samples")])
        print(out)
        if code != 0:
            return code
        code, out = _run([
            py, "-m", "deblur_lab.cli", "restore",
            "--image", str(tmp / "samples" / "demo" / "blurred.png"),
            "--region", "46,92,462,404,12,17,0,8",
            "--region", "534,246,916,566,101,11,1,8",
            "--out", str(tmp / "out"),
        ])
        print(out)
        if code != 0:
            return code
        checks = json.loads((tmp / "out" / "checks.json").read_text(encoding="utf-8"))
        before = checks["before"]["targets"]
        after = checks["after"]["targets"]
        print("targets before:", before)
        print("targets after :", after)
        print("untouched    :", checks["untouched"])
        print("flat noise   :", checks["flat_noise"])
        if not args.full:
            print("\nALL CHECKS PASSED")
            return 0

        _step("sweep")
        code, out = _run([
            py, "-m", "deblur_lab.cli", "sweep",
            "--image", str(tmp / "samples" / "demo" / "blurred.png"),
            "--rect", "46,92,462,404",
            "--angles", "8,12,16", "--lengths", "13,17,21",
        ])
        print(out)
        if code != 0:
            return code

        _step("batch")
        code, out = _run([
            py, "-m", "deblur_lab.cli", "gen", "--out", str(tmp / "batch"),
            "--batch", "--angles", "0,45,90", "--lengths", "7,15",
        ])
        print(out)
        if code != 0:
            return code

    print("\nALL CHECKS PASSED (full)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
