"""Create the parts of the demo project that cannot be committed as plain files.

Run from the repository root:

    python3 scripts/make_demo.py [--target demo_project]

It creates:

* ``links/outside-link``  -> a symbolic link pointing at a file outside the
  demo root (the scanner must never read it);
* ``huge/large.log``      -> a file larger than the default per-file limit (the
  scanner must report it as skipped);
* ``assets/logo.bin``     -> a binary file (the scanner must report it as skipped).

All content is synthetic. Nothing here is a real credential.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile

DEMO_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "demo_project")

# The value below is synthetic but shaped like an AWS secret so the scanner
# would flag it if it were ever read. It must never leave its own file.
OUTSIDE_SENTINEL = 'aws_secret_access_key = "Outs1deDemoSecretMustNeverBeRead0/K7MDENG0"'

BINARY_BYTES = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\x00IEND\xaeB`\x82"
)


def build(target: str) -> None:
    target = os.path.abspath(target)
    os.makedirs(target, exist_ok=True)
    for sub in ("assets", "huge", "links"):
        os.makedirs(os.path.join(target, sub), exist_ok=True)

    binary_path = os.path.join(target, "assets", "logo.bin")
    with open(binary_path, "wb") as handle:
        handle.write(BINARY_BYTES)

    huge_path = os.path.join(target, "huge", "large.log")
    # 3 MiB exceeds the default 2 MiB per-file limit.
    with open(huge_path, "w", encoding="utf-8") as handle:
        handle.write("# synthetic oversized log — must be skipped\n")
        handle.write(("filler line for the size limit test\n") * 90000)

    link_path = os.path.join(target, "links", "outside-link")
    if os.path.lexists(link_path):
        os.unlink(link_path)
    fd, outside_path = tempfile.mkstemp(prefix="wb-outside-", suffix=".env")
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(OUTSIDE_SENTINEL + "\"\n")
    os.symlink(outside_path, link_path)
    marker = os.path.join(target, "links", ".outside-target")
    with open(marker, "w", encoding="utf-8") as handle:
        handle.write(outside_path + "\n")

    print("demo project prepared at %s" % target)
    print("  outside symlink target: %s" % outside_path)
    print("  oversized file:         %s (%.1f MiB)" % (huge_path, os.path.getsize(huge_path) / 1048576))
    print("  binary file:            %s" % binary_path)


def cleanup(target: str) -> None:
    target = os.path.abspath(target)
    marker = os.path.join(target, "links", ".outside-target")
    if os.path.exists(marker):
        with open(marker, "r", encoding="utf-8") as handle:
            outside = handle.read().strip()
        if outside and os.path.exists(outside):
            os.unlink(outside)
        os.unlink(marker)
    for rel in ("huge/large.log", "assets/logo.bin", "links/outside-link"):
        path = os.path.join(target, rel)
        if os.path.lexists(path):
            os.unlink(path)
    for rel in ("huge", "assets", "links"):
        directory = os.path.join(target, rel)
        if os.path.isdir(directory) and not os.listdir(directory):
            shutil.rmtree(directory)
    print("demo project cleaned at %s" % target)


def main(argv: list = None) -> int:
    parser = argparse.ArgumentParser(description="Prepare the synthetic demo project")
    parser.add_argument("--target", default=DEMO_ROOT)
    parser.add_argument("--clean", action="store_true", help="remove generated artefacts")
    args = parser.parse_args(argv)
    if args.clean:
        cleanup(args.target)
    else:
        build(args.target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
