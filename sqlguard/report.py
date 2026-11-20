"""报告生成：文本与 JSON 两种格式，输出顺序稳定。"""
from __future__ import annotations

import json

SEVERITY_ZH = {"high": "高危", "medium": "中危", "low": "低危"}
CONFIDENCE_ZH = {"confirmed": "确认", "uncertain": "不确定"}


def partition_findings(findings, ignores):
    """按忽略清单拆分发现。ignores 的键可以是发现编号或规则号。"""
    active, ignored = [], []
    for f in sorted(findings, key=lambda f: f.sort_key()):
        reason = None
        if f.id in ignores:
            reason = ignores[f.id]
        elif f.rule in ignores:
            reason = ignores[f.rule]
        if reason is None:
            active.append(f)
        else:
            ignored.append((f, reason))
    return active, ignored


def render_json(result, active, ignored):
    doc = {
        "summary": {
            "files_scanned": result.files_scanned,
            "findings": len(active),
            "ignored": len(ignored),
            "errors": len(result.errors),
        },
        "findings": [f.to_dict() for f in active],
        "ignored": [dict(f.to_dict(), ignore_reason=reason)
                    for f, reason in ignored],
        "errors": sorted(result.errors, key=lambda e: e["file"]),
    }
    return json.dumps(doc, ensure_ascii=False, indent=2)


def render_text(result, active, ignored):
    lines = []
    lines.append("====== SQL 注入静态扫描报告 ======")
    lines.append(f"扫描文件: {result.files_scanned} 个")
    lines.append(f"发现: {len(active)} 条（已忽略 {len(ignored)} 条）")
    lines.append(f"解析/读取失败: {len(result.errors)} 个")
    lines.append("")
    for idx, f in enumerate(active, 1):
        sev = SEVERITY_ZH.get(f.severity, f.severity)
        conf = CONFIDENCE_ZH.get(f.confidence, f.confidence)
        lines.append(f"---- 发现 {idx}/{len(active)} ----")
        lines.append(f"[{f.id}] {sev}/{conf}  {f.file}:{f.line}")
        lines.append(f"规则: {f.rule} {f.message}")
        if f.snippet:
            lines.append(f"代码: {f.snippet}")
        lines.append("传播路径:")
        for i, s in enumerate(f.path, 1):
            lines.append(f"  {i}. {s.text} ({s.file}:{s.line})")
        lines.append("")
    if ignored:
        lines.append("已忽略的发现:")
        for f, reason in ignored:
            lines.append(
                f"  [{f.id}] {f.file}:{f.line} {f.message}"
                f"（忽略原因: {reason or '未填写'}）")
        lines.append("")
    if result.errors:
        lines.append("无法分析的文件（需要人工关注，未当作安全跳过）:")
        for e in sorted(result.errors, key=lambda x: x["file"]):
            lines.append(f"  {e['file']}: {e['error']}")
        lines.append("")
    if not active:
        lines.append("未发现需要处理的问题。")
    return "\n".join(lines)
