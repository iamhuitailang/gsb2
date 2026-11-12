#!/usr/bin/env python3
"""修改 sample_site，制造一轮可观察的变更：
- 修改 art2 的正文与更新时间（→ changed）
- 删除 art4 并从列表页移除其链接（→ removed）
- 新增 art7 并在列表页加入链接（→ new）

首次运行前会把原始文件备份到 sample_site/.backup/。
恢复原始内容：python3 scripts/mutate_site.py --restore
"""
import re
import shutil
import sys
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent / "sample_site"
BACKUP = SITE / ".backup"
ORIGINALS = ["articles/art2.html", "articles/art4.html", "list-2.html"]


def backup():
    for rel in ORIGINALS:
        dst = BACKUP / rel
        if not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SITE / rel, dst)


def restore():
    for rel in ORIGINALS:
        src = BACKUP / rel
        if src.exists():
            shutil.copy2(src, SITE / rel)
    (SITE / "articles" / "art7.html").unlink(missing_ok=True)
    shutil.rmtree(BACKUP, ignore_errors=True)
    print("站点已恢复为初始内容。")


def mutate():
    backup()

    # 1. 修改 art2
    art2 = SITE / "articles" / "art2.html"
    text = art2.read_text(encoding="utf-8")
    text = text.replace("2026-10-22", "2026-11-12")
    text = text.replace(
        "<p>规范化需要统一大小写、去掉默认端口、排序查询参数并移除 fragment。</p>",
        "<p>规范化需要统一大小写、去掉默认端口、排序查询参数并移除 fragment。</p>\n"
        "    <p>补充：追踪参数（如 utm_source）也应在规范化时剔除，避免同一页面被重复统计。</p>",
    )
    art2.write_text(text, encoding="utf-8")

    # 2. 删除 art4 并移除列表链接
    (SITE / "articles" / "art4.html").unlink(missing_ok=True)
    list2 = SITE / "list-2.html"
    text = list2.read_text(encoding="utf-8")
    text = re.sub(r"\s*<li><a href=\"articles/art4\.html\">.*?</a></li>", "", text)

    # 3. 新增 art7 并加入列表
    (SITE / "articles" / "art7.html").write_text("""<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>导出与下游消费</title></head>
<body>
  <h1>导出与下游消费</h1>
  <p>更新时间：<time datetime="2026-11-12">2026-11-12</time></p>
  <article class="content">
    <p>采集结果可导出为 JSON 或 CSV，供下游系统消费。</p>
    <p>导出仅包含当前仍存在的页面，已消失的页面不在其中。</p>
  </article>
  <p><a href="../list-2.html">返回列表</a></p>
</body>
</html>
""", encoding="utf-8")
    text = text.replace(
        '<li><a href="articles/art6.html">历史快照与内容对比</a></li>',
        '<li><a href="articles/art6.html">历史快照与内容对比</a></li>\n'
        '      <li><a href="articles/art7.html">导出与下游消费</a></li>',
    )
    list2.write_text(text, encoding="utf-8")

    print("站点已变更：art2 修改，art4 删除，art7 新增。")
    print("恢复：python3 scripts/mutate_site.py --restore")


if __name__ == "__main__":
    if "--restore" in sys.argv:
        restore()
    else:
        mutate()
