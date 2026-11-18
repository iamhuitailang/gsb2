"""发现项状态模型：多次核查之间的新增/仍存在/已变化/已消失判定。"""

from __future__ import annotations

STATUS_NEW = "new"
STATUS_PRESENT = "present"
STATUS_CHANGED = "changed"
STATUS_DISAPPEARED = "disappeared"

ALL_STATUSES = (STATUS_NEW, STATUS_PRESENT, STATUS_CHANGED, STATUS_DISAPPEARED)

STATUS_LABELS = {
    STATUS_NEW: "新增",
    STATUS_PRESENT: "仍存在",
    STATUS_CHANGED: "发生变化",
    STATUS_DISAPPEARED: "已消失",
}


def diff_findings(current: list[dict], previous: list[dict] | None) -> list[dict]:
    """给当前发现项附加状态，并为已消失的旧发现生成消失项。

    身份完全由 finding id 决定（规则+相对路径+维度），因此路径或规则不再
    对应时，旧条目只会标记为消失，绝不会被套用到别的发现上。
    """
    if not previous:
        for item in current:
            item["status"] = STATUS_NEW
        return current

    prev_by_id = {item["id"]: item for item in previous}
    result: list[dict] = []

    for item in current:
        old = prev_by_id.get(item["id"])
        if old is None:
            item["status"] = STATUS_NEW
        elif old.get("change_fingerprint") != item["change_fingerprint"]:
            item["status"] = STATUS_CHANGED
        else:
            item["status"] = STATUS_PRESENT
        result.append(item)

    current_ids = {item["id"] for item in current}
    for old in previous:
        if old["id"] not in current_ids:
            ghost = dict(old)
            ghost["status"] = STATUS_DISAPPEARED
            result.append(ghost)

    return result
