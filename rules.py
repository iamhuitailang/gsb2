"""规则引擎：按规则配置校验单条包裹记录，返回 (结果, 原因列表)。

规则配置结构：
{
  "weight": {"min": 0, "max": 20},          # 重量区间（公斤，含边界）
  "service_types": ["标准", "特快"],          # 服务类型允许值
  "cold_chain_requires_temp_zone": true      # 冷链包裹必须填写温区
}
"""

DEFAULT_CONFIG = {
    "weight": {"min": 0, "max": 20},
    "service_types": ["标准", "特快", "经济"],
    "cold_chain_requires_temp_zone": False,
}


def validate_row(config, row):
    """row 字段：weight(float|None), service_type(str), is_cold_chain(bool), temp_zone(str)"""
    reasons = []

    weight = row.get("weight")
    wmin = config["weight"]["min"]
    wmax = config["weight"]["max"]
    if weight is None:
        reasons.append("重量缺失或格式不正确")
    elif weight < wmin or weight > wmax:
        reasons.append(f"重量 {weight:g}kg 超出允许区间 [{wmin:g}, {wmax:g}] kg")

    service_type = (row.get("service_type") or "").strip()
    allowed = config.get("service_types") or []
    if service_type not in allowed:
        reasons.append(f"服务类型「{service_type or '空'}」不在允许列表 {allowed}")

    if config.get("cold_chain_requires_temp_zone") and row.get("is_cold_chain"):
        if not (row.get("temp_zone") or "").strip():
            reasons.append("冷链包裹必须填写温区")

    return ("reject" if reasons else "pass"), reasons


def compare_results(base_outcome, base_reasons, draft_outcome, draft_reasons):
    """比较同一记录在两套规则下的结果，返回变化类型。"""
    if base_outcome == "pass" and draft_outcome == "reject":
        return "pass_to_reject"
    if base_outcome == "reject" and draft_outcome == "pass":
        return "reject_to_pass"
    if base_reasons != draft_reasons:
        return "reason_changed"
    return "unchanged"


CHANGE_TYPE_LABELS = {
    "pass_to_reject": "通过 → 拒绝",
    "reject_to_pass": "拒绝 → 通过",
    "reason_changed": "原因变化",
    "unchanged": "无变化",
}
