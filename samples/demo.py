"""端到端演示：对虚构样例跑一遍完整的取证采集与复核流程。

本脚本只操作 samples/generated/ 下的虚构数据，全程离线。

用法：
    python3 -I samples/generate_samples.py
    python3 -I samples/demo.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEN_ROOT = os.path.join(REPO_ROOT, "samples", "generated")
SOURCE = os.path.join(GEN_ROOT, "source_tree")
CASES = os.path.join(GEN_ROOT, "demo_output")
CLI = os.path.join(REPO_ROOT, "forensics_cli.py")


def run(title: str, cmd: list[str], expect_rc: int | None = None) -> int:
    print("\n" + "=" * 72)
    print("$ " + " ".join(cmd))
    print("-" * 72)
    rc = subprocess.call(cmd, cwd=REPO_ROOT)
    print(f"[退出码 {rc}]")
    if expect_rc is not None and rc != expect_rc:
        print(f"!! 演示预期退出码 {expect_rc}，实际 {rc}", file=sys.stderr)
    return rc


def main() -> int:
    if not os.path.isdir(SOURCE):
        print("请先运行: python3 -I samples/generate_samples.py", file=sys.stderr)
        return 1
    if os.path.isdir(CASES):
        shutil.rmtree(CASES)
    os.makedirs(CASES)

    py = sys.executable
    case = os.path.join(CASES, "demo-case")

    # 1) 创建案件（带文件数与字节上限演示）
    run("创建案件", [py, "-I", CLI, "create", case, SOURCE,
                    "--max-files", "3", "--max-bytes", "4096"])

    # 2) 采集（含超限/越界/跳过条目，案件状态为 partial，退出码 3）
    run("首次采集（partial：超限 + 逃逸链接 + FIFO + 权限失败）",
        [py, "-I", CLI, "collect", case, SOURCE], expect_rc=3)

    # 3) 重复执行：展示续采/已存在说明（已采集的副本被复用）
    run("再次采集（续采演示：已存在副本校验后复用）",
        [py, "-I", CLI, "collect", case], expect_rc=3)

    # 4) 查看案件（只输出元数据与摘要，不输出文件正文）
    run("查看案件", [py, "-I", CLI, "info", case])

    # 5) 复核：清单完好；partial 案件的历史问题（失败/越界/超限）会在
    #    entry_problems 中逐项列出，但副本与清单本身一致，退出码 0。
    run("复核证据（清单完好，历史问题单独列出，退出码 0）",
        [py, "-I", CLI, "verify", case], expect_rc=0)

    # 6) 篡改一个副本，再复核，应当报告 changed（退出码 1）
    target = os.path.join(case, "copies", "README.txt")
    if os.path.isfile(target):
        with open(target, "a", encoding="utf-8") as fh:
            fh.write("TAMPERED\n")
        run("篡改副本后复核（报告 changed，退出码 1）",
            [py, "-I", CLI, "verify", case], expect_rc=1)

    # 7) 干净子树（仅普通文件）：展示 complete 案件
    clean_src = os.path.join(SOURCE, "logs")
    full_case = os.path.join(CASES, "full-case")
    run("对干净子树做完整采集（complete，退出码 0）",
        [py, "-I", CLI, "collect", full_case, clean_src], expect_rc=0)
    run("完整案件复核（无差异，退出码 0）",
        [py, "-I", CLI, "verify", full_case], expect_rc=0)

    # 8) 防覆盖证明：对完整案件再次采集必须被拒绝（退出码 2）
    run("拒绝覆盖完整案件（退出码 2）",
        [py, "-I", CLI, "collect", full_case], expect_rc=2)

    print("\n演示结束。案件目录:", CASES)
    return 0


if __name__ == "__main__":
    sys.exit(main())
