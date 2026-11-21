"""Trust configuration validation and normalisation.

Validation is intentionally explicit: invalid or contradictory values are
returned as structured errors instead of being replaced by defaults.
"""

from __future__ import annotations

import ipaddress
from typing import Any

from pydantic import BaseModel, ConfigDict, ValidationError

FIELD_ORDER = ("x_forwarded_for", "forwarded", "x_real_ip", "cf_connecting_ip")

FIELD_META: dict[str, dict[str, str]] = {
    "x_forwarded_for": {
        "label": "X-Forwarded-For",
        "kind": "list",
        "note": "逗号分隔，通常最左侧为原始客户端，由代理逐跳追加",
    },
    "forwarded": {
        "label": "Forwarded (RFC 7239)",
        "kind": "list",
        "note": "逐个元素取 for= 参数，通常最左侧为原始客户端",
    },
    "x_real_ip": {
        "label": "X-Real-IP",
        "kind": "single",
        "note": "单值字段，只能承载一跳地址",
    },
    "cf_connecting_ip": {
        "label": "CF-Connecting-IP",
        "kind": "single",
        "note": "单值字段，只能承载一跳地址",
    },
}

MAX_HOPS = 10


class TrustEntryIn(BaseModel):
    # ``kind``/``version``/``note`` are derived by normalisation and are
    # accepted back unchanged so a saved config can be re-submitted as-is.
    model_config = ConfigDict(extra="ignore")
    value: str
    label: str | None = None


class FieldPolicyIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    enabled: bool
    max_hops: int


class FieldsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    x_forwarded_for: FieldPolicyIn
    forwarded: FieldPolicyIn
    x_real_ip: FieldPolicyIn
    cf_connecting_ip: FieldPolicyIn


class TrustConfigIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = ""
    entries: list[TrustEntryIn]
    fields: FieldsIn


def _issue(field: str, message: str, code: str = "invalid") -> dict[str, str]:
    return {"field": field, "message": message, "code": code}


def parse_trust_entry(raw: str) -> tuple[dict[str, Any] | None, dict[str, str] | None]:
    """Parse one trusted proxy entry.  Returns (entry, error)."""
    value = "" if raw is None else str(raw).strip()
    if value == "":
        return None, _issue("value", "可信代理地址不能为空")
    if any(char.isspace() for char in value):
        return None, _issue("value", "地址段内部不能包含空格或制表符")
    if "%" in value:
        return None, _issue("value", "不接受带区域标识（%zone）的 IPv6 地址")
    if value.startswith("[") or value.endswith("]") or '"' in value or "'" in value:
        return None, _issue(
            "value", "可信配置只接受裸 IP 或 CIDR，不要带方括号、引号或端口"
        )

    note = None
    try:
        if "/" in value:
            if value.count("/") != 1:
                raise ValueError("CIDR 只能包含一个斜杠")
            network = ipaddress.ip_network(value, strict=True)
            entry_kind = "network"
            address_value = str(network)
            version = network.version
        else:
            ip = ipaddress.ip_address(value)
            if ip.version == 6 and ip.ipv4_mapped is not None:
                ip = ip.ipv4_mapped
                note = "IPv4 映射的 IPv6 地址已规范化为 IPv4"
            entry_kind = "address"
            address_value = str(ip)
            version = ip.version
        network = ipaddress.ip_network(address_value)
    except ValueError as exc:
        if "/" in value:
            # Point at the actual problem rather than rewriting the config.
            try:
                loose = ipaddress.ip_network(value, strict=False)
            except ValueError:
                return None, _issue("value", f"{value!r} 不是合法的 CIDR 地址段：{exc}")
            return (
                None,
                _issue(
                    "value",
                    f"{value!r} 的主机位不为零；如确实要表示整个网段，请写成 "
                    f"{loose}（系统不会悄悄改写你的配置）",
                ),
            )
        return None, _issue(
            "value", f"{value!r} 不是合法的 IPv4 或 IPv6 地址：{exc}"
        )

    if entry_kind == "network" and network.prefixlen == 0:
        return None, _issue(
            "value",
            f"{address_value} 会信任所有来源，等同于放弃校验，请显式收窄网段",
        )

    if network.is_multicast:
        return None, _issue("value", f"{address_value} 属于组播地址，不能作为代理来源")
    if network.is_unspecified:
        return None, _issue("value", f"{address_value} 是未指定地址，不能作为代理来源")

    return (
        {
            "value": address_value,
            "label": None,
            "kind": entry_kind,
            "version": version,
            "note": note,
            "_network": network,
        },
        None,
    )


def normalize_trust_config(
    config: TrustConfigIn | dict[str, Any],
) -> tuple[dict[str, Any] | None, list[dict[str, str]], list[dict[str, str]]]:
    """Validate and normalise a trust config.

    Returns ``(normalised_config, errors, warnings)``.  When errors is not
    empty the config must not be used.
    """
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []

    if isinstance(config, dict):
        try:
            model = TrustConfigIn.model_validate(config)
        except ValidationError as exc:
            for item in exc.errors():
                location = ".".join(str(part) for part in item["loc"])
                errors.append(
                    _issue(location or "config", item["msg"], code="schema")
                )
            return None, errors, warnings
    else:
        model = config

    name = (model.name or "").strip()
    if len(name) > 80:
        errors.append(_issue("name", "配置名称不能超过 80 个字符"))
    if not name:
        name = "未命名配置"
        warnings.append(_issue("name", "配置名称为空，已标记为「未命名配置」", "note"))

    if not model.entries:
        errors.append(_issue("entries", "至少需要一个可信代理地址或地址段"))
    if len(model.entries) > 50:
        errors.append(_issue("entries", "可信条目不能超过 50 个"))

    parsed_entries: list[dict[str, Any]] = []
    seen: dict[str, int] = {}
    for index, entry in enumerate(model.entries):
        parsed, error = parse_trust_entry(entry.value)
        if error:
            errors.append(_issue(f"entries[{index}].value", error["message"], error["code"]))
            continue
        assert parsed is not None
        label = (entry.label or "").strip()
        if len(label) > 60:
            errors.append(_issue(f"entries[{index}].label", "标签不能超过 60 个字符"))
            continue
        parsed["label"] = label or None
        key = parsed["value"]
        if key in seen:
            other = seen[key]
            errors.append(
                _issue(
                    f"entries[{index}].value",
                    f"与 entries[{other}] 重复声明了同一地址段 {key}；"
                    "请合并为一条，或确认是否本意要配置两个不同网段",
                    "conflict",
                )
            )
            continue
        seen[key] = index
        parsed_entries.append(parsed)

    # Redundancy / overlap is not fatal but must be surfaced.
    for i, left in enumerate(parsed_entries):
        for j, right in enumerate(parsed_entries):
            if i >= j:
                continue
            a, b = left["_network"], right["_network"]
            if a.version != b.version:
                continue
            if a == b:
                continue
            if a.subnet_of(b):
                warnings.append(
                    _issue(
                        f"entries[{j}]",
                        f"{right['value']} 已包含 {left['value']}，后者是冗余条目；"
                        "匹配结果不受影响，但配置意图不清晰",
                        "overlap",
                    )
                )
            elif b.subnet_of(a):
                warnings.append(
                    _issue(
                        f"entries[{i}]",
                        f"{left['value']} 已包含 {right['value']}，后者是冗余条目；"
                        "匹配结果不受影响，但配置意图不清晰",
                        "overlap",
                    )
                )

    fields: dict[str, dict[str, Any]] = {}
    any_enabled = False
    for key in FIELD_ORDER:
        policy = getattr(model.fields, key)
        meta = FIELD_META[key]
        max_hops = policy.max_hops
        if policy.enabled:
            any_enabled = True
        if not isinstance(max_hops, int) or isinstance(max_hops, bool):
            errors.append(_issue(f"fields.{key}.max_hops", "链路长度上限必须是整数"))
            continue
        if not 1 <= max_hops <= MAX_HOPS:
            errors.append(
                _issue(
                    f"fields.{key}.max_hops",
                    f"链路长度上限必须介于 1 和 {MAX_HOPS} 之间，当前为 {max_hops}",
                )
            )
            continue
        if meta["kind"] == "single" and max_hops != 1:
            errors.append(
                _issue(
                    f"fields.{key}.max_hops",
                    f"{meta['label']} 是单值字段，最多只能表示一跳，"
                    f"链路长度上限必须为 1，当前为 {max_hops}",
                    "conflict",
                )
            )
            continue
        fields[key] = {
            "enabled": bool(policy.enabled),
            "max_hops": max_hops,
            "label": meta["label"],
            "kind": meta["kind"],
            "note": meta["note"],
        }

    if not any_enabled:
        errors.append(
            _issue(
                "fields",
                "至少需要启用一个允许参考的转发字段，否则请求中的转发信息全部被忽略",
                "conflict",
            )
        )

    if errors:
        return None, errors, warnings

    normalized_entries = []
    for entry in parsed_entries:
        normalized_entries.append(
            {
                "value": entry["value"],
                "label": entry["label"],
                "kind": entry["kind"],
                "version": entry["version"],
                "note": entry["note"],
            }
        )

    normalized = {
        "name": name,
        "entries": normalized_entries,
        "fields": fields,
    }
    return normalized, errors, warnings


def config_fingerprint(config: dict[str, Any]) -> str:
    """Stable, path-free textual fingerprint shown with an analysis."""
    parts = [config.get("name", "")]
    parts.extend(sorted(entry["value"] for entry in config.get("entries", [])))
    for key in FIELD_ORDER:
        policy = config.get("fields", {}).get(key, {})
        parts.append(
            f"{key}:{'on' if policy.get('enabled') else 'off'}:{policy.get('max_hops')}"
        )
    return " | ".join(parts)
