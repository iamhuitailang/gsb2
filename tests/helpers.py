"""secretscan 测试公共工具。"""

import os
import tempfile


def make_tree(files: dict[str, str], root: str | None = None) -> str:
    """按 {相对路径: 文本内容} 创建一棵临时目录树, 返回根路径。"""

    base = root or tempfile.mkdtemp(prefix="secretscan-test-")
    for relative, content in files.items():
        absolute = os.path.join(base, relative)
        os.makedirs(os.path.dirname(absolute), exist_ok=True)
        with open(absolute, "w", encoding="utf-8") as handle:
            handle.write(content)
    return base
