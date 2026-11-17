#!/usr/bin/env python3
"""生成体积较大的演示样例（深层嵌套、边界大小输入）。

用法：python3 tools/make_samples.py
生成：
  samples/deep_nesting.xml   200 层嵌套（超过默认 64 层上限）
  samples/oversized.xml      略大于 512KB 输入上限的文档
"""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from xmlsec.inspector import LIMITS  # noqa: E402

SAMPLES = Path(__file__).resolve().parent.parent / "samples"


def make_deep_nesting(depth=200):
    lines = ['<?xml version="1.0"?>', "<!-- 深层嵌套样例：应触发嵌套深度限制 -->"]
    lines.append("<root>")
    for i in range(depth):
        lines.append(f"{'  ' * (i + 1)}<level n=\"{i + 1}\">")
    lines.append(f"{'  ' * (depth + 1)}到底了")
    for i in reversed(range(depth)):
        lines.append(f"{'  ' * (i + 1)}</level>")
    lines.append("</root>")
    (SAMPLES / "deep_nesting.xml").write_text("\n".join(lines) + "\n", encoding="utf-8")


def make_oversized():
    limit = LIMITS["max_input_bytes"]
    header = '<?xml version="1.0"?>\n<!-- 边界大小样例：总大小略超输入上限，应在解析前被拒绝 -->\n<data>\n'
    footer = "</data>\n"
    chunk = "  <item>边界大小测试数据，重复填充以超过输入上限。</item>\n"
    body = chunk * ((limit - len(header) - len(footer)) // len(chunk.encode("utf-8")) + 2)
    (SAMPLES / "oversized.xml").write_text(header + body + footer, encoding="utf-8")


if __name__ == "__main__":
    make_deep_nesting()
    make_oversized()
    for name in ("deep_nesting.xml", "oversized.xml"):
        p = SAMPLES / name
        print(f"生成 {p.name}: {p.stat().st_size} 字节")
