#!/usr/bin/env python3
"""生成虚构核查样例目录 samples/demo-target。

全部凭据均为带 EXAMPLE-FAKE 标记的虚构值，不含任何真实信息。
重复运行会重建样例（幂等），可用于手工体验和测试对照。

用法：python3 tools/generate_samples.py [目标目录]
"""

import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TARGET = os.path.join(HERE, "..", "samples", "demo-target")

SERVICE_FILES = {
    "etc/sshd_config": """# 虚构 sshd 配置（样例）
Port 22
PermitRootLogin yes
PasswordAuthentication yes
PubkeyAuthentication yes
""",
    "etc/nginx/nginx.conf": """# 虚构 nginx 配置（样例）
worker_processes 1;
http {
    server {
        listen 80;
        server_name demo.example;
        location / { root /var/www/demo; }
    }
}
""",
    "etc/apache2/httpd.conf": """# 虚构 Apache 配置（样例）
Listen 80
ServerName demo.example
""",
    "etc/systemd/demo.service": """[Unit]
Description=Demo Service (fictional)
[Service]
Type=simple
User=root
ExecStart=/opt/demo/bin/demo-server --config /etc/demo/app.conf
[Install]
WantedBy=multi-user.target
""",
    "etc/systemd/writable-exec.service": """[Unit]
Description=Demo Service With Writable Exec (fictional)
[Service]
Type=simple
ExecStart=/opt/demo/bin/world-writable.sh
[Install]
WantedBy=multi-user.target
""",
    "etc/demo/app.conf": """# 虚构服务配置（样例）
listen = 0.0.0.0:9000
api_key = "EXAMPLE-FAKE-API-KEY-1234567890"
db_url = postgres://demo:EXAMPLE-FAKE-DB-PASSWORD@db.internal:5432/demo
""",
    "etc/demo/app.env": """# 虚构环境文件（样例）
export DB_PASSWORD=EXAMPLE-FAKE-DB-PASSWORD
TOKEN=EXAMPLE-FAKE-TOKEN-abcdef123456
""",
    "etc/demo/safe-app.conf": """# 安全对照样例：无敏感值、仅本地监听
listen = 127.0.0.1:9001
log_level = info
""",
}

KEY_FILES = {
    "etc/demo/db-credentials.conf": (
        "# 虚构数据库凭据（样例）\n"
        "username=demo_app\n"
        "password=EXAMPLE-FAKE-DB-CREDENTIAL-PASSWORD\n"
    ),
    "etc/demo/demo.key": (
        "-----BEGIN PRIVATE KEY-----\n"
        "EXAMPLE-FAKE-KEY-MATERIAL-DO-NOT-USE-1234567890\n"
        "-----END PRIVATE KEY-----\n"
    ),
}

SCRIPTS = {
    "opt/demo/bin/demo-server": "#!/bin/sh\necho 'fictional demo server, never executed by the audit tool'\n",
    "opt/demo/bin/world-writable.sh": "#!/bin/sh\necho 'fictional writable script'\n",
}

PLAIN_FILES = {
    "opt/demo/conf/normal.conf": "mode = 0644\nname = demo\n",
    "opt/demo/conf/group-writable.conf": "mode = 0664\nname = demo\n",
    "tmp/sticky/world-writable.txt": "公共写入目录 + 粘滞位的安全对照样例\n",
    "tmp/non-sticky/world-writable.txt": "公共写入目录且无粘滞位的风险样例\n",
}


def write_file(root: str, rel: str, content: str, mode: int | None = None) -> None:
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", errors="ignore") as handle:
        handle.write(content)
    if mode is not None:
        os.chmod(path, mode)


def write_bytes(root: str, rel: str, content: bytes, mode: int | None = None) -> None:
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(content)
    if mode is not None:
        os.chmod(path, mode)


def _restore_writable(path: str) -> None:
    """自顶向下恢复目录写/进入权限，使 rmtree 能处理 000 夹具目录。

    os.walk 无法进入无权限目录，因此用显式栈：先 chmod 当前目录再列其子目录。
    """
    stack = [path]
    while stack:
        current = stack.pop()
        try:
            os.chmod(current, 0o700)
        except OSError:
            continue
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    if entry.is_dir(follow_symlinks=False):
                        stack.append(entry.path)
        except OSError:
            pass


def main(target: str) -> None:
    if os.path.exists(target):
        _restore_writable(target)
        shutil.rmtree(target)
    os.makedirs(target)

    for rel, content in SERVICE_FILES.items():
        write_file(target, rel, content, 0o644)
    # 非 UTF-8 文本：触发 parse_error（decode_failed）
    write_bytes(target, "etc/demo/broken.conf",
                b"key = value\n\t\x80\x81\xff not-valid-utf8\n", 0o644)
    # 伪装成配置的二进制内容：触发 parse_error（binary_file）
    write_bytes(target, "etc/demo/binary.conf",
                b"\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00", 0o644)
    for rel, content in KEY_FILES.items():
        write_file(target, rel, content, 0o644)  # 故意全局可读，触发敏感文件规则
    for rel, content in SCRIPTS.items():
        write_file(target, rel, content, 0o755)
    for rel, content in PLAIN_FILES.items():
        write_file(target, rel, content, 0o644)

    # 组可写配置
    os.chmod(os.path.join(target, "opt/demo/conf/group-writable.conf"), 0o664)
    # 全局可写文件（高危）
    write_file(target, "opt/demo/conf/open.conf", "anyone = can-write\n", 0o666)
    # 全局可写脚本（高危）
    os.chmod(os.path.join(target, "opt/demo/bin/world-writable.sh"), 0o777)
    # setuid / setgid 位（chmod 在普通用户下也可设置自己拥有的文件）
    write_file(target, "opt/demo/bin/setuid-tool", "#!/bin/sh\necho fictional\n", 0o4755)
    write_file(target, "opt/demo/bin/setgid-tool", "#!/bin/sh\necho fictional\n", 0o2755)

    # 目录权限对照
    os.chmod(os.path.join(target, "tmp/sticky"), 0o1777)
    os.chmod(os.path.join(target, "tmp/non-sticky"), 0o777)

    # 符号链接：越界、循环、断裂、目录内安全链接
    os.makedirs(os.path.join(target, "links"), exist_ok=True)
    outside = os.path.join(os.path.dirname(target), "OUTSIDE-SECRET.txt")
    with open(outside, "w", encoding="utf-8") as handle:
        handle.write("scope test: the audit tool must never read this file\n")
    os.symlink(outside, os.path.join(target, "links/escape-link"))
    os.symlink("loop-a", os.path.join(target, "links/loop-a"))
    os.symlink("loop-b", os.path.join(target, "links/loop-b"))
    os.symlink("missing-target", os.path.join(target, "links/broken-link"))
    os.symlink("../etc/sshd_config", os.path.join(target, "links/internal-link"))

    # 不可读目录（尽力而为；root 环境下 chmod 限制无效，测试里会跳过相关断言）
    locked = os.path.join(target, "locked-dir")
    os.makedirs(locked)
    write_file(target, "locked-dir/secret.txt", "cannot read me\n", 0o644)
    os.chmod(locked, 0o000)

    print(f"样例目录已生成：{os.path.abspath(target)}")
    print("全部凭据均为 EXAMPLE-FAKE 虚构值；重新运行本脚本可重建样例。")


if __name__ == "__main__":
    target = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_TARGET
    main(target)
