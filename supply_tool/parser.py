# -*- coding: utf-8 -*-
"""供应单 PDF 明细解析。

只支持样例所用的两种版式:
  A 版「供应单」: 行号 / 品名 / 数量 / 金额(元)
  B 版「供货清单」: 序号 / 商品名称 / 数量 / 单价 / 金额(元)

跨页规则:
  - 后续页会重印表头, 重印表头不算明细;
  - 一页末尾可能只有行号+品名, 数量和金额印在下一页开头, 需要拼接;
  - 品名也可能在同一页内断成两行, 拼接后标记为待校对。

每条明细保留 segments(来自哪一页、原文位置 bbox、原文文本),
供校对界面并排对照。
"""
import re
from decimal import Decimal, InvalidOperation

import pymupdf

LAYOUTS = {
    "A": {
        "title": "供应单",
        "columns": [("no", "行号"), ("name", "品名"), ("qty", "数量"), ("amount", "金额")],
    },
    "B": {
        "title": "供货清单",
        "columns": [("no", "序号"), ("name", "商品名称"), ("qty", "数量"),
                    ("price", "单价"), ("amount", "金额")],
    },
}

FIELD_LABELS = {"no": "行号", "name": "品名", "qty": "数量", "price": "单价", "amount": "金额"}

NO_RE = re.compile(r"^\d{1,4}$")
TOTAL_WORD_RE = re.compile(r"合计|总计")
ORDER_NO_RE = re.compile(r"单号\s*[:：]\s*([A-Za-z0-9\-]+)")
MONEY_RE = re.compile(r"-?\d+\.\d{2}")

FLAG_LABELS = {
    "cross_page": "跨页拼接",
    "name_split": "品名断行, 已自动拼接, 请校对",
    "incomplete": "明细不完整(缺数量或金额)",
    "conflict": "拼接时字段冲突, 请校对",
}


class ParseError(Exception):
    pass


def _page_lines(page, y_tol=3.0):
    """把一页的单词按 y 坐标聚成文本行, 每行带 bbox。"""
    words = page.get_text("words")  # x0,y0,x1,y1,word,block,line,word_no
    lines = []
    for w in sorted(words, key=lambda w: ((w[1] + w[3]) / 2, w[0])):
        cy = (w[1] + w[3]) / 2
        for ln in lines:
            if abs(ln["cy"] - cy) <= y_tol:
                ln["words"].append(w)
                break
        else:
            lines.append({"cy": cy, "words": [w]})
    for ln in lines:
        ln["words"].sort(key=lambda w: w[0])
        ln["text"] = " ".join(w[4] for w in ln["words"])
        ln["bbox"] = [min(w[0] for w in ln["words"]), min(w[1] for w in ln["words"]),
                      max(w[2] for w in ln["words"]), max(w[3] for w in ln["words"])]
    lines.sort(key=lambda l: l["cy"])
    return lines


def _match_header(line, layout):
    """若该行是表头行, 返回 {字段: 列中心x}; 否则 None。"""
    centers = {}
    for key, token in layout["columns"]:
        hit = None
        for w in line["words"]:
            if token in w[4]:
                hit = (w[0] + w[2]) / 2
                break
        if hit is None:
            return None
        centers[key] = hit
    return centers


def _col_boundaries(centers, keys):
    """由列中心算列边界(相邻中心的中点)。"""
    pts = [centers[k] for k in keys]
    bounds = []
    for i in range(len(pts) - 1):
        bounds.append((pts[i] + pts[i + 1]) / 2)
    return bounds  # len = n-1


def _line_fields(line, keys, bounds):
    """把一行内的单词按 x 落入各列, 返回 {字段: 文本}。"""
    cols = {k: [] for k in keys}
    for w in line["words"]:
        cx = (w[0] + w[2]) / 2
        idx = 0
        while idx < len(bounds) and cx > bounds[idx]:
            idx += 1
        cols[keys[idx]].append(w[4])
    return {k: " ".join(v) for k, v in cols.items() if v}


def _new_row(fields, seg):
    row = {"no": "", "name": "", "qty": "", "price": "", "amount": "",
           "segments": [seg], "flags": []}
    for k in ("no", "name", "qty", "price", "amount"):
        if fields.get(k):
            row[k] = fields[k]
    return row


def _merge(row, fields, seg, page_no):
    if row["segments"][-1]["page"] != page_no and \
            all(s["page"] != page_no for s in row["segments"]):
        if "cross_page" not in row["flags"]:
            row["flags"].append("cross_page")
    if fields.get("name"):
        if row["name"]:
            row["name"] += fields["name"]
            if "name_split" not in row["flags"]:
                row["flags"].append("name_split")
        else:
            row["name"] = fields["name"]
    for k in ("no", "qty", "price", "amount"):
        if fields.get(k):
            if row[k]:
                if "conflict" not in row["flags"]:
                    row["flags"].append("conflict")
            else:
                row[k] = fields[k]
    row["segments"].append(seg)


def _finalize(row):
    if not row["qty"] or not row["amount"]:
        if "incomplete" not in row["flags"]:
            row["flags"].append("incomplete")
    return row


def parse_document(pdf_path):
    """解析整份供应单, 返回结构化结果(纯数据, 可 JSON 序列化)。"""
    doc = pymupdf.open(pdf_path)
    try:
        full_text = "\n".join(p.get_text() for p in doc)
        layout_key = None
        for key, lay in LAYOUTS.items():
            if lay["title"] in full_text:
                layout_key = key
                break
        if layout_key is None:
            raise ParseError("无法识别的版式(仅支持「供应单」/「供货清单」两种样例版式)")
        layout = LAYOUTS[layout_key]
        keys = [k for k, _ in layout["columns"]]

        m = ORDER_NO_RE.search(full_text)
        order_no = m.group(1) if m else ""

        rows, orphans = [], []
        current = None
        printed_total = None
        last_bounds = None
        page_count = doc.page_count
        page_sizes = [[p.rect.width, p.rect.height] for p in doc]

        for pno, page in enumerate(doc, start=1):
            lines = _page_lines(page)
            header_idx = None
            for i, ln in enumerate(lines):
                centers = _match_header(ln, layout)
                if centers:
                    header_idx = i
                    last_bounds = (keys, _col_boundaries(centers, keys))
                    break
            if header_idx is None:
                continue  # 没有表头的页(本工具样例中不会出现)
            keys, bounds = last_bounds
            for ln in lines[header_idx + 1:]:
                if TOTAL_WORD_RE.search(ln["text"]):
                    nums = MONEY_RE.findall(ln["text"].replace(",", ""))
                    if nums:
                        printed_total = nums[-1]
                    break  # 合计行以下不再是明细
                if _match_header(ln, layout):
                    continue  # 页中重印的表头, 不计入明细
                fields = _line_fields(ln, keys, bounds)
                if not fields:
                    continue
                seg = {"page": pno, "bbox": [round(v, 1) for v in ln["bbox"]],
                       "text": ln["text"]}
                if fields.get("no") and NO_RE.match(fields["no"]):
                    if current is not None:
                        rows.append(_finalize(current))
                    current = _new_row(fields, seg)
                else:
                    if current is None:
                        orphans.append(seg)
                    else:
                        _merge(current, fields, seg, pno)
        if current is not None:
            rows.append(_finalize(current))
    finally:
        doc.close()

    for i, r in enumerate(rows):
        r["key"] = str(i)
        r["pages"] = sorted({s["page"] for s in r["segments"]})

    return {
        "layout": layout_key,
        "layout_title": layout["title"],
        "fields": keys,
        "order_no": order_no,
        "printed_total": printed_total,
        "rows": rows,
        "orphans": orphans,
        "page_count": page_count,
        "page_sizes": page_sizes,
    }


def to_decimal(s):
    try:
        return Decimal(str(s).replace(",", "").strip())
    except (InvalidOperation, AttributeError):
        return None


def verify(rows, printed_total):
    """按行金额合计与账单印出的总计核对。返回 (是否相符, 计算合计, 问题列表)。"""
    total = Decimal("0")
    problems = []
    for r in rows:
        amt = to_decimal(r.get("amount"))
        if amt is None:
            problems.append("行 %s 缺少有效金额" % (r.get("no") or r.get("key")))
            continue
        total += amt
        if not r.get("qty"):
            problems.append("行 %s 缺少数量" % (r.get("no") or r.get("key")))
    printed = to_decimal(printed_total)
    if printed is None:
        problems.append("未找到账单印出的总计")
        return False, str(total), problems
    ok = (total == printed) and not problems
    if total != printed:
        problems.append("行金额合计 %s 与账单总计 %s 不符" % (total, printed))
    return ok, str(total), problems
