#!/usr/bin/env python3
"""端到端本地演示：从生成密钥到验收、试装、激活、篡改拒绝、回滚。

运行（在仓库根目录）：
    python3 examples/run_demo.py

所有状态都写在 examples/workspace/ 下，重复运行会先清空重来，
不影响机器上的任何东西。
"""
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WORK = Path(__file__).resolve().parent / "workspace"
ROOT = WORK / "updtool_state"


def run(*args, expect=0):
    cmd = [sys.executable, "-m", "update_tool", "--root", str(ROOT), *args]
    print(f"\n$ python -m update_tool --root ... {' '.join(args)}")
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=REPO)
    print((proc.stdout + proc.stderr).strip())
    if expect is not None and proc.returncode != expect:
        raise SystemExit(f"命令退出码 {proc.returncode}，期望 {expect}")
    return proc


def make_content(ver, text):
    d = WORK / f"content-{ver}"
    (d / "bin").mkdir(parents=True, exist_ok=True)
    (d / "etc").mkdir(parents=True, exist_ok=True)
    (d / "bin" / "app").write_text(f"demo-app {text}\n")
    (d / "etc" / "app.conf").write_text(f"version={ver}\n")
    return d


def main():
    shutil.rmtree(WORK, ignore_errors=True)
    WORK.mkdir(parents=True)

    print("== 1. 生成本地演示签名密钥（自动加入受信列表） ==")
    run("keygen", "--name", "demo-key-1", "--bits", "1024")
    run("trust-list")

    print("\n== 2. 打包并验收 v1.0.0，然后试装、激活 ==")
    import json
    trusted = json.loads((ROOT / "trust" / "trusted.json").read_text())
    kid = next(iter(trusted["keys"]))
    run("pack", "--content", str(make_content("1.0.0", "1.0.0")),
        "--product", "demo-app", "--channel", "stable", "--version", "1.0.0",
        "--key-id", kid, "--out", str(WORK / "pkg-1.0.0.tar.gz"))
    run("inspect", str(WORK / "pkg-1.0.0.tar.gz"))
    run("trial-install", str(WORK / "pkg-1.0.0.tar.gz"))
    run("status")
    run("activate", "--product", "demo-app", "--channel", "stable")
    run("status")

    print("\n== 3. 升级 v1.1.0 ==")
    run("pack", "--content", str(make_content("1.1.0", "1.1.0")),
        "--product", "demo-app", "--channel", "stable", "--version", "1.1.0",
        "--key-id", kid, "--out", str(WORK / "pkg-1.1.0.tar.gz"))
    run("trial-install", str(WORK / "pkg-1.1.0.tar.gz"))
    run("activate", "--product", "demo-app", "--channel", "stable")
    run("status")

    print("\n== 4. 篡改的包会被拒绝 ==")
    import io
    import tarfile
    bad = WORK / "pkg-tampered.tar.gz"
    with tarfile.open(WORK / "pkg-1.1.0.tar.gz") as tin, \
            tarfile.open(bad, "w:gz") as tout:
        for m in tin.getmembers():
            data = tin.extractfile(m).read()
            if m.name == "payload/bin/app":
                data = b"malicious content\n"
            ti = tarfile.TarInfo(m.name)
            ti.size = len(data)
            tout.addfile(ti, io.BytesIO(data))
    run("inspect", str(bad), expect=1)

    print("\n== 5. 撤销钥匙后，它签发的包一律拒绝 ==")
    run("trust-revoke", kid)
    run("inspect", str(WORK / "pkg-1.1.0.tar.gz"), expect=1)

    print("\n== 6. 回滚到 1.0.0 ==")
    run("rollback", "--product", "demo-app", "--channel", "stable")
    run("status")

    print(f"\n演示完成。状态目录：{ROOT}")
    print(f"结果记录：{ROOT / 'logs' / 'results.jsonl'}")


if __name__ == "__main__":
    main()
