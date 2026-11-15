"""演示数据：旧规则 v1（最大 20kg）+ 4 条样例批次 + 新规则草稿 v2（最大 15kg，冷链必填温区）。

样例批次 4 条记录在旧规则下全部通过；用 v2 预跑时应有 2 条由通过变拒绝：
- PKG001 18kg 普通包裹 → 超出新重量上限
- PKG002 冷链未填温区 → 新规则要求冷链必填温区
"""
import json

import db as dbmod
from rules import validate_row

OLD_RULE = {
    "weight": {"min": 0, "max": 20},
    "service_types": ["标准", "特快", "经济"],
    "cold_chain_requires_temp_zone": False,
}

NEW_RULE = {
    "weight": {"min": 0, "max": 15},
    "service_types": ["标准", "特快", "经济"],
    "cold_chain_requires_temp_zone": True,
}

SAMPLE_ROWS = [
    # 包裹号, 重量kg, 服务类型, 是否冷链, 温区
    ("PKG001", 18.0, "标准", 0, ""),        # 18kg 普通包裹：旧规则通过，新规则超重拒绝
    ("PKG002", 12.0, "特快", 1, ""),        # 冷链未填温区：旧规则通过，新规则拒绝
    ("PKG003", 10.0, "标准", 0, ""),        # 两套规则都通过
    ("PKG004", 8.0, "特快", 1, "2-8°C"),    # 两套规则都通过
]


def load_demo_data(conn):
    """幂等：已有版本数据时直接返回。"""
    if conn.execute("SELECT COUNT(*) AS c FROM rule_versions").fetchone()["c"] > 0:
        return False

    v1 = dbmod.create_version(conn, json.dumps(OLD_RULE, ensure_ascii=False),
                              note="初始规则：重量上限 20kg", status="published")
    conn.execute("UPDATE rule_versions SET published_at = ? WHERE id = ?", (dbmod.now(), v1))
    conn.execute(
        "INSERT INTO publish_events (version_id, action, operator, created_at) VALUES (?,?,?,?)",
        (v1, "publish", "系统初始化", dbmod.now()),
    )

    cur = conn.execute(
        "INSERT INTO batches (name, status, rule_version_id, created_at) VALUES (?,?,?,?)",
        ("示例批次 BATCH-20261101", "completed", v1, dbmod.now()),
    )
    batch_id = cur.lastrowid
    pass_count = 0
    for i, (parcel_no, weight, service_type, cold, temp_zone) in enumerate(SAMPLE_ROWS, start=1):
        raw = f"{parcel_no},{weight:g},{service_type},{'是' if cold else '否'},{temp_zone}"
        cur = conn.execute(
            "INSERT INTO batch_rows (batch_id, row_no, raw_line, parcel_no, weight,"
            " service_type, is_cold_chain, temp_zone) VALUES (?,?,?,?,?,?,?,?)",
            (batch_id, i, raw, parcel_no, weight, service_type, cold, temp_zone),
        )
        outcome, reasons = validate_row(OLD_RULE, {
            "weight": weight, "service_type": service_type,
            "is_cold_chain": bool(cold), "temp_zone": temp_zone,
        })
        conn.execute(
            "INSERT INTO validation_results (batch_row_id, rule_version_id, outcome, reasons_json)"
            " VALUES (?,?,?,?)",
            (cur.lastrowid, v1, outcome, json.dumps(reasons, ensure_ascii=False)),
        )
        if outcome == "pass":
            pass_count += 1
    conn.execute(
        "UPDATE batches SET total_rows = ?, pass_count = ?, reject_count = ? WHERE id = ?",
        (len(SAMPLE_ROWS), pass_count, len(SAMPLE_ROWS) - pass_count, batch_id),
    )

    dbmod.create_version(conn, json.dumps(NEW_RULE, ensure_ascii=False),
                         note="重量上限降至 15kg；冷链包裹必须填写温区")
    return True


if __name__ == "__main__":
    import os
    db_path = os.environ.get("WORKBENCH_DB",
                             os.path.join(os.path.dirname(__file__), "workbench.db"))
    conn = dbmod.init_db(db_path)
    created = load_demo_data(conn)
    conn.commit()
    print("演示数据已写入" if created else "已有数据，跳过")
