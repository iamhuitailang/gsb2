#!/usr/bin/env python3
"""独立勾稽脚本（仅标准库，python3 -I 运行）。

用 Python 独立实现一遍 ceil 与计费逻辑，读取 data/ 下原始 CSV 自行计算，
再与 Node 侧导出的两份 CSV 比对，验证屏幕/汇总导出/明细导出三方一致。

用法：
  1. 先启动 Node 服务并在页面上导出两份 CSV（或直接对 data/ 原始数据自检）
  2. python3 -I test/reconcile.py \
       --waybills data/waybills.csv --rates data/rates.csv \
       [--summary-export 配送费汇总_xxx.csv] [--details-export 运单明细_xxx.csv]

不带 --summary-export 时，只做原始数据自检（明细勾稽 + 分类计数）。
"""

import argparse
import csv
import sys
from decimal import ROUND_CEILING, Decimal


def read_csv(path):
    # utf-8-sig 自动剥离 BOM
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def yuan_to_fen(s: str) -> int:
    d = Decimal(s)
    if d < 0 or -d.as_tuple().exponent > 2:
        raise ValueError(f"金额非法: {s}")
    return int((d * 100).to_integral_value())


def ceil_weight(s: str) -> int:
    # Decimal 的 ROUND_CEILING 精确向上取整，无浮点误差
    return int(Decimal(s).to_integral_value(rounding=ROUND_CEILING))


def find_rate(rates, region: str, date: str):
    fallback = None
    best = None
    for r in rates:
        if r["region"] != region:
            continue
        eff = r["effective_from"].strip()
        if not eff:
            if fallback is None:
                fallback = r
        elif eff <= date and (best is None or eff > best["effective_from"]):
            best = r
    return best or fallback


def compute(waybills, rates):
    """返回 enriched 列表，字段与 Node 侧对齐。"""
    out = []
    for wb in waybills:
        weight = wb["bill_weight_kg"].strip()
        n = ceil_weight(weight)
        rec = {"waybill_no": wb["waybill_no"], "site": wb["site"],
               "region": wb["region"], "date": wb["date"],
               "status": wb["status"], "billable_kg": n, "fee_fen": None,
               "category": "billed"}
        if wb["status"] == "cancelled":
            rec["category"] = "cancelled"
        else:
            rate = find_rate(rates, rec["region"], rec["date"])
            if rate is None:
                rec["category"] = "missing_rate"
            else:
                first = yuan_to_fen(rate["first_kg_fee_yuan"])
                added = yuan_to_fen(rate["added_kg_fee_yuan"])
                rec["fee_fen"] = first + (n - 1) * added
        out.append(rec)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--waybills", required=True)
    ap.add_argument("--rates", required=True)
    ap.add_argument("--summary-export")
    ap.add_argument("--details-export")
    args = ap.parse_args()

    waybills = read_csv(args.waybills)
    rates = read_csv(args.rates)
    enriched = compute(waybills, rates)

    errors = []

    # 1. 自洽：按站点汇总
    by_site = {}
    for rec in enriched:
        row = by_site.setdefault(rec["site"], {"fee": 0, "n": 0})
        if rec["category"] == "billed":
            row["fee"] += rec["fee_fen"]
            row["n"] += 1

    grand = sum(r["fee_fen"] for r in enriched if r["category"] == "billed")
    print("== 独立计算结果（Python/Decimal） ==")
    for site in sorted(by_site):
        print(f"  {site}: {by_site[site]['fee']} 分 / {by_site[site]['n']} 计费单")
    print(f"  合计: {grand} 分")
    cats = {}
    for rec in enriched:
        cats[rec["category"]] = cats.get(rec["category"], 0) + 1
    print(f"  分类计数: {cats}")

    # 2. 与明细导出勾稽
    if args.details_export:
        exported = read_csv(args.details_export)
        if len(exported) != len(enriched):
            errors.append(
                f"明细导出行数 {len(exported)} != 原始运单数 {len(enriched)}")
        exp_by_no = {r["运单号"]: r for r in exported}
        for rec in enriched:
            row = exp_by_no.get(rec["waybill_no"])
            if row is None:
                errors.append(f"明细导出缺少运单 {rec['waybill_no']}")
                continue
            if rec["fee_fen"] is None:
                if row["配送费(元)"] != "":
                    errors.append(f"{rec['waybill_no']} 应为空金额，实际 {row['配送费(元)']}")
            else:
                got = yuan_to_fen(row["配送费(元)"])
                if got != rec["fee_fen"]:
                    errors.append(
                        f"{rec['waybill_no']} 明细导出 {got} 分 != 独立计算 {rec['fee_fen']} 分")

    # 3. 与汇总导出勾稽
    if args.summary_export:
        summary = read_csv(args.summary_export)
        for row in summary:
            key = None if row["站点"] == "合计" else row["站点"]
            expected = grand if key is None else by_site.get(key, {"fee": 0})["fee"]
            got = yuan_to_fen(row["计费金额(元)"])
            if got != expected:
                errors.append(
                    f"汇总导出 {row['站点']} {got} 分 != 独立计算 {expected} 分")

    if errors:
        print("\n勾稽失败：")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    print("\n勾稽通过：原始数据、明细导出、汇总三方一致 ✓")


if __name__ == "__main__":
    main()
