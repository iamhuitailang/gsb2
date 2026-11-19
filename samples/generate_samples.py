"""生成完全虚构的本地案件样例素材。

运行后在 samples/generated/ 下构建：

  source_tree/          虚构源目录（文本、子目录、相对/绝对逃逸链接、
                        边界内链接、FIFO 特殊文件、大小写冲突文件名）
  outside/              位于采集根目录之外的“越界”文件，用于验证链接逃逸
                        不会被读取
  demo_output/          演示脚本生成的案件目录（git 已忽略）

所有内容均为程序生成的虚构文本，不含任何真实数据，也不访问网络。

用法：
    python3 -I samples/generate_samples.py
"""

from __future__ import annotations

import os
import shutil
import stat
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GEN_ROOT = os.path.join(HERE, "generated")
SOURCE = os.path.join(GEN_ROOT, "source_tree")
OUTSIDE = os.path.join(GEN_ROOT, "outside")


def _write(path: str, text: str, mode: int | None = None) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    if mode is not None:
        os.chmod(path, mode)


def build() -> None:
    if os.path.exists(GEN_ROOT):
        shutil.rmtree(GEN_ROOT)
    os.makedirs(SOURCE)

    # ---- 虚构“案件”素材：一份虚构公司的内部文档 ----
    _write(
        os.path.join(SOURCE, "README.txt"),
        "虚构案件 DEMO-CASE-001\n"
        "本目录内全部内容均为程序生成的演示数据，不对应任何真实个人或组织。\n",
    )
    _write(
        os.path.join(SOURCE, "docs", "incident_notes.txt"),
        "事件记录（虚构）\n"
        "2026-11-18 发现测试环境异常登录，本文件仅用于演示采集流程。\n"
        "第3行：可疑账号 demo-user，来源 IP 203.0.113.42（文档用途保留地址段）。\n",
    )
    _write(
        os.path.join(SOURCE, "docs", "ledger.csv"),
        "time,user,action\n"
        "2026-11-18T09:12:00Z,demo-user,login\n"
        "2026-11-18T09:13:05Z,demo-user,download\n"
        "2026-11-18T09:15:44Z,demo-user,logout\n",
    )
    _write(
        os.path.join(SOURCE, "logs", "app.log"),
        "INFO start\nWARN retry after timeout\nERROR demo failure injected\nINFO stop\n",
    )
    _write(
        os.path.join(SOURCE, "data", "blob.bin"),
        bytes((i % 251 for i in range(2048))).decode("latin-1"),
    )

    # 大小写冲突：macOS 默认文件系统大小写不敏感，用于演示冲突检测
    case_dir = os.path.join(SOURCE, "case_mix")
    os.makedirs(case_dir)
    try:
        _write(os.path.join(case_dir, "Report.txt"), "lower-name file\n")
        _write(os.path.join(case_dir, "REPORT.TXT"), "upper-name file\n")
        if os.path.samefile(
            os.path.join(case_dir, "Report.txt"),
            os.path.join(case_dir, "REPORT.TXT"),
        ):
            # 大小写不敏感 FS：两个名字指向同一文件，改写说明并只保留一个
            _write(
                os.path.join(case_dir, "Report.txt"),
                "大小写不敏感文件系统上的演示文件\n",
            )
    except FileExistsError:
        pass

    # ---- 根目录之外的“敏感”文件（同样是虚构内容） ----
    _write(
        os.path.join(OUTSIDE, "secret.txt"),
        "虚构的越界文件：如果采集工具跟随了逃逸链接，本文件内容会被违规复制。\n",
    )

    # ---- 符号链接：边界内（应只登记链接本身，不复制目标内容） ----
    link_in = os.path.join(SOURCE, "docs", "notes_alias.txt")
    os.symlink("incident_notes.txt", link_in)

    # ---- 符号链接：相对路径逃逸（../outside/secret.txt） ----
    link_escape_rel = os.path.join(SOURCE, "escape_relative.link")
    os.symlink(os.path.join("..", "outside", "secret.txt"), link_escape_rel)

    # ---- 符号链接：绝对路径逃逸 ----
    link_escape_abs = os.path.join(SOURCE, "escape_absolute.link")
    os.symlink(os.path.join(OUTSIDE, "secret.txt"), link_escape_abs)

    # ---- 符号链接目录逃逸：链接指向根外目录，绝不能递归进入 ----
    link_dir_escape = os.path.join(SOURCE, "outside_dir.link")
    os.symlink(OUTSIDE, link_dir_escape)

    # ---- 特殊文件：FIFO（非普通文件，必须跳过且不能打开读取） ----
    fifo_path = os.path.join(SOURCE, "special", "pipe.fifo")
    os.makedirs(os.path.dirname(fifo_path), exist_ok=True)
    try:
        os.mkfifo(fifo_path)
    except OSError:
        pass

    # ---- 无读权限文件（可选，测试在非 root 下启用） ----
    unreadable = os.path.join(SOURCE, "docs", "no_read_perm.txt")
    _write(unreadable, "虚构文件：权限位 0000，用于演示读取失败处理。\n")
    if os.geteuid() != 0:
        os.chmod(unreadable, 0)

    print(f"样例源目录已生成: {SOURCE}")
    print(f"越界对照目录已生成: {OUTSIDE}")
    print("提示: 重新生成会整体重建 generated/ 目录。")


if __name__ == "__main__":
    try:
        build()
    except OSError as exc:
        print(f"生成失败: {exc}", file=sys.stderr)
        sys.exit(1)
