#!/usr/bin/env python3
"""redos_scan — 静态检查 Python 正则表达式中可能导致匹配耗时的写法。

只做结构分析，绝不把表达式应用到任何输入上，因此不会被危险样本拖住。

用法:
    python3 redos_scan.py patterns.txt
    python3 redos_scan.py patterns.txt --format json

退出码:
    0  检查完成，未发现风险，也没有无法解析的表达式
    1  检查完成，存在风险发现或无法解析的表达式
    2  输入错误（文件不存在、无法解码等），没有产生检查结果
"""

from __future__ import annotations

import argparse
import json
import re
import sys

# Python 3.11+ 提供 re._parser / re._constants；更早的版本退回 sre_parse。
try:  # pragma: no cover - 取决于运行版本
    from re import _constants as _const
    from re import _parser as _parser
except ImportError:  # pragma: no cover
    import sre_constants as _const  # type: ignore
    import sre_parse as _parser  # type: ignore

MAXREPEAT = _const.MAXREPEAT

# 有界但次数上限很大的重复，按“接近无界”降级处理。
LARGE_REPEAT = 1000

# 展示用片段的最大长度。
FRAGMENT_LIMIT = 60

_REPEAT_OPS = tuple(
    op
    for op in (
        getattr(_parser, "MAX_REPEAT", None),
        getattr(_parser, "MIN_REPEAT", None),
        getattr(_parser, "POSSESSIVE_REPEAT", None),  # 3.11+
    )
    if op is not None
)
_POSSESSIVE = getattr(_parser, "POSSESSIVE_REPEAT", None)
_ATOMIC_GROUP = getattr(_parser, "ATOMIC_GROUP", None)  # 3.11+
# 反向引用 op：3.11 之前叫 BACKREF，之后叫 GROUPREF。
_BACKREF_OPS = tuple(
    op for op in (getattr(_parser, "BACKREF", None),
                  getattr(_parser, "GROUPREF", None))
    if op is not None)

_CATEGORY_NAMES = {
    _const.CATEGORY_WORD: r"\w",
    _const.CATEGORY_NOT_WORD: r"\W",
    _const.CATEGORY_DIGIT: r"\d",
    _const.CATEGORY_NOT_DIGIT: r"\D",
    _const.CATEGORY_SPACE: r"\s",
    _const.CATEGORY_NOT_SPACE: r"\S",
}

LEVEL_ORDER = {"high": 0, "medium": 1, "low": 2}
LEVEL_LABEL = {"high": "高", "medium": "中", "low": "低"}


# ---------------------------------------------------------------------------
# 结构分析
# ---------------------------------------------------------------------------

def _is_unbounded(av) -> bool:
    return av[1] == MAXREPEAT


def _is_large(av) -> bool:
    return av[1] != MAXREPEAT and av[1] >= LARGE_REPEAT


def _nullable(sub) -> bool:
    """子模式是否可能匹配空串（近似，未知结构按可为空处理）。"""
    return all(_elem_nullable(op, av) for op, av in sub)


def _elem_nullable(op, av) -> bool:
    if op in (_parser.LITERAL, _parser.NOT_LITERAL, _parser.ANY,
              _parser.IN, _parser.CATEGORY) or op in _BACKREF_OPS:
        return False
    if op in _REPEAT_OPS:
        return av[0] == 0 or _nullable(av[2])
    if op is _parser.SUBPATTERN:
        return _nullable(av[-1])
    if _ATOMIC_GROUP is not None and op is _ATOMIC_GROUP:
        return _nullable(av)
    if op is _parser.BRANCH:
        return any(_nullable(b) for b in av[1])
    if op is _parser.GROUPREF_EXISTS:
        return _nullable(av[1]) or _nullable(av[2])
    # AT / ASSERT / ASSERT_NOT 等零宽结构，以及不认识的结构：按可为空处理。
    return True


def _firstset(sub):
    """返回 (token 集合, 是否含不确定成分)。

    token 形式: ('lit', 字符) / ('cat', 类别常量) / ('any',) / ('neg',)。
    'neg' 表示否定字符集等无法精确展开的情况。
    """
    tokens = set()
    uncertain = False
    for op, av in sub:
        t, u = _elem_firstset(op, av)
        tokens |= t
        uncertain = uncertain or u
        if not _elem_nullable(op, av):
            break
    return tokens, uncertain


def _elem_firstset(op, av):
    if op is _parser.LITERAL:
        return {("lit", chr(av))}, False
    if op is _parser.NOT_LITERAL:
        return {("neg",)}, True
    if op is _parser.ANY:
        return {("any",)}, False
    if op is _parser.CATEGORY:
        return {("cat", av)}, False
    if op in _BACKREF_OPS:
        # 反向引用引用的内容未知，按不确定处理。
        return {("neg",)}, True
    if op is _parser.IN:
        return _class_firstset(av)
    if op is _parser.SUBPATTERN:
        return _firstset(av[-1])
    if _ATOMIC_GROUP is not None and op is _ATOMIC_GROUP:
        return _firstset(av)
    if op in _REPEAT_OPS:
        return _firstset(av[2])
    if op is _parser.BRANCH:
        tokens, uncertain = set(), False
        for b in av[1]:
            t, u = _firstset(b)
            tokens |= t
            uncertain = uncertain or u
        return tokens, uncertain
    if op is _parser.GROUPREF_EXISTS:
        t1, u1 = _firstset(av[1])
        t2, u2 = _firstset(av[2])
        return t1 | t2, u1 or u2
    if op in (_parser.ASSERT, _parser.ASSERT_NOT):
        return _firstset(av[1])
    # AT 等零宽结构不贡献首字符。
    return set(), False


def _class_firstset(items):
    tokens = set()
    uncertain = False
    negated = False
    for op, av in items:
        if op is _parser.NEGATE:
            negated = True
        elif op is _parser.LITERAL:
            tokens.add(("lit", chr(av)))
        elif op is _parser.RANGE:
            lo, hi = av
            if hi - lo <= 128:
                for c in range(lo, hi + 1):
                    tokens.add(("lit", chr(c)))
            else:
                # 范围太大不逐个展开，按不确定处理。
                uncertain = True
                tokens.add(("neg",))
        elif op is _parser.CATEGORY:
            tokens.add(("cat", av))
    if negated:
        # 否定字符集覆盖范围太广，无法精确表示。
        return {("neg",)}, True
    return tokens, uncertain


def _lit_in_category(ch, cat):
    """字符是否属于该类别；无法判断返回 None。"""
    if cat is _const.CATEGORY_WORD:
        return ch == "_" or ch.isalnum()
    if cat is _const.CATEGORY_NOT_WORD:
        return not (ch == "_" or ch.isalnum())
    if cat is _const.CATEGORY_DIGIT:
        return ch.isdigit()
    if cat is _const.CATEGORY_NOT_DIGIT:
        return not ch.isdigit()
    if cat is _const.CATEGORY_SPACE:
        return ch.isspace()
    if cat is _const.CATEGORY_NOT_SPACE:
        return not ch.isspace()
    return None


def _cat_overlap(c1, c2):
    """两个类别是否可能匹配同一字符；无法判断返回 None。"""
    if c1 == c2:
        return True
    neg_cats = (_const.CATEGORY_NOT_WORD, _const.CATEGORY_NOT_DIGIT,
                _const.CATEGORY_NOT_SPACE)
    if c1 in neg_cats or c2 in neg_cats:
        return None
    pair = {c1, c2}
    if pair == {_const.CATEGORY_WORD, _const.CATEGORY_DIGIT}:
        return True  # 数字属于 \w
    if pair == {_const.CATEGORY_WORD, _const.CATEGORY_SPACE}:
        return False
    if pair == {_const.CATEGORY_DIGIT, _const.CATEGORY_SPACE}:
        return False
    return None


def _token_overlap(t1, t2):
    """两个 token 是否可能匹配同一字符: True / False / None(不确定)。"""
    if ("neg",) in (t1, t2):
        return None
    if t1 == ("any",) or t2 == ("any",):
        return True
    k1, v1 = t1
    k2, v2 = t2
    if k1 == "lit" and k2 == "lit":
        return v1 == v2
    if k1 == "cat" and k2 == "cat":
        return _cat_overlap(v1, v2)
    if k1 == "lit" and k2 == "cat":
        return _lit_in_category(v1, v2)
    if k1 == "cat" and k2 == "lit":
        return _lit_in_category(v2, v1)
    return None


def _sets_overlap(s1, s2):
    """两个首字符集合是否可能重叠: True / False / None(不确定)。"""
    undecided = False
    for t1 in s1:
        for t2 in s2:
            r = _token_overlap(t1, t2)
            if r is True:
                return True
            if r is None:
                undecided = True
    return None if undecided else False


def _contains_backref(sub) -> bool:
    for op, av in sub:
        if op in _BACKREF_OPS:
            return True
        for child in _children(op, av):
            if _contains_backref(child):
                return True
    return False


def _has_unbounded_or_large_repeat(sub) -> bool:
    for op, av in sub:
        if op in _REPEAT_OPS and (_is_unbounded(av) or _is_large(av)):
            return True
        for child in _children(op, av):
            if _has_unbounded_or_large_repeat(child):
                return True
    return False


def _children(op, av):
    if op in _REPEAT_OPS:
        return [av[2]]
    if op is _parser.SUBPATTERN:
        return [av[-1]]
    if _ATOMIC_GROUP is not None and op is _ATOMIC_GROUP:
        return [av]
    if op is _parser.BRANCH:
        return list(av[1])
    if op is _parser.GROUPREF_EXISTS:
        return [av[1], av[2]]
    if op in (_parser.ASSERT, _parser.ASSERT_NOT):
        return [av[1]]
    return []


def _iter_top_branches(sub):
    """找出子模式顶层（穿过 SUBPATTERN 包装）的所有 BRANCH 节点。

    解析器会把 (a|ab) 改写成 a(b|) 这样的前缀分解形式，因此不能只找
    “整体就是一个分支”的情况，要扫描顶层序列里的每个 BRANCH 元素。
    """
    for op, av in sub:
        if op is _parser.BRANCH:
            yield av[1]
        elif op is _parser.SUBPATTERN:
            yield from _iter_top_branches(av[-1])
        # 原子组/占有型量词切断回溯，不深入。


# ---------------------------------------------------------------------------
# 片段渲染（仅用于报告展示，不保证可重新编译）
# ---------------------------------------------------------------------------

def _render_seq(sub) -> str:
    return "".join(_render_atom(op, av) for op, av in sub)


def _render_class(items) -> str:
    body = ""
    for op, av in items:
        if op is _parser.NEGATE:
            body += "^"
        elif op is _parser.LITERAL:
            body += re.escape(chr(av))
        elif op is _parser.RANGE:
            body += re.escape(chr(av[0])) + "-" + re.escape(chr(av[1]))
        elif op is _parser.CATEGORY:
            body += _CATEGORY_NAMES.get(av, "?")
    return "[" + body + "]"


def _render_atom(op, av) -> str:
    if op is _parser.LITERAL:
        return re.escape(chr(av))
    if op is _parser.NOT_LITERAL:
        return "[^" + re.escape(chr(av)) + "]"
    if op is _parser.ANY:
        return "."
    if op is _parser.CATEGORY:
        return _CATEGORY_NAMES.get(av, "?")
    if op in _BACKREF_OPS:
        return "\\" + str(av)
    if op is _parser.IN:
        return _render_class(av)
    if op is _parser.SUBPATTERN:
        return "(" + _render_seq(av[-1]) + ")"
    if _ATOMIC_GROUP is not None and op is _ATOMIC_GROUP:
        return "(?>" + _render_seq(av) + ")"
    if op is _parser.BRANCH:
        return "(?:" + "|".join(_render_seq(b) for b in av[1]) + ")"
    if op in _REPEAT_OPS:
        return _render_repeat(op, av)
    return "?"


def _render_repeat(op, av) -> str:
    minr, maxr, body = av
    inner = _render_seq(body)
    if len(body) != 1 or body[0][0] in _REPEAT_OPS:
        inner = "(?:" + inner + ")"
    if minr == 0 and maxr == MAXREPEAT:
        quant = "*"
    elif minr == 1 and maxr == MAXREPEAT:
        quant = "+"
    elif minr == 0 and maxr == 1:
        quant = "?"
    elif maxr == MAXREPEAT:
        quant = "{%d,}" % minr
    else:
        quant = "{%d,%d}" % (minr, maxr)
    if op is _parser.MIN_REPEAT:
        quant += "?"
    elif _POSSESSIVE is not None and op is _POSSESSIVE:
        quant += "+"
    return inner + quant


def _fragment(op, av) -> str:
    text = _render_repeat(op, av) if op in _REPEAT_OPS else _render_seq([(op, av)])
    if len(text) > FRAGMENT_LIMIT:
        text = text[: FRAGMENT_LIMIT - 3] + "..."
    return text


# ---------------------------------------------------------------------------
# 检查规则
# ---------------------------------------------------------------------------

def _finding(level, kind, fragment, message, confidence="high"):
    f = {"level": level, "kind": kind, "fragment": fragment,
         "message": message}
    if confidence != "high":
        f["confidence"] = confidence
    return f


def _check_repeat(op, av, findings, in_unbounded):
    minr, maxr, body = av
    unbounded = _is_unbounded(av)
    large = _is_large(av)
    if not (unbounded or large):
        return
    if _POSSESSIVE is not None and op is _POSSESSIVE:
        # 占有型量词切断回溯，嵌套在它外面不会指数膨胀。
        return
    frag = _fragment(op, av)

    if in_unbounded:
        if unbounded:
            findings.append(_finding(
                "high", "nested-repeat", frag,
                "无界重复（如 +、*、{m,}）内部又包含无界重复，"
                "同一输入可能存在指数级拆分方式，匹配失败时会大量回溯。"))
        else:
            findings.append(_finding(
                "medium", "nested-repeat", frag,
                "无界重复内部包含次数上限很大的有界重复，"
                "最坏情况下匹配代价可能接近平方级甚至更高。"))
        return

    if _contains_backref(body):
        findings.append(_finding(
            "medium", "backref-in-repeat", frag,
            "无界重复的重复体内包含反向引用，每轮迭代都可能重新展开"
            "引用内容，输入变长时回溯代价会快速放大。"))
        return

    _check_body_branches(body, frag, findings)

    if not _has_unbounded_or_large_repeat(body) and _nullable(body):
        findings.append(_finding(
            "low", "nullable-repeat", frag,
            "重复体可以匹配空串，部分场景下会导致引擎反复尝试空迭代，"
            "建议确认这是有意写法。"))


def _literal_prefix(branch):
    """分支开头的连续字面字符（不进入子组等复杂结构）。"""
    chars = []
    for op, av in branch:
        if op is _parser.LITERAL:
            chars.append(chr(av))
        else:
            break
    return "".join(chars)


def _branches_risky(b1, b2):
    """两个分支是否可能让回溯爆炸: True / False / None(不确定)。

    关键区分：若两个分支的字面前缀相互分叉（如 bar/baz），选错的分支
    会在常数步内失败，代价是线性的，不报；只有当前缀相互包含（a / ab）、
    或首字符集合本身重叠（\\w / \\d）时，选择才会逐位复合成指数回溯。
    """
    p1, p2 = _literal_prefix(b1), _literal_prefix(b2)
    if p1 and p2:
        return p1.startswith(p2) or p2.startswith(p1)
    s1, _ = _firstset(b1)
    s2, _ = _firstset(b2)
    return _sets_overlap(s1, s2)


def _check_branch_ambiguity(branches, frag, findings):
    nullable_count = sum(1 for b in branches if _nullable(b))
    if nullable_count >= 2:
        findings.append(_finding(
            "high", "ambiguous-alternation", frag,
            "无界重复内有多个分支可以匹配相同的空内容（如 (a|a)+ 经解析器"
            "改写后的形式），每轮迭代都存在多条等价路径，可能指数级回溯。"))
        return
    if nullable_count == 1:
        findings.append(_finding(
            "high", "ambiguous-alternation", frag,
            "无界重复内的分支存在可选路径（如 (ab|a)* 中 b 可有可无），"
            "每轮迭代都有多种消费方式，匹配失败时可能指数级回溯。"))
        return
    uncertain = False
    for i in range(len(branches)):
        for j in range(i + 1, len(branches)):
            r = _branches_risky(branches[i], branches[j])
            if r is True:
                findings.append(_finding(
                    "high", "ambiguous-alternation", frag,
                    "无界重复内的多个分支可以匹配相同开头的内容，"
                    "同一段文本存在多种分支组合方式，匹配失败时可能指数级回溯。"))
                return
            if r is None:
                uncertain = True
    if uncertain:
        findings.append(_finding(
            "low", "ambiguous-alternation", frag,
            "分支是否重叠无法精确判断（含否定字符集、过大范围或反向引用等），"
            "保守提示：若分支实际可匹配相同内容，重复时可能回溯严重。",
            confidence="low"))


def _check_body_branches(body, frag, findings):
    # 整个重复体可为空时交给 nullable-repeat 规则，且引擎的空循环保护
    # 会限制这类结构的爆炸空间。
    if _nullable(body):
        return
    for branches in _iter_top_branches(body):
        _check_branch_ambiguity(branches, frag, findings)


def _check_adjacent(op1, av1, op2, av2, findings):
    if not (_is_unbounded(av1) and _is_unbounded(av2)):
        return
    if _POSSESSIVE is not None and (op1 is _POSSESSIVE or op2 is _POSSESSIVE):
        return
    s1, u1 = _firstset(av1[2])
    s2, u2 = _firstset(av2[2])
    r = _sets_overlap(s1, s2)
    frag = _fragment(op1, av1) + " 后接 " + _fragment(op2, av2)
    if len(frag) > FRAGMENT_LIMIT:
        frag = frag[: FRAGMENT_LIMIT - 3] + "..."
    if r is True:
        findings.append(_finding(
            "medium", "adjacent-repeat", frag,
            "两个相邻的无界重复可以匹配相同字符，边界划分方式随输入长度增长，"
            "最坏情况匹配代价接近平方级。"))
    elif r is None or u1 or u2:
        findings.append(_finding(
            "low", "adjacent-repeat", frag,
            "相邻无界重复是否重叠无法精确判断（含否定字符集等），"
            "保守提示：若可匹配相同字符，最坏情况接近平方级。",
            confidence="low"))


def _walk(sub, findings, in_unbounded):
    items = list(sub)
    for i, (op, av) in enumerate(items):
        if op in _REPEAT_OPS:
            _check_repeat(op, av, findings, in_unbounded)
            possessive = _POSSESSIVE is not None and op is _POSSESSIVE
            # 占有型量词内部不会向外回溯，不再把外层无界状态传进去。
            inner_state = in_unbounded if possessive else (
                in_unbounded or _is_unbounded(av) or _is_large(av))
            if possessive:
                inner_state = False
            _walk(av[2], findings, inner_state)
            if i + 1 < len(items):
                op2, av2 = items[i + 1]
                if op2 in _REPEAT_OPS:
                    _check_adjacent(op, av, op2, av2, findings)
        elif op is _parser.SUBPATTERN:
            _walk(av[-1], findings, in_unbounded)
        elif _ATOMIC_GROUP is not None and op is _ATOMIC_GROUP:
            # 原子组切断回溯，内部按全新上下文分析。
            _walk(av, findings, False)
        elif op is _parser.BRANCH:
            for b in av[1]:
                _walk(b, findings, in_unbounded)
        elif op is _parser.GROUPREF_EXISTS:
            _walk(av[1], findings, in_unbounded)
            _walk(av[2], findings, in_unbounded)
        elif op in (_parser.ASSERT, _parser.ASSERT_NOT):
            _walk(av[1], findings, False)


def analyze_pattern(pattern):
    """分析单条表达式，返回发现列表。表达式非法时抛出异常。"""
    parsed = _parser.parse(pattern)
    findings = []
    _walk(parsed, findings, False)
    findings.sort(key=lambda f: LEVEL_ORDER[f["level"]])
    return findings


# ---------------------------------------------------------------------------
# 文件扫描与输出
# ---------------------------------------------------------------------------

def scan_text(text):
    """逐行扫描，返回每行结果（空行跳过但保留原始行号）。"""
    results = []
    for lineno, raw in enumerate(text.splitlines(), 1):
        pattern = raw.strip()
        if not pattern:
            continue
        entry = {"line": lineno, "pattern": pattern}
        try:
            findings = analyze_pattern(pattern)
        except Exception as exc:  # re.error 及解析器其它异常都按“无法解析”报告
            entry["status"] = "invalid"
            entry["error"] = "%s: %s" % (type(exc).__name__, exc)
            entry["findings"] = []
        else:
            entry["status"] = "findings" if findings else "ok"
            entry["findings"] = findings
            entry["error"] = None
        results.append(entry)
    return results


def _summarize(results, total_lines):
    return {
        "total_lines": total_lines,
        "checked": sum(1 for r in results if r["status"] != "invalid"),
        "invalid": sum(1 for r in results if r["status"] == "invalid"),
        "findings": sum(len(r["findings"]) for r in results),
    }


def format_json(path, results, total_lines):
    doc = {
        "file": path,
        "summary": _summarize(results, total_lines),
        "results": results,
    }
    return json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True)


def format_text(path, results, total_lines):
    summary = _summarize(results, total_lines)
    out = [
        "文件: %s" % path,
        "共 %d 行: 检查 %d 条, 无法解析 %d 条, 风险发现 %d 条"
        % (summary["total_lines"], summary["checked"],
           summary["invalid"], summary["findings"]),
        "",
    ]
    for r in results:
        if r["status"] == "invalid":
            out.append("第 %d 行 [错误] 无法解析的表达式" % r["line"])
            out.append("  模式: %s" % r["pattern"])
            out.append("  原因: %s" % r["error"])
            out.append("")
            continue
        for f in r["findings"]:
            out.append("第 %d 行 [%s] %s"
                       % (r["line"], LEVEL_LABEL[f["level"]], f["kind"]))
            out.append("  模式: %s" % r["pattern"])
            out.append("  片段: %s" % f["fragment"])
            out.append("  原因: %s" % f["message"])
            if f.get("confidence") == "low":
                out.append("  备注: 该条为保守提示，结论不确定。")
            out.append("")
    if summary["findings"] == 0 and summary["invalid"] == 0:
        out.append("未发现问题：所有表达式均未命中已知风险模式。")
    return "\n".join(out).rstrip("\n")


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="redos_scan",
        description="静态检查文本文件中的 Python 正则表达式，"
                    "找出可能导致匹配耗时的写法（不实际运行匹配）。")
    ap.add_argument("file", help="每行一条正则表达式的文本文件（UTF-8）")
    ap.add_argument("--format", choices=["text", "json"], default="text",
                    help="输出格式，默认 text")
    args = ap.parse_args(argv)

    try:
        with open(args.file, "rb") as fh:
            raw = fh.read()
    except OSError as exc:
        print("输入错误: 无法读取文件 %s: %s" % (args.file, exc),
              file=sys.stderr)
        return 2
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        print("输入错误: 文件 %s 不是有效的 UTF-8 文本: %s" % (args.file, exc),
              file=sys.stderr)
        return 2

    results = scan_text(text)
    total_lines = len(text.splitlines())
    if args.format == "json":
        print(format_json(args.file, results, total_lines))
    else:
        print(format_text(args.file, results, total_lines))

    summary = _summarize(results, total_lines)
    return 1 if (summary["findings"] or summary["invalid"]) else 0


if __name__ == "__main__":
    sys.exit(main())
