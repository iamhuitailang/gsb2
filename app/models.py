"""策略包的结构与语义校验、规范化与差异计算。

校验分两层：

1. 结构层：未知字段、重复字段（解析阶段）、类型、长度、数量、枚举值。
2. 语义层：CIDR/端口合法性、规则标识冲突、同优先级条件重叠但动作矛盾、
   协议与端口不相容、包内冗余等。

只有零个 error 的策略包才会被规范化并计算摘要；warning 会随结果返回并
记入审计，不会被静默丢弃。
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import re
from dataclasses import dataclass
from typing import Any, Iterable

from .config import (
    MAX_CIDRS_PER_LIST,
    MAX_FINDINGS,
    MAX_PACKAGE_DESC_LEN,
    MAX_PACKAGE_ID_LEN,
    MAX_PACKAGE_NAME_LEN,
    MAX_PORTS_PER_RULE,
    MAX_PROTOCOLS_PER_RULE,
    MAX_RULES,
    MAX_RULE_DESC_LEN,
    MAX_RULE_ID_LEN,
    MAX_RULE_NAME_LEN,
    SCHEMA_VERSION,
    SUPPORTED_SCHEMA_VERSIONS,
)

SEVERITY_ERROR = "error"
SEVERITY_WARNING = "warning"

_TOP_KEYS = {"schema_version", "package", "default_action", "rules"}
_PACKAGE_KEYS = {"id", "name", "description", "revision"}
_RULE_REQUIRED = {
    "id",
    "name",
    "priority",
    "action",
    "direction",
    "protocols",
    "source_cidrs",
    "destination_cidrs",
    "destination_ports",
}
_RULE_OPTIONAL = {"description", "enabled"}

_ACTIONS = ("allow", "deny")
_DIRECTIONS = ("inbound", "outbound")
_PROTOCOLS = ("tcp", "udp", "icmp")
_PROTOCOL_ORDER = {name: index for index, name in enumerate(_PROTOCOLS)}

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
_PORT_ITEM_RE = re.compile(r"^([0-9]{1,5})(?:-([0-9]{1,5}))?$")

MAX_PRIORITY = 100_000
MAX_PORT = 65_535


@dataclass(frozen=True)
class Issue:
    code: str
    severity: str
    message: str
    path: str
    rule_id: str | None = None

    def as_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "code": self.code,
            "severity": self.severity,
            "message": self.message,
            "path": self.path,
        }
        if self.rule_id is not None:
            data["rule_id"] = self.rule_id
        return data


@dataclass
class RuleShape:
    """一条通过结构校验的规则，供语义分析使用。"""

    index: int
    id: str
    name: str
    enabled: bool
    priority: int
    action: str
    direction: str
    protocols: tuple[str, ...]
    source_cidrs: tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]
    destination_cidrs: tuple[
        ipaddress.IPv4Network | ipaddress.IPv6Network, ...
    ]
    destination_ports: tuple[tuple[int, int], ...]

    @property
    def path(self) -> str:
        return f"$.rules[{self.index}]"


@dataclass
class ValidationResult:
    issues: list[Issue]
    normalized: dict[str, Any] | None
    digest: str | None
    error_total: int = 0
    warning_total: int = 0
    truncated: bool = False

    @property
    def errors(self) -> list[Issue]:
        return [i for i in self.issues if i.severity == SEVERITY_ERROR]

    @property
    def warnings(self) -> list[Issue]:
        return [i for i in self.issues if i.severity == SEVERITY_WARNING]

    @property
    def ok(self) -> bool:
        return self.error_total == 0 and self.normalized is not None

    def summary(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "ok": self.ok,
            "error_count": self.error_total,
            "warning_count": self.warning_total,
            "issues_truncated": self.truncated,
        }
        if self.normalized is not None:
            rules = self.normalized["rules"]
            data["rule_count"] = len(rules)
            data["enabled_rule_count"] = sum(1 for r in rules if r["enabled"])
            data["package_id"] = self.normalized["package"]["id"]
            data["package_name"] = self.normalized["package"]["name"]
            data["schema_version"] = self.normalized["schema_version"]
        return data


class _Issues:
    def __init__(self) -> None:
        self.items: list[Issue] = []
        self.truncated = False
        self.error_total = 0
        self.warning_total = 0

    @property
    def error_count(self) -> int:
        return self.error_total

    def add(
        self,
        code: str,
        severity: str,
        message: str,
        path: str,
        rule_id: str | None = None,
    ) -> None:
        if severity == SEVERITY_ERROR:
            self.error_total += 1
        else:
            self.warning_total += 1
        if len(self.items) >= MAX_FINDINGS:
            self.truncated = True
            return
        self.items.append(Issue(code, severity, message, path, rule_id))

    def error(self, code: str, message: str, path: str, rule_id: str | None = None) -> None:
        self.add(code, SEVERITY_ERROR, message, path, rule_id)

    def warn(self, code: str, message: str, path: str, rule_id: str | None = None) -> None:
        self.add(code, SEVERITY_WARNING, message, path, rule_id)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_str(value: Any) -> bool:
    return isinstance(value, str)


def _check_unknown_keys(
    issues: _Issues, obj: dict[str, Any], allowed: set[str], path: str
) -> None:
    for key in sorted(obj):
        if key not in allowed:
            issues.error(
                "unknown_field",
                f"未知字段 {key!r}；允许的字段：{', '.join(sorted(allowed))}",
                f"{path}.{key}",
            )


def _check_string(
    issues: _Issues,
    value: Any,
    path: str,
    *,
    min_len: int,
    max_len: int,
    field: str,
    pattern: re.Pattern[str] | None = None,
) -> str | None:
    if not _is_str(value):
        issues.error("type_mismatch", f"{field} 必须是字符串", path)
        return None
    if len(value) < min_len:
        issues.error(
            "empty_value" if min_len <= 1 else "value_too_short",
            f"{field} 不能为空" if min_len <= 1 else f"{field} 至少需要 {min_len} 个字符",
            path,
        )
        return None
    if len(value) > max_len:
        issues.error(
            "value_too_long", f"{field} 长度不能超过 {max_len} 个字符", path
        )
        return None
    if pattern is not None and not pattern.match(value):
        issues.error(
            "invalid_format",
            f"{field} 格式不合法（要求：小写字母/数字开头，仅含小写字母、数字、点、下划线、短横线）",
            path,
        )
        return None
    return value


def _check_id(
    issues: _Issues, value: Any, path: str, *, max_len: int, field: str
) -> str | None:
    return _check_string(
        issues, value, path, min_len=2, max_len=max_len, field=field, pattern=_ID_RE
    )


def _check_optional_string(
    issues: _Issues, obj: dict[str, Any], key: str, path: str, max_len: int
) -> str | None:
    if key not in obj:
        return None
    value = obj[key]
    if not _is_str(value):
        issues.error("type_mismatch", f"{key} 必须是字符串", f"{path}.{key}")
        return None
    if len(value) > max_len:
        issues.error(
            "value_too_long", f"{key} 长度不能超过 {max_len} 个字符", f"{path}.{key}"
        )
        return None
    return value


def _parse_cidr(
    issues: _Issues, value: Any, path: str, seen: dict[Any, int]
) -> ipaddress.IPv4Network | ipaddress.IPv6Network | None:
    if not _is_str(value):
        issues.error("type_mismatch", "CIDR 必须是字符串", path)
        return None
    if len(value) > 64:
        issues.error("value_too_long", "CIDR 字符串过长", path)
        return None
    try:
        network = ipaddress.ip_network(value, strict=True)
    except ValueError as exc:
        hint = "（主机位必须为 0）" if "host bits" in str(exc) else ""
        issues.error("invalid_cidr", f"CIDR 不合法：{exc}{hint}", path)
        return None
    if network in seen:
        issues.error("duplicate_cidr", "同一规则中出现重复的 CIDR", path)
        return None
    for existing, _ in seen.items():
        if existing.version == network.version and existing.overlaps(network):
            issues.warn(
                "overlapping_cidr",
                f"CIDR {network} 与 {existing} 有重叠，匹配范围是并集",
                path,
            )
            break
    seen[network] = 1
    return network


def _parse_port_item(issues: _Issues, value: Any, path: str) -> tuple[int, int] | None:
    if _is_int(value):
        start = end = value
    elif _is_str(value):
        match = _PORT_ITEM_RE.match(value)
        if not match:
            issues.error(
                "invalid_port",
                "端口必须是 1-65535 的整数，或形如 \"8000-8100\" 的区间字符串",
                path,
            )
            return None
        start = int(match.group(1))
        end = int(match.group(2)) if match.group(2) is not None else start
    else:
        issues.error(
            "type_mismatch",
            "端口必须是整数或端口区间字符串",
            path,
        )
        return None
    if not (1 <= start <= MAX_PORT and 1 <= end <= MAX_PORT):
        issues.error(
            "port_out_of_range", f"端口必须位于 1-{MAX_PORT} 之间", path
        )
        return None
    if start > end:
        issues.error(
            "invalid_port_range", f"端口区间起点 {start} 大于终点 {end}", path
        )
        return None
    return start, end


def _analyze_rule_fields(
    issues: _Issues,
    obj: dict[str, Any],
    index: int,
    *,
    missing: set[str],
    valid_ids: dict[str, int],
) -> RuleShape | None:
    path = f"$.rules[{index}]"
    error_count = issues.error_count

    rule_id = None
    if "id" not in missing:
        rule_id = _check_id(
            issues,
            obj.get("id"),
            f"{path}.id",
            max_len=MAX_RULE_ID_LEN,
            field="规则 id",
        )
        if rule_id is not None:
            if rule_id in valid_ids:
                issues.error(
                    "duplicate_rule_id",
                    f"规则 id {rule_id!r} 与 $.rules[{valid_ids[rule_id]}] 冲突",
                    f"{path}.id",
                    rule_id,
                )
                rule_id = None
            else:
                valid_ids[rule_id] = index

    name = None
    if "name" not in missing:
        name = _check_string(
            issues,
            obj.get("name"),
            f"{path}.name",
            min_len=1,
            max_len=MAX_RULE_NAME_LEN,
            field="规则名称",
        )
    _check_optional_string(issues, obj, "description", path, MAX_RULE_DESC_LEN)

    enabled = obj.get("enabled", True)
    if not isinstance(enabled, bool):
        issues.error("type_mismatch", "enabled 必须是布尔值", f"{path}.enabled")
        enabled = False

    priority = 0
    if "priority" not in missing:
        priority = obj.get("priority")  # type: ignore[assignment]
        if not _is_int(priority):
            issues.error("type_mismatch", "priority 必须是整数", f"{path}.priority")
            priority = 0
        elif not 1 <= priority <= MAX_PRIORITY:
            issues.error(
                "priority_out_of_range",
                f"priority 必须位于 1-{MAX_PRIORITY} 之间",
                f"{path}.priority",
            )
            priority = 0

    action = ""
    if "action" not in missing:
        action = obj.get("action")  # type: ignore[assignment]
        if not _is_str(action) or action not in _ACTIONS:
            issues.error(
                "unsupported_action",
                f"action 必须是 {', '.join(_ACTIONS)} 之一",
                f"{path}.action",
            )
            action = ""

    direction = ""
    if "direction" not in missing:
        direction = obj.get("direction")  # type: ignore[assignment]
        if not _is_str(direction) or direction not in _DIRECTIONS:
            issues.error(
                "unsupported_direction",
                f"direction 必须是 {', '.join(_DIRECTIONS)} 之一",
                f"{path}.direction",
            )
            direction = ""

    protocols: list[str] = []
    if "protocols" not in missing:
        protocols_raw = obj.get("protocols")
        if not isinstance(protocols_raw, list):
            issues.error(
                "type_mismatch", "protocols 必须是数组", f"{path}.protocols"
            )
        else:
            if not 1 <= len(protocols_raw) <= MAX_PROTOCOLS_PER_RULE:
                issues.error(
                    "invalid_list_size",
                    f"protocols 数量必须位于 1-{MAX_PROTOCOLS_PER_RULE} 之间",
                    f"{path}.protocols",
                )
            seen_protocols: set[str] = set()
            for proto_index, proto in enumerate(protocols_raw):
                item_path = f"{path}.protocols[{proto_index}]"
                if not _is_str(proto):
                    issues.error("type_mismatch", "协议必须是字符串", item_path)
                    continue
                lowered = proto.lower()
                if lowered != proto:
                    issues.error(
                        "invalid_protocol",
                        "协议必须使用小写名称",
                        item_path,
                    )
                    continue
                if lowered not in _PROTOCOLS:
                    issues.error(
                        "unsupported_protocol",
                        f"不支持的协议 {proto!r}；支持：{', '.join(_PROTOCOLS)}",
                        item_path,
                    )
                    continue
                if lowered in seen_protocols:
                    issues.error(
                        "duplicate_protocol", f"协议 {proto!r} 重复", item_path
                    )
                    continue
                seen_protocols.add(lowered)
                protocols.append(lowered)

    source_cidrs: list[Any] = []
    if "source_cidrs" not in missing:
        source_cidrs = _analyze_cidr_list(
            issues, obj.get("source_cidrs"), f"{path}.source_cidrs"
        )
    destination_cidrs: list[Any] = []
    if "destination_cidrs" not in missing:
        destination_cidrs = _analyze_cidr_list(
            issues, obj.get("destination_cidrs"), f"{path}.destination_cidrs"
        )

    ports: list[tuple[int, int]] = []
    if "destination_ports" not in missing:
        ports_raw = obj.get("destination_ports")
        if not isinstance(ports_raw, list):
            issues.error(
                "type_mismatch",
                "destination_ports 必须是数组",
                f"{path}.destination_ports",
            )
        else:
            if len(ports_raw) > MAX_PORTS_PER_RULE:
                issues.error(
                    "invalid_list_size",
                    f"destination_ports 数量不能超过 {MAX_PORTS_PER_RULE}",
                    f"{path}.destination_ports",
                )
            seen_ports: list[tuple[int, int]] = []
            for port_index, port in enumerate(ports_raw):
                item_path = f"{path}.destination_ports[{port_index}]"
                parsed = _parse_port_item(issues, port, item_path)
                if parsed is None:
                    continue
                start, end = parsed
                conflict = next(
                    (
                        existing
                        for existing in seen_ports
                        if not (end < existing[0] or start > existing[1])
                    ),
                    None,
                )
                if conflict is not None:
                    issues.error(
                        "overlapping_port_range",
                        f"端口区间 {start}-{end} 与 {conflict[0]}-{conflict[1]} 重叠",
                        item_path,
                    )
                    continue
                seen_ports.append((start, end))
                ports.append((start, end))

        if protocols and "icmp" in protocols and ports:
            issues.error(
                "icmp_with_ports",
                "ICMP 协议不支持目标端口条件",
                f"{path}.destination_ports",
                rule_id,
            )
        elif protocols and ports and not ({"tcp", "udp"} & set(protocols)):
            issues.error(
                "ports_without_transport",
                "只有在包含 tcp 或 udp 协议时才能设置目标端口",
                f"{path}.destination_ports",
                rule_id,
            )

    if missing or issues.error_count != error_count:
        return None
    if rule_id is None or name is None or not action or not direction:
        return None
    return RuleShape(
        index=index,
        id=rule_id,
        name=name,
        enabled=enabled,
        priority=priority,
        action=action,
        direction=direction,
        protocols=tuple(protocols),
        source_cidrs=tuple(source_cidrs),
        destination_cidrs=tuple(destination_cidrs),
        destination_ports=tuple(ports),
    )


def _analyze_cidr_list(
    issues: _Issues, value: Any, path: str
) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    networks: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    if not isinstance(value, list):
        issues.error("type_mismatch", "CIDR 列表必须是数组", path)
        return networks
    if len(value) == 0:
        issues.error(
            "empty_cidr_list",
            "CIDR 列表不能为空；如表示任意地址，请显式写 0.0.0.0/0 或 ::/0",
            path,
        )
        return networks
    if len(value) > MAX_CIDRS_PER_LIST:
        issues.error(
            "invalid_list_size",
            f"CIDR 数量不能超过 {MAX_CIDRS_PER_LIST}",
            path,
        )
        return networks
    seen: dict[Any, int] = {}
    for cidr_index, item in enumerate(value):
        parsed = _parse_cidr(issues, item, f"{path}[{cidr_index}]", seen)
        if parsed is not None:
            networks.append(parsed)
    return networks


def _cidr_lists_overlap(
    left: tuple[Any, ...], right: tuple[Any, ...]
) -> bool:
    for a in left:
        for b in right:
            if a.version == b.version and a.overlaps(b):
                return True
    return False


def _ports_overlap(
    left: tuple[tuple[int, int], ...], right: tuple[tuple[int, int], ...]
) -> bool:
    # 空端口列表表示“不限端口”：与任何端口条件都重叠。
    if not left or not right:
        return True
    return any(
        not (b_end < a_start or b_start > a_end)
        for a_start, a_end in left
        for b_start, b_end in right
    )


def _conditions_overlap(a: RuleShape, b: RuleShape) -> bool:
    return (
        a.direction == b.direction
        and bool(set(a.protocols) & set(b.protocols))
        and _cidr_lists_overlap(a.source_cidrs, b.source_cidrs)
        and _cidr_lists_overlap(a.destination_cidrs, b.destination_cidrs)
        and _ports_overlap(a.destination_ports, b.destination_ports)
    )


def _conditions_identical(a: RuleShape, b: RuleShape) -> bool:
    return (
        a.direction == b.direction
        and set(a.protocols) == set(b.protocols)
        and set(a.source_cidrs) == set(b.source_cidrs)
        and set(a.destination_cidrs) == set(b.destination_cidrs)
        and set(a.destination_ports) == set(b.destination_ports)
    )


def _analyze_conflicts(issues: _Issues, rules: Iterable[RuleShape]) -> None:
    enabled = [rule for rule in rules if rule.enabled]
    # 规则数与每规则 CIDR 数都有上限，但最坏情况仍可能产生数千万次
    # CIDR 比较。这里按“比较次数”记账，超预算时停止并明确告警，避免
    # 一个体积合法的恶意策略包把校验拖死。
    budget = 400_000
    for i, left in enumerate(enabled):
        for right in enabled[i + 1 :]:
            if (
                left.direction != right.direction
                or not set(left.protocols) & set(right.protocols)
            ):
                continue
            cost = len(left.source_cidrs) * len(right.source_cidrs) + len(
                left.destination_cidrs
            ) * len(right.destination_cidrs)
            budget -= max(cost, 1)
            if budget < 0:
                issues.warn(
                    "conflict_check_truncated",
                    "规则数量与地址规模较大，冲突检查达到计算预算上限，未覆盖全部规则对",
                    "$.rules",
                )
                return
            if not _conditions_overlap(left, right):
                continue
            if left.priority == right.priority and left.action != right.action:
                issues.error(
                    "conflicting_rules",
                    (
                        f"规则 {left.id!r} 与 {right.id!r} 优先级相同（{left.priority}）、"
                        f"条件重叠但动作相反（{left.action} / {right.action}）"
                    ),
                    right.path,
                    right.id,
                )
                continue
            if _conditions_identical(left, right):
                if left.action == right.action:
                    issues.warn(
                        "redundant_rule",
                        f"规则 {right.id!r} 与 {left.id!r} 条件相同、动作相同，属于冗余",
                        right.path,
                        right.id,
                    )
                elif left.priority != right.priority:
                    # 条件完全相同、动作相反：优先级数值更小（更优先）的规则先命中，
                    # 另一条永远不会生效。
                    shadowed, winner = (
                        (right, left) if left.priority < right.priority else (left, right)
                    )
                    issues.warn(
                        "shadowed_rule",
                        (
                            f"规则 {shadowed.id!r} 与 {winner.id!r} 条件完全相同但动作相反，"
                            f"由于 {winner.id!r} 优先级更高（{winner.priority} < "
                            f"{shadowed.priority}），前者永远不会命中"
                        ),
                        shadowed.path,
                        shadowed.id,
                    )


def _normalize_cidr(network: Any) -> str:
    return str(network)


def _normalize_port(start: int, end: int) -> str:
    return str(start) if start == end else f"{start}-{end}"


def _build_normalized(
    document: dict[str, Any], rules: list[RuleShape], package: dict[str, Any]
) -> dict[str, Any]:
    normalized_rules: list[dict[str, Any]] = []
    for rule in sorted(rules, key=lambda item: (item.priority, item.id)):
        raw = document["rules"][rule.index]
        entry: dict[str, Any] = {
            "id": rule.id,
            "name": rule.name,
            "enabled": rule.enabled,
            "priority": rule.priority,
            "action": rule.action,
            "direction": rule.direction,
            "protocols": sorted(
                rule.protocols, key=lambda proto: _PROTOCOL_ORDER[proto]
            ),
            "source_cidrs": sorted(
                (_normalize_cidr(n) for n in rule.source_cidrs),
                key=_cidr_sort_key,
            ),
            "destination_cidrs": sorted(
                (_normalize_cidr(n) for n in rule.destination_cidrs),
                key=_cidr_sort_key,
            ),
            "destination_ports": [
                _normalize_port(start, end)
                for start, end in sorted(rule.destination_ports)
            ],
        }
        if "description" in raw:
            entry["description"] = raw["description"]
        normalized_rules.append(entry)

    normalized_package: dict[str, Any] = {
        "id": package["id"],
        "name": package["name"],
    }
    if "description" in package:
        normalized_package["description"] = package["description"]
    if "revision" in package:
        normalized_package["revision"] = package["revision"]

    return {
        "schema_version": document["schema_version"],
        "package": normalized_package,
        "default_action": document["default_action"],
        "rules": normalized_rules,
    }


def _cidr_sort_key(value: str) -> tuple[int, int, int]:
    network = ipaddress.ip_network(value)
    return (network.version, int(network.network_address), network.prefixlen)


def canonical_dumps(document: dict[str, Any]) -> str:
    return json.dumps(
        document, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )


def digest_of(document: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_dumps(document).encode("utf-8")).hexdigest()


def pretty_dumps(document: dict[str, Any]) -> str:
    return json.dumps(document, ensure_ascii=False, indent=2) + "\n"


def _missing_keys(
    issues: _Issues, obj: dict[str, Any], required: Iterable[str], path: str
) -> set[str]:
    missing = set(required) - obj.keys()
    for key in sorted(missing):
        issues.error("missing_field", f"缺少必填字段 {key!r}", f"{path}.{key}")
    return missing


def _validate_package(
    issues: _Issues, obj: Any, path: str, *, present: bool = True
) -> dict[str, Any] | None:
    if not present:
        # 缺失已由顶层 _missing_keys 报出，这里不重复报错。
        return None
    if not isinstance(obj, dict):
        issues.error("type_mismatch", "package 必须是对象", path)
        return None
    _check_unknown_keys(issues, obj, _PACKAGE_KEYS, path)
    error_count = issues.error_count
    missing = _missing_keys(issues, obj, ("id", "name"), path)
    package_id = None
    if "id" not in missing:
        package_id = _check_id(
            issues,
            obj.get("id"),
            f"{path}.id",
            max_len=MAX_PACKAGE_ID_LEN,
            field="策略包 id",
        )
    name = None
    if "name" not in missing:
        name = _check_string(
            issues,
            obj.get("name"),
            f"{path}.name",
            min_len=1,
            max_len=MAX_PACKAGE_NAME_LEN,
            field="策略包名称",
        )
    _check_optional_string(issues, obj, "description", path, MAX_PACKAGE_DESC_LEN)
    if "revision" in obj:
        revision = obj["revision"]
        if not _is_int(revision):
            issues.error(
                "type_mismatch", "revision 必须是整数", f"{path}.revision"
            )
        elif not 1 <= revision <= 1_000_000:
            issues.error(
                "value_out_of_range",
                "revision 必须位于 1-1000000 之间",
                f"{path}.revision",
            )
    if issues.error_count != error_count:
        return None
    if package_id is None or name is None:
        return None
    result: dict[str, Any] = {"id": package_id, "name": name}
    if "description" in obj:
        result["description"] = obj["description"]
    if "revision" in obj:
        result["revision"] = obj["revision"]
    return result


def validate_document(document: Any) -> ValidationResult:
    """校验任意已解析的 JSON 值，返回问题列表与规范化结果。"""

    issues = _Issues()
    if not isinstance(document, dict):
        issues.error("type_mismatch", "策略包根节点必须是对象", "$")
        return ValidationResult(
            list(issues.items),
            None,
            None,
            issues.error_total,
            issues.warning_total,
            issues.truncated,
        )

    _check_unknown_keys(issues, document, _TOP_KEYS, "$")
    top_missing = _missing_keys(
        issues,
        document,
        ("schema_version", "package", "default_action", "rules"),
        "$",
    )

    schema_version = document.get("schema_version")
    if "schema_version" in top_missing:
        pass
    elif not _is_str(schema_version):
        issues.error(
            "type_mismatch", "schema_version 必须是字符串", "$.schema_version"
        )
    elif schema_version not in SUPPORTED_SCHEMA_VERSIONS:
        issues.error(
            "unsupported_schema_version",
            (
                f"不支持的策略版本 {schema_version!r}；"
                f"当前仅支持 {', '.join(SUPPORTED_SCHEMA_VERSIONS)}"
            ),
            "$.schema_version",
        )

    package = _validate_package(
        issues,
        document.get("package"),
        "$.package",
        present="package" not in top_missing,
    )

    default_action = document.get("default_action")
    if "default_action" in top_missing:
        # 缺失会阻止规范化，这里仅跳过语义检查。
        pass
    elif not _is_str(default_action) or default_action not in _ACTIONS:
        issues.error(
            "unsupported_default_action",
            f"default_action 必须是 {', '.join(_ACTIONS)} 之一",
            "$.default_action",
        )

    rules_raw = document.get("rules")
    rule_shapes: list[RuleShape] = []
    if "rules" not in top_missing:
        if not isinstance(rules_raw, list):
            issues.error("type_mismatch", "rules 必须是数组", "$.rules")
        elif len(rules_raw) == 0:
            issues.error(
                "empty_rules",
                "策略包至少需要一条规则；如需拒绝全部流量请显式添加兜底规则",
                "$.rules",
            )
        elif len(rules_raw) > MAX_RULES:
            issues.error(
                "too_many_rules",
                f"规则数量 {len(rules_raw)} 超过上限 {MAX_RULES}",
                "$.rules",
            )
        else:
            valid_ids: dict[str, int] = {}
            for index, raw_rule in enumerate(rules_raw):
                rule_path = f"$.rules[{index}]"
                if not isinstance(raw_rule, dict):
                    issues.error("type_mismatch", "规则必须是对象", rule_path)
                    continue
                _check_unknown_keys(
                    issues, raw_rule, _RULE_REQUIRED | _RULE_OPTIONAL, rule_path
                )
                missing = _missing_keys(issues, raw_rule, _RULE_REQUIRED, rule_path)
                shape = _analyze_rule_fields(
                    issues,
                    raw_rule,
                    index,
                    missing=missing,
                    valid_ids=valid_ids,
                )
                if shape is not None:
                    rule_shapes.append(shape)
            _analyze_conflicts(issues, rule_shapes)

    error_total = issues.error_total
    if error_total or package is None:
        return ValidationResult(
            list(issues.items),
            None,
            None,
            error_total,
            issues.warning_total,
            issues.truncated,
        )

    normalized = _build_normalized(document, rule_shapes, package)
    return ValidationResult(
        list(issues.items),
        normalized,
        digest_of(normalized),
        error_total,
        issues.warning_total,
        issues.truncated,
    )


# ---------------------------------------------------------------- diff


def diff_documents(
    before: dict[str, Any] | None, after: dict[str, Any]
) -> dict[str, Any]:
    """计算两个规范化策略包之间的结构差异。"""

    before = before or {"rules": [], "package": {}, "default_action": None}
    before_rules = {rule["id"]: rule for rule in before.get("rules", [])}
    after_rules = {rule["id"]: rule for rule in after.get("rules", [])}

    added = [
        {"id": rule_id, "rule": after_rules[rule_id]}
        for rule_id in sorted(after_rules)
        if rule_id not in before_rules
    ]
    removed = [
        {"id": rule_id, "rule": before_rules[rule_id]}
        for rule_id in sorted(before_rules)
        if rule_id not in after_rules
    ]
    modified: list[dict[str, Any]] = []
    for rule_id in sorted(set(before_rules) & set(after_rules)):
        old_rule = before_rules[rule_id]
        new_rule = after_rules[rule_id]
        changes: dict[str, Any] = {}
        for field in sorted(set(old_rule) | set(new_rule)):
            old_value = old_rule.get(field)
            new_value = new_rule.get(field)
            if old_value != new_value:
                changes[field] = {"before": old_value, "after": new_value}
        if changes:
            modified.append(
                {"id": rule_id, "changes": changes, "rule": new_rule}
            )

    package_changes: dict[str, Any] = {}
    for field in sorted(
        set(before.get("package", {})) | set(after.get("package", {}))
    ):
        old_value = before.get("package", {}).get(field)
        new_value = after.get("package", {}).get(field)
        if old_value != new_value:
            package_changes[field] = {"before": old_value, "after": new_value}
    if before.get("default_action") != after.get("default_action"):
        package_changes["default_action"] = {
            "before": before.get("default_action"),
            "after": after.get("default_action"),
        }
    if before.get("schema_version") != after.get("schema_version"):
        package_changes["schema_version"] = {
            "before": before.get("schema_version"),
            "after": after.get("schema_version"),
        }

    return {
        "package": package_changes,
        "added": added,
        "removed": removed,
        "modified": modified,
        "summary": {
            "added": len(added),
            "removed": len(removed),
            "modified": len(modified),
            "unchanged": len(set(before_rules) & set(after_rules)) - len(modified),
            "has_changes": bool(
                added or removed or modified or package_changes
            ),
        },
    }


def empty_document() -> dict[str, Any]:
    """编辑器初始空模板。"""

    return {
        "schema_version": SCHEMA_VERSION,
        "package": {
            "id": "local-policy",
            "name": "本地策略包",
            "revision": 1,
        },
        "default_action": "deny",
        "rules": [],
    }
