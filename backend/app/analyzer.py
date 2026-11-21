"""Pure trust-chain evaluation for forwarded client addresses.

The evaluator never performs network I/O and never resolves host names.
Trust is derived exclusively from the supplied configuration: an address is
trusted only when it is explicitly covered by a configured CIDR or single
address.  Private or loopback-looking addresses get no implicit trust.
"""

from __future__ import annotations

import ipaddress
from collections import Counter
from typing import Any

from .addressing import parse_address, parse_forwarded, parse_forwarded_list
from .config import FIELD_ORDER

OUTCOME_LABELS = {
    "trusted_chain": "可信代理链还原成功",
    "untrusted_peer": "对端不可信，转发信息被忽略",
    "direct_peer": "无可用的转发字段，采用连接对端",
    "forwarding_disabled": "转发字段均未启用，采用连接对端",
    "peer_invalid": "连接对端地址无法解析",
    "malformed_hop": "转发链中存在无法解析的地址",
    "duplicate_field": "同一转发字段重复出现",
    "duplicate_hop": "转发链中存在重复地址",
    "hop_limit_exceeded": "转发链长度超出配置上限",
    "chain_incomplete": "链路未闭合，缺少原始客户端",
    "field_conflict": "两种转发字段无法对应",
    "order_conflict": "两种转发字段顺序冲突",
    "single_conflict": "单值字段与链路结果不一致",
    "no_field_usable": "没有可用于判定的转发字段",
}

RISK_BY_OUTCOME = {
    "trusted_chain": ("low", "低"),
    "untrusted_peer": ("high", "高"),
    "direct_peer": ("info", "提示"),
    "forwarding_disabled": ("info", "提示"),
    "peer_invalid": ("unknown", "待核实"),
    "malformed_hop": ("unknown", "待核实"),
    "duplicate_field": ("unknown", "待核实"),
    "duplicate_hop": ("unknown", "待核实"),
    "hop_limit_exceeded": ("unknown", "待核实"),
    "chain_incomplete": ("unknown", "待核实"),
    "field_conflict": ("unknown", "待核实"),
    "order_conflict": ("unknown", "待核实"),
    "single_conflict": ("unknown", "待核实"),
    "no_field_usable": ("unknown", "待核实"),
}

STATUS_LABELS = {"determined": "已判定", "undetermined": "无法判定"}

ASSUMPTIONS = [
    "只有连接对端自身命中可信代理配置时，才会读取转发字段；"
    "请求头中出现的内网、回环或保留地址不会因此自动获得信任。",
    "转发地址按「自右向左」回溯：最右侧是离服务器最近的一跳，"
    "遇到第一个不在可信配置中的地址即视为客户端。",
    "所有输入均为页面提交的样例数据；服务端不解析域名，也不向任何外部地址发起请求。",
]


def _issue(code: str, message: str, severity: str = "warn") -> dict[str, str]:
    return {"code": code, "message": message, "severity": severity}


def _step(title: str, detail: str, level: str = "info") -> dict[str, str]:
    return {"title": title, "detail": detail, "level": level}


def _networks(config: dict[str, Any]) -> list[dict[str, Any]]:
    """Trusted networks with their display metadata.

    A single-address entry is stored as a /32 or /128, so the configured
    value and label must travel with the network; otherwise labels would be
    lost for single proxies.
    """
    networks: list[dict[str, Any]] = []
    for entry in config.get("entries", []):
        try:
            network = ipaddress.ip_network(entry["value"])
        except (KeyError, ValueError):
            continue
        networks.append(
            {
                "network": network,
                "value": entry.get("value"),
                "label": entry.get("label"),
                "kind": entry.get("kind"),
            }
        )
    return networks


def _match(
    address: str | None, networks: list[dict[str, Any]]
) -> dict[str, Any] | None:
    if not address:
        return None
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return None
    for entry in networks:
        network = entry["network"]
        if network.version == ip.version and ip in network:
            return {
                "value": entry["value"],
                "label": entry["label"],
                "matched_network": str(network),
            }
    return None


def _trust_lookup(
    address: str | None, config: dict[str, Any], networks: list[dict[str, Any]]
) -> tuple[bool, dict[str, Any] | None]:
    del config  # the entries travel inside ``networks``
    matched = _match(address, networks)
    if not matched:
        return False, None
    return True, matched


def _format_match(matched: dict[str, Any] | None) -> str:
    if not matched:
        return ""
    value = matched.get("value")
    label = matched.get("label")
    return f"{value}（{label}）" if label else value


def _parse_list_field(
    key: str,
    label: str,
    kind: str,
    raw_lines: list[str],
    trust_config: dict[str, Any],
    networks: list[dict[str, Any]],
) -> dict[str, Any]:
    """Parse one field and attach per-hop facts (without a final decision)."""
    occurrences = [line for line in raw_lines if line.strip() != ""]
    field: dict[str, Any] = {
        "key": key,
        "label": label,
        "kind": kind,
        "enabled": bool(trust_config["fields"].get(key, {}).get("enabled")),
        "max_hops": trust_config["fields"].get(key, {}).get("max_hops"),
        "present": bool(occurrences),
        "raw_lines": occurrences,
        "duplicate_field": len(occurrences) > 1,
        "status": "absent",
        "status_label": "未出现",
        "used": False,
        "role": None,
        "hops": [],
        "notes": [],
        "problem": None,
    }
    if not occurrences:
        return field
    if field["duplicate_field"]:
        field["problem"] = (
            f"{label} 出现了 {len(occurrences)} 次；重复字段的拼接顺序不被接受，"
            "无法确定哪一份内容生效"
        )

    # Parse the first occurrence for display either way.  When the field is
    # duplicated the parsed hops are still shown, but marked as not used.
    line = occurrences[0]
    hops: list[dict[str, Any]] = []
    if kind == "list":
        if key == "forwarded":
            elements = parse_forwarded(line)
            pairs = [
                {
                    "raw": element.raw,
                    "kind": element.kind,
                    "address": element.address,
                    "version": element.version,
                    "port": element.port,
                    "problem": element.problem,
                    "note": element.note,
                }
                for element in elements
            ]
        else:
            pairs = [item.to_dict() for item in parse_forwarded_list(line)]
        for position, item in enumerate(pairs, start=1):
            hops.append(
                {
                    "position": position,
                    "position_from_peer": len(pairs) - position + 1,
                    **item,
                    "trust": None,
                    "trust_label": None,
                    "decision": None,
                    "decision_label": None,
                    "reason": None,
                }
            )
    else:
        item = parse_address(line)
        hops.append(
            {
                "position": 1,
                "position_from_peer": 1,
                **item.to_dict(),
                "trust": None,
                "trust_label": None,
                "decision": None,
                "decision_label": None,
                "reason": None,
            }
        )
    field["hops"] = hops

    bad = [hop for hop in hops if hop["kind"] != "address"]
    if field["duplicate_field"]:
        field["status"] = "duplicate_field"
        field["status_label"] = "字段重复出现"
    elif bad:
        details = "；".join(
            f"第 {hop['position']} 项 {hop['raw']!r}：{hop['problem'] or '无法解析'}"
            for hop in bad
        )
        field["status"] = "malformed"
        field["status_label"] = "存在无法解析的项"
        field["problem"] = details
    elif kind == "list" and len(hops) > int(field["max_hops"] or 1):
        field["status"] = "limit_exceeded"
        field["status_label"] = "超过链路长度上限"
        field["problem"] = (
            f"{label} 有 {len(hops)} 跳，超过配置上限 {field['max_hops']}；"
            "超出上限的链路无法逐跳验证"
        )
    elif kind == "list":
        normalized = [hop["address"] for hop in hops if hop["address"]]
        duplicates = [value for value, count in Counter(normalized).items() if count > 1]
        if duplicates:
            field["status"] = "duplicate_hop"
            field["status_label"] = "链中存在重复地址"
            field["problem"] = (
                "链中重复出现地址 "
                + "、".join(duplicates)
                + "；重复跳次会使顺序与含义不唯一"
            )
    if field["status"] == "absent":
        field["status"] = "parsed"
        field["status_label"] = "解析成功"

    # Attach the factual trust status of each hop, regardless of whether the
    # field will end up being used.
    for hop in hops:
        if hop["kind"] == "address":
            trusted, matched = _trust_lookup(hop["address"], trust_config, networks)
            hop["trust"] = "trusted_proxy" if trusted else "untrusted"
            hop["trust_label"] = "命中可信配置" if trusted else "不在可信配置中"
            hop["matched_entry"] = matched
        else:
            hop["trust"] = "unparsed"
            hop["trust_label"] = "无法解析"
            hop["matched_entry"] = None
    return field


def _walk_list(
    field: dict[str, Any],
    trust_config: dict[str, Any],
    networks: list[dict[str, Any]],
    ignored_reason: str | None = None,
) -> tuple[str | None, str, str | None]:
    """Walk hops right-to-left.

    Returns ``(final_client, outcome, detail)`` where outcome is one of
    ``ok``, ``malformed``, ``incomplete``, ``limit_exceeded``, ``duplicate``
    or ``ignored``.
    """
    hops = field["hops"]
    if not hops:
        return None, "incomplete", "字段为空"

    structurally_bad = field["status"] in {
        "malformed",
        "duplicate_hop",
        "limit_exceeded",
        "duplicate_field",
    }

    if ignored_reason:
        for hop in hops:
            reason = ignored_reason
            if hop["kind"] != "address":
                reason += f"；该项本身也无法解析：{hop['problem'] or '格式未知'}"
            elif structurally_bad and field["problem"]:
                reason += f"；该字段另有结构问题：{field['problem']}"
            hop["decision"] = "excluded"
            hop["decision_label"] = "未采用"
            hop["reason"] = reason
        return None, "ignored", ignored_reason

    if structurally_bad:
        for hop in hops:
            hop["decision"] = "excluded"
            hop["decision_label"] = "未采用"
            if hop["kind"] != "address":
                hop["reason"] = f"无法解析：{hop['problem'] or '格式未知'}"
            else:
                hop["reason"] = field["problem"] or "字段存在结构问题，整条链无法验证"
        return None, field["status"], field["problem"]

    outcome = "incomplete"
    final: str | None = None
    for index in range(len(hops) - 1, -1, -1):
        hop = hops[index]
        if hop["kind"] != "address":
            hop["decision"] = "excluded"
            hop["decision_label"] = "未采用"
            hop["reason"] = f"无法解析：{hop['problem'] or '未知格式'}"
            for left in range(index - 1, -1, -1):
                hops[left]["decision"] = "excluded"
                hops[left]["decision_label"] = "未采用"
                hops[left]["reason"] = "右侧链条已中断，左侧地址无法验证"
            return None, "malformed", hop["reason"]
        if hop["trust"] == "trusted_proxy":
            hop["decision"] = "proxy"
            hop["decision_label"] = "可信代理"
            hop["reason"] = (
                "命中可信配置 " + _format_match(hop.get("matched_entry"))
                + "，继续向左回溯"
            )
            continue
        hop["decision"] = "client"
        hop["decision_label"] = "采用为客户端"
        hop["reason"] = "自右向左遇到的第一个不在可信配置中的地址，按客户端处理"
        for left in range(index - 1, -1, -1):
            hops[left]["decision"] = "excluded"
            hops[left]["decision_label"] = "未采用"
            hops[left]["reason"] = (
                "位于已确定客户端左侧，属于上游声明，无法在当前信任边界内验证"
            )
        return hop["address"], "ok", None

    # Every hop was a trusted proxy: the original client never appears.
    for hop in hops:
        hop["reason"] = hop["reason"] or "命中可信配置，但左侧没有出现客户端地址"
    return None, "incomplete", "链中所有地址都是可信代理，原始客户端不在链中"


def _walk_single(
    field: dict[str, Any], ignored_reason: str | None = None
) -> tuple[str | None, str, str | None]:
    hops = field["hops"]
    if not hops:
        return None, "incomplete", "字段为空"
    hop = hops[0]
    if ignored_reason:
        hop["decision"] = "excluded"
        hop["decision_label"] = "未采用"
        hop["reason"] = (
            f"{ignored_reason}（该字段另有结构问题：{field['problem']}）"
            if field["status"] == "malformed"
            else ignored_reason
        )
        return None, "ignored", ignored_reason
    if field["status"] == "malformed":
        hop["decision"] = "excluded"
        hop["decision_label"] = "未采用"
        hop["reason"] = field["problem"] or "无法解析"
        return None, "malformed", field["problem"]
    hop["decision"] = "client"
    hop["decision_label"] = "采用为客户端"
    hop["reason"] = "由可信代理写入的单值字段，按客户端处理"
    return hop["address"], "ok", None


def _compare_sequences(
    left: list[str], right: list[str]
) -> tuple[str, str]:
    if left == right:
        return "consistent", "两侧规范化后的跳序完全一致，可以互相印证"
    if Counter(left) == Counter(right):
        return (
            "order_conflict",
            "两侧包含相同的地址，但顺序不同；无法确认哪一侧的跳序真实，"
            "因此不采用其中任何一侧的结论",
        )
    return (
        "mismatch",
        f"两侧跳序不一致（{len(left)} 跳 vs {len(right)} 跳）；"
        "存在增删或顺序变化，无法唯一还原链路",
    )


def _summary_for(
    *,
    peer_address: str,
    outcome: str,
    final_client: str | None,
    list_field: dict[str, Any] | None,
    facts: list[str],
) -> str:
    if outcome == "trusted_chain" and final_client:
        if list_field:
            base = (
                f"连接对端 {peer_address} 命中可信代理配置；"
                f"沿 {list_field['label']} 逐跳回溯后，"
                f"最终客户端地址为 {final_client}。"
            )
        else:
            base = (
                f"连接对端 {peer_address} 命中可信代理配置；"
                f"由单值转发字段给出的最终客户端地址为 {final_client}。"
            )
        return base + "".join(facts)
    if outcome == "untrusted_peer":
        return (
            f"连接对端 {peer_address} 不在可信代理配置中，最终客户端地址就是 "
            f"{peer_address}。请求携带的转发字段未被采用；"
            "字段中出现的内网或保留地址不会自动取得信任。"
        )
    if outcome == "direct_peer":
        return f"连接对端 {peer_address} 可信，但请求没有携带已启用的转发字段，最终客户端按连接对端 {peer_address} 处理。"
    if outcome == "forwarding_disabled":
        return (
            f"连接对端 {peer_address} 可信，但请求携带的转发字段都没有在配置中启用，"
            f"最终客户端按连接对端 {peer_address} 处理。"
        )
    if outcome in {"order_conflict", "field_conflict", "single_conflict"}:
        return "两种转发信息无法对应，依据不足，本次不给出最终客户端地址。"
    if outcome == "chain_incomplete":
        return "链路中的所有地址都是可信代理，原始客户端没有出现在链中，依据不足，本次不给出最终客户端地址。"
    if outcome == "malformed_hop":
        return "转发链中存在无法可靠解析的项，链路因此中断，本次不给出最终客户端地址。"
    if outcome == "duplicate_field":
        return "同一转发字段重复出现，无法确定哪一份内容生效，本次不给出最终客户端地址。"
    if outcome == "duplicate_hop":
        return "转发链中出现重复地址，跳序含义不唯一，本次不给出最终客户端地址。"
    if outcome == "hop_limit_exceeded":
        return "转发链长度超过配置允许的上限，超出部分无法验证，本次不给出最终客户端地址。"
    if outcome == "peer_invalid":
        return "连接对端地址本身无法解析，无法建立信任起点。"
    return "没有可用于判定的转发字段。"


def analyze(
    peer_raw: str,
    headers: dict[str, list[str]],
    trust_config: dict[str, Any],
) -> dict[str, Any]:
    """Evaluate one request against an already normalised trust config."""
    reasons: list[dict[str, str]] = []
    steps: list[dict[str, str]] = []
    networks = _networks(trust_config)

    peer = parse_address(peer_raw or "")
    peer_info: dict[str, Any] = {
        **peer.to_dict(),
        "normalized": peer.address,
        "trusted": False,
        "matched_entry": None,
    }
    steps.append(
        _step(
            "解析连接对端",
            f"原始值 {peer.raw!r} → "
            + (
                f"规范化地址 {peer.address}"
                + (f"，端口 {peer.port}" if peer.port else "")
                if peer.kind == "address"
                else f"无法解析（{peer.problem}）"
            ),
            "info" if peer.kind == "address" else "error",
        )
    )

    fields: list[dict[str, Any]] = []
    for key in FIELD_ORDER:
        spec = trust_config["fields"][key]
        field = _parse_list_field(
            key,
            spec["label"],
            spec["kind"],
            headers.get(key, []) or [],
            trust_config,
            networks,
        )
        fields.append(field)

    peer_trusted = False
    if peer.kind == "address":
        peer_trusted, matched = _trust_lookup(peer.address, trust_config, networks)
        peer_info["trusted"] = peer_trusted
        peer_info["matched_entry"] = matched
        if peer_trusted:
            steps.append(
                _step(
                    "检查连接对端信任",
                    f"{peer.address} 命中可信配置 {_format_match(matched)}",
                    "ok",
                )
            )
        else:
            steps.append(
                _step(
                    "检查连接对端信任",
                    f"{peer.address} 不在可信代理配置中；"
                    "无论请求头写了什么，都不能改变最终客户端地址",
                    "warn",
                )
            )

    cross_check: dict[str, Any] = {
        "applicable": False,
        "status": "not_applicable",
        "status_label": "未进行交叉核对",
        "message": "仅一个转发字段参与判定，无第二个字段可核对",
        "fields": [],
        "sequences": {},
    }

    # ---- Peer is not trustworthy: headers are shown but never used. ----
    if peer.kind != "address" or not peer_trusted:
        if peer.kind != "address":
            outcome = "peer_invalid"
            final = None
            reasons.append(
                _issue(
                    "peer_invalid",
                    f"连接对端 {peer.raw!r} 无法解析为 IPv4/IPv6 地址：{peer.problem}",
                    "error",
                )
            )
            status = "undetermined"
        else:
            outcome = "untrusted_peer"
            final = peer.address
            status = "determined"
            reasons.append(
                _issue(
                    "untrusted_peer",
                    f"连接对端 {peer.address} 不在可信配置中，所有转发字段均不参与判定",
                    "warn",
                )
            )
            if any(field["present"] for field in fields):
                reasons.append(
                    _issue(
                        "forwarding_ignored",
                        "请求携带了转发字段，但来源不可信；这些内容可能是伪造的，"
                        "其中出现的地址（包括内网地址）没有被当作可信来源",
                        "warn",
                    )
                )
        for field in fields:
            if not field["present"]:
                continue
            if field["enabled"]:
                ignored_reason = (
                    "连接对端不可信，字段内容不被采用"
                    if peer.kind == "address"
                    else "连接对端无法解析，字段内容不被采用"
                )
            else:
                ignored_reason = (
                    "字段未在信任配置中启用，且连接对端不可信，内容不被采用"
                )
            if field["kind"] == "list":
                _walk_list(field, trust_config, networks, ignored_reason)
            else:
                _walk_single(field, ignored_reason)
            field["used"] = False
            if field["enabled"] and peer.kind == "address":
                field["status"] = "ignored_untrusted_peer"
                field["status_label"] = "已忽略（对端不可信）"
            elif field["enabled"]:
                field["status"] = "ignored_invalid_peer"
                field["status_label"] = "已忽略（对端无法解析）"
            else:
                field["status"] = "disabled"
                field["status_label"] = "未启用，已忽略"
        cross_check["status"] = "not_applicable"
        cross_check["status_label"] = "未进行交叉核对"
        cross_check["message"] = (
            "连接对端不可信，两种转发字段都不会被采用"
            if peer.kind == "address"
            else "连接对端无法解析，没有信任起点，两种转发字段都不会被采用"
        )
        return _build_result(
            status=status,
            outcome=outcome,
            final=final,
            final_version=(
                peer.version if final == peer.address and peer.version else None
            ),
            peer_info=peer_info,
            fields=fields,
            cross_check=cross_check,
            reasons=reasons,
            steps=steps,
            trust_config=trust_config,
            list_field=None,
        )

    # ---- Peer is trusted from here on. ----
    enabled_present = [
        field for field in fields if field["enabled"] and field["present"]
    ]
    present_disabled = [
        field for field in fields if not field["enabled"] and field["present"]
    ]
    for field in present_disabled:
        if field["kind"] == "list":
            _walk_list(
                field, trust_config, networks, "字段未在信任配置中启用，内容被忽略"
            )
        else:
            _walk_single(field, "字段未在信任配置中启用，内容被忽略")
        field["status"] = "disabled"
        field["status_label"] = "未启用，已忽略"
        reasons.append(
            _issue(
                f"field_disabled:{field['key']}",
                f"{field['label']} 出现在请求中，但配置未启用该字段，内容不参与判定",
                "info",
            )
        )

    if not enabled_present:
        outcome = "forwarding_disabled" if present_disabled else "direct_peer"
        reason = (
            "请求携带的转发字段都未启用，最终地址保持为连接对端"
            if present_disabled
            else "请求未携带任何已启用的转发字段，最终地址保持为连接对端"
        )
        reasons.append(_issue("no_forwarding", reason, "info"))
        for field in fields:
            if field["present"] and field["enabled"]:
                field["status"] = "absent"
                field["status_label"] = "未出现"
        return _build_result(
            status="determined",
            outcome=outcome,
            final=peer.address,
            final_version=peer.version,
            peer_info=peer_info,
            fields=fields,
            cross_check=cross_check,
            reasons=reasons,
            steps=steps
            + [_step("确定最终地址", f"采用连接对端 {peer.address}", "ok")],
            trust_config=trust_config,
            list_field=None,
        )

    # Duplicate header occurrences are never resolved by concatenation.
    duplicate_fields = [field for field in enabled_present if field["duplicate_field"]]
    for field in duplicate_fields:
        field["used"] = False
        reasons.append(
            _issue(
                f"duplicate_field:{field['key']}",
                field["problem"] or f"{field['label']} 重复出现",
                "error",
            )
        )

    # Parse-level problems on enabled fields.
    usable_lists: list[dict[str, Any]] = []
    usable_singles: list[dict[str, Any]] = []
    fatal_outcome: str | None = None
    for field in enabled_present:
        if field["duplicate_field"]:
            field["used"] = False
            fatal_outcome = fatal_outcome or "duplicate_field"
            continue
        if field["status"] in {"malformed", "duplicate_hop", "limit_exceeded"}:
            field["used"] = False
            outcome_for_field = {
                "malformed": "malformed_hop",
                "duplicate_hop": "duplicate_hop",
                "limit_exceeded": "hop_limit_exceeded",
            }[field["status"]]
            fatal_outcome = fatal_outcome or outcome_for_field
            reasons.append(
                _issue(
                    f"{field['status']}:{field['key']}",
                    f"{field['label']}：{field['problem']}",
                    "error",
                )
            )
            continue
        if field["kind"] == "list":
            usable_lists.append(field)
        else:
            usable_singles.append(field)

    # Cross-check the two list fields when both are present and usable.
    list_sequences: dict[str, list[str]] = {}
    for field in usable_lists:
        list_sequences[field["key"]] = [
            hop["address"] for hop in field["hops"] if hop["address"]
        ]
    if len(usable_lists) == 2:
        left, right = usable_lists
        left_seq = list_sequences[left["key"]]
        right_seq = list_sequences[right["key"]]
        comparison, message = _compare_sequences(left_seq, right_seq)
        cross_check = {
            "applicable": True,
            "status": comparison,
            "status_label": {
                "consistent": "两边一致",
                "order_conflict": "顺序冲突",
                "mismatch": "链路不一致",
            }[comparison],
            "message": message,
            "fields": [left["key"], right["key"]],
            "sequences": list_sequences,
        }
        steps.append(
            _step(
                "交叉核对两种转发字段",
                f"{left['label']} = {left_seq}；{right['label']} = {right_seq}。{message}",
                "ok" if comparison == "consistent" else "error",
            )
        )
        if comparison != "consistent":
            fatal_outcome = {
                "order_conflict": "order_conflict",
                "mismatch": "field_conflict",
            }[comparison]
            reasons.append(
                _issue(
                    f"cross_check:{comparison}",
                    f"{message}。因此本次不挑选其中任何一侧作为结论",
                    "error",
                )
            )
            left["used"] = False
            right["used"] = False
            left["status"] = right["status"] = (
                "order_conflict" if comparison == "order_conflict" else "conflict"
            )
            left["status_label"] = right["status_label"] = (
                "顺序冲突" if comparison == "order_conflict" else "链路不一致"
            )
    elif len(usable_lists) == 1:
        cross_check["applicable"] = False
        cross_check["message"] = (
            f"仅 {usable_lists[0]['label']} 参与判定，没有第二个列表型转发字段可核对"
        )
    elif len(usable_singles) >= 2:
        cross_check["applicable"] = True
        cross_check["message"] = "仅有两个单值字段，将核对它们是否一致"
        cross_check["fields"] = [field["key"] for field in usable_singles]

    if fatal_outcome:
        if len(enabled_present) >= 2 and not cross_check["applicable"]:
            # Two fields were submitted but at least one cannot be parsed, so
            # their correspondence cannot be checked at all.
            other_fields = [
                field for field in enabled_present if not field["duplicate_field"]
            ]
            cross_check = {
                "applicable": True,
                "status": "unusable",
                "status_label": "无法核对",
                "message": (
                    "同时收到了两种转发字段，但其中一侧无法可靠解析，"
                    "无法确认两边是否能对应，因此不采用任何一侧"
                ),
                "fields": [field["key"] for field in other_fields],
                "sequences": {
                    field["key"]: [
                        hop["address"] for hop in field["hops"] if hop["address"]
                    ]
                    for field in other_fields
                    if field["hops"]
                },
            }
        for field in enabled_present:
            if field["kind"] == "list" and not field["used"]:
                _walk_list(
                    field,
                    trust_config,
                    networks,
                    "本次判定已中止，字段内容未采用",
                )
            elif field["kind"] == "single" and not field["used"]:
                _walk_single(field, "本次判定已中止，字段内容未采用")
        return _build_result(
            status="undetermined",
            outcome=fatal_outcome,
            final=None,
            final_version=None,
            peer_info=peer_info,
            fields=fields,
            cross_check=cross_check,
            reasons=reasons,
            steps=steps + [_step("中止判定", "依据不足，不输出最终客户端地址", "error")],
            trust_config=trust_config,
            list_field=usable_lists[0] if len(usable_lists) == 1 else None,
        )

    # ---- Resolve the chain. ----
    final: str | None = None
    final_version: int | None = None
    outcome = "trusted_chain"
    list_field: dict[str, Any] | None = None

    if usable_lists:
        primitive = usable_lists[0]
        list_field = primitive
        final, walk_outcome, detail = _walk_list(primitive, trust_config, networks)
        if walk_outcome == "ok":
            final_version = next(
                (hop["version"] for hop in primitive["hops"] if hop["address"] == final),
                None,
            )
            primitive["used"] = True
            primitive["role"] = "primary"
            primitive["status"] = "used"
            primitive["status_label"] = "已采用"
            if len(usable_lists) == 2:
                corroborating = usable_lists[1]
                # Same sequence, so it resolves identically.  Mark its hops
                # consistently with the primary to keep the UI honest.
                _walk_list(corroborating, trust_config, networks)
                corroborating["used"] = True
                corroborating["role"] = "corroborating"
                corroborating["status"] = "used"
                corroborating["status_label"] = "已采用（与另一字段一致）"
                reasons.append(
                    _issue(
                        "cross_check_consistent",
                        f"{primitive['label']} 与 {corroborating['label']} 的跳序一致，"
                        "两者共同支撑该结论",
                        "info",
                    )
                )
            steps.append(
                _step(
                    "回溯转发链",
                    f"{primitive['label']} 自右向左判定，最终客户端 {final}",
                    "ok",
                )
            )
        elif walk_outcome == "incomplete":
            outcome = "chain_incomplete"
            reasons.append(_issue("chain_incomplete", detail or "链路未闭合", "error"))
            primitive["used"] = False
            primitive["status"] = "incomplete"
            primitive["status_label"] = "链路未闭合"
            if len(usable_lists) == 2:
                _walk_list(
                    usable_lists[1],
                    trust_config,
                    networks,
                    "另一字段链路未闭合，两边无法形成完整结论",
                )
                usable_lists[1]["used"] = False
                usable_lists[1]["status"] = "incomplete"
                usable_lists[1]["status_label"] = "链路未闭合"
            for single in usable_singles:
                _walk_single(
                    single, "链式字段未能闭合，单值字段无法单独作为结论"
                )
                single["used"] = False
                single["status"] = "unverified"
                single["status_label"] = "链路未闭合，无法核对"
            steps.append(_step("回溯转发链", detail or "链路未闭合", "error"))
        else:  # malformed etc. should have been caught above
            outcome = "no_field_usable"
            reasons.append(
                _issue("no_field_usable", detail or "没有可用字段", "error")
            )
    elif usable_singles:
        first = usable_singles[0]
        final, walk_outcome, detail = _walk_single(first)
        if walk_outcome == "ok":
            first["used"] = True
            first["role"] = "primary"
            first["status"] = "used"
            first["status_label"] = "已采用"
            final_version = next(
                (
                    hop["version"]
                    for hop in first["hops"]
                    if hop["address"] == final
                ),
                None,
            )
            for extra in usable_singles[1:]:
                if extra["hops"] and extra["hops"][0]["address"] == final:
                    extra["used"] = True
                    extra["role"] = "corroborating"
                    extra["status"] = "used"
                    extra["status_label"] = "已采用（与另一字段一致）"
                    extra["hops"][0]["decision"] = "client"
                    extra["hops"][0]["decision_label"] = "采用为客户端"
                    extra["hops"][0]["reason"] = "与另一单值字段一致"
                else:
                    extra["used"] = False
                    extra["status"] = "conflict"
                    extra["status_label"] = "与另一字段不一致"
                    extra["hops"][0]["decision"] = "excluded"
                    extra["hops"][0]["decision_label"] = "未采用"
                    extra["hops"][0]["reason"] = "与另一单值字段给出的地址不同"
                    fatal_outcome = "single_conflict"
                    reasons.append(
                        _issue(
                            "single_conflict",
                            f"{extra['label']} 给出的地址与 {first['label']} 不同，"
                            "两个单值字段互相矛盾",
                            "error",
                        )
                    )
            if len(usable_singles) > 1:
                cross_check["status"] = (
                    "consistent" if not fatal_outcome else "mismatch"
                )
                cross_check["status_label"] = (
                    "两边一致" if not fatal_outcome else "互相矛盾"
                )
                cross_check["sequences"] = {
                    field["key"]: [
                        hop["address"] for hop in field["hops"] if hop["address"]
                    ]
                    for field in usable_singles
                }
            steps.append(
                _step(
                    "采用单值转发字段",
                    f"{first['label']} 由可信代理写入，客户端为 {final}",
                    "ok",
                )
            )
        else:
            outcome = "malformed_hop"
            reasons.append(
                _issue("malformed_hop", detail or "单值字段无法解析", "error")
            )
    else:
        outcome = "no_field_usable"
        reasons.append(
            _issue(
                "no_field_usable",
                "所有已启用的转发字段都无法形成可用链路",
                "error",
            )
        )

    # Single fields corroborate or contradict a resolved list chain.
    if final and usable_lists and usable_singles:
        for single in usable_singles:
            single_value = (
                single["hops"][0]["address"] if single["hops"] else None
            )
            if single_value == final:
                single["used"] = True
                single["role"] = "corroborating"
                single["status"] = "used"
                single["status_label"] = "已采用（与链路一致）"
                single["hops"][0]["decision"] = "client"
                single["hops"][0]["decision_label"] = "与链路结论一致"
                single["hops"][0]["reason"] = (
                    f"单值字段给出的地址与链路最终客户端 {final} 相同"
                )
                steps.append(
                    _step(
                        "核对单值字段",
                        f"{single['label']} 与链路结论一致：{final}",
                        "ok",
                    )
                )
            else:
                single["used"] = False
                single["status"] = "conflict"
                single["status_label"] = "与链路结论不一致"
                single["hops"][0]["decision"] = "excluded"
                single["hops"][0]["decision_label"] = "未采用"
                single["hops"][0]["reason"] = (
                    f"给出 {single_value}，与链路最终客户端 {final} 不同"
                )
                fatal_outcome = "single_conflict"
                reasons.append(
                    _issue(
                        "single_conflict",
                        f"{single['label']} 给出 {single_value}，"
                        f"但链路得出的客户端是 {final}；两者矛盾",
                        "error",
                    )
                )
        cross_check["applicable"] = True
        cross_check["fields"] = [list_field["key"]] + [
            single["key"] for single in usable_singles
        ]
        if not fatal_outcome:
            cross_check["status"] = "consistent"
            cross_check["status_label"] = "单值字段与链路一致"
            cross_check["message"] = (
                f"{list_field['label']} 与单值字段都指向 {final}"
            )
        else:
            cross_check["status"] = "mismatch"
            cross_check["status_label"] = "单值字段与链路矛盾"
            cross_check["message"] = (
                "单值字段与链路结论不同，无法判断哪一份内容可信"
            )

    if fatal_outcome:
        final = None
        final_version = None
        outcome = fatal_outcome
        if list_field:
            list_field["used"] = False
            list_field["status"] = "conflict"
            list_field["status_label"] = "因交叉核对矛盾未采用"
            for hop in list_field["hops"]:
                if hop["decision"] in {"client", "proxy"}:
                    hop["decision"] = "excluded"
                    hop["decision_label"] = "未采用"
                    hop["reason"] = "交叉核对发现矛盾，本次判定中止"
        # Every field that had been provisionally adopted must be reset as
        # well, otherwise the per-hop table would contradict the
        # "undetermined" verdict.
        for field in [*usable_lists, *usable_singles]:
            if field is list_field:
                continue
            if not field["used"]:
                continue
            field["used"] = False
            field["role"] = None
            field["status"] = "conflict"
            field["status_label"] = "本次判定已中止"
            for hop in field["hops"]:
                if hop["decision"] in {"client", "proxy"}:
                    hop["decision"] = "excluded"
                    hop["decision_label"] = "未采用"
                    hop["reason"] = "交叉核对发现矛盾，本次判定中止"
        steps.append(_step("中止判定", "字段之间互相矛盾，不输出最终客户端地址", "error"))

    if outcome == "trusted_chain" and final:
        reasons.append(
            _issue(
                "trusted_chain",
                f"可信代理链还原成功，最终客户端为 {final}",
                "info",
            )
        )
    if outcome == "chain_incomplete":
        final = None
        final_version = None

    facts: list[str] = []
    if final and list_field:
        for hop in list_field["hops"]:
            if hop["decision"] == "proxy":
                facts.append(f" {hop['address']} 是可信代理；")
            elif hop["decision"] == "client":
                facts.append(f" {hop['address']} 不可信，作为客户端。")
    summary = _summary_for(
        peer_address=peer.address,
        outcome=outcome,
        final_client=final,
        list_field=list_field,
        facts=facts,
    )
    steps.append(
        _step(
            "确定最终地址",
            (
                f"最终客户端 {final}"
                if final
                else "依据不足，不输出最终客户端地址"
            ),
            "ok" if final else "error",
        )
    )
    return _build_result(
        status="determined" if final else "undetermined",
        outcome=outcome,
        final=final,
        final_version=final_version,
        peer_info=peer_info,
        fields=fields,
        cross_check=cross_check,
        reasons=reasons,
        steps=steps,
        trust_config=trust_config,
        list_field=list_field,
        summary_override=summary,
    )


def _build_result(
    *,
    status: str,
    outcome: str,
    final: str | None,
    final_version: int | None,
    peer_info: dict[str, Any],
    fields: list[dict[str, Any]],
    cross_check: dict[str, Any],
    reasons: list[dict[str, str]],
    steps: list[dict[str, str]],
    trust_config: dict[str, Any],
    list_field: dict[str, Any] | None,
    summary_override: str | None = None,
) -> dict[str, Any]:
    risk, risk_label = RISK_BY_OUTCOME.get(outcome, ("unknown", "待核实"))
    outcome_label = OUTCOME_LABELS.get(outcome, outcome)
    summary = summary_override or _summary_for(
        peer_address=peer_info["normalized"] or peer_info["raw"],
        outcome=outcome,
        final_client=final,
        list_field=list_field,
        facts=[],
    )
    return {
        "verdict": {
            "status": status,
            "status_label": STATUS_LABELS[status],
            "outcome": outcome,
            "outcome_label": outcome_label,
            "risk": risk,
            "risk_label": risk_label,
            "final_client": final,
            "final_client_version": final_version,
            "summary": summary,
        },
        "peer": peer_info,
        "fields": fields,
        "cross_check": cross_check,
        "reasons": reasons,
        "steps": steps,
        "assumptions": ASSUMPTIONS,
        "config_name": trust_config.get("name"),
    }
