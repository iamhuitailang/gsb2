"""Local end-to-end self-check: demo generation, mask export and verify frames."""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from masktool.demo import demo_project, generate_demo  # noqa: E402
from masktool.media import export_project  # noqa: E402

ASSET_DIR = ROOT / "workspace" / "assets" / "demo"
OUT_DIR = ROOT / "workspace" / "selfcheck-export"


def main() -> None:
    source = generate_demo(ASSET_DIR)
    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    result = export_project(
        demo_project(),
        source,
        OUT_DIR,
        lambda ratio, stage, message: print(f"[{ratio:5.1%}] {stage}: {message}"),
    )
    video = OUT_DIR / result["video"]
    config = OUT_DIR / result["config"]
    verify = OUT_DIR / "verify"
    if not video.exists() or video.stat().st_size < 10_000:
        raise SystemExit("exported video is missing or unexpectedly small")
    if not config.exists():
        raise SystemExit("exported config is missing")
    images = list(verify.glob("*_masked.png"))
    if len(images) < 5:
        raise SystemExit(f"expected verification frames, found {len(images)}")
    print(f"OK: {video} ({video.stat().st_size} bytes), {len(images)} masked verification frames")


if __name__ == "__main__":
    main()
