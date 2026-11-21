"""Built-in demonstration requests.

Each demo carries its own trust configuration so that loading a demo never
depends on whatever config a user happens to have saved.  Header values are
lists to mirror repeated HTTP header occurrences; each list entry is one
occurrence, values inside an entry are comma separated hops.
"""

from __future__ import annotations

from typing import Any

TRUSTED_LAN = {"value": "10.0.0.0/8", "label": "内网反向代理"}
TRUSTED_CDN = {"value": "192.0.2.0/24", "label": "CDN 回源段"}


def _fields(
    *,
    xff: bool = False,
    forwarded: bool = False,
    x_real_ip: bool = False,
    cf: bool = False,
    max_hops: int = 5,
) -> dict[str, dict[str, Any]]:
    return {
        "x_forwarded_for": {"enabled": xff, "max_hops": max_hops},
        "forwarded": {"enabled": forwarded, "max_hops": max_hops},
        "x_real_ip": {"enabled": x_real_ip, "max_hops": 1},
        "cf_connecting_ip": {"enabled": cf, "max_hops": 1},
    }


def _headers(
    *,
    xff: str | list[str] | None = None,
    forwarded: str | list[str] | None = None,
    x_real_ip: str | list[str] | None = None,
    cf: str | list[str] | None = None,
) -> dict[str, list[str]]:
    def wrap(value: str | list[str] | None) -> list[str] | None:
        if value is None:
            return None
        return [value] if isinstance(value, str) else value

    return {
        "x_forwarded_for": wrap(xff),
        "forwarded": wrap(forwarded),
        "x_real_ip": wrap(x_real_ip),
        "cf_connecting_ip": wrap(cf),
    }


DEMOS: list[dict[str, Any]] = [
    {
        "slug": "trusted-chain",
        "title": "可信代理链还原",
        "description": "CDN 与反向代理都在可信配置中，逐跳向右向左回溯得到原始客户端。",
        "expectation": {
            "status": "determined",
            "outcome": "trusted_chain",
            "outcome_label": "可信代理链还原成功",
            "final_client": "203.0.113.42",
            "note": "右侧 192.0.2.10、10.0.0.5 都是可信代理，203.0.113.42 是客户端。",
        },
        "peer": "10.0.0.5",
        "headers": _headers(xff="203.0.113.42, 192.0.2.10, 10.0.0.5"),
        "config": {
            "name": "演示：可信代理链",
            "entries": [TRUSTED_LAN, TRUSTED_CDN],
            "fields": _fields(xff=True),
        },
    },
    {
        "slug": "spoofed-header",
        "title": "伪造转发头",
        "description": "客户端直连，却自带看起来像内网代理的 X-Forwarded-For 和 X-Real-IP。",
        "expectation": {
            "status": "determined",
            "outcome": "untrusted_peer",
            "outcome_label": "对端不可信，转发信息被忽略",
            "final_client": "198.51.100.77",
            "note": "对端 198.51.100.77 不在可信配置中；10.0.0.5、127.0.0.1 等地址不会因此被当成可信来源。",
        },
        "peer": "198.51.100.77",
        "headers": _headers(
            xff="10.0.0.5, 127.0.0.1",
            x_real_ip="10.1.2.3",
        ),
        "config": {
            "name": "演示：伪造转发头",
            "entries": [TRUSTED_LAN, TRUSTED_CDN],
            "fields": _fields(xff=True, x_real_ip=True),
        },
    },
    {
        "slug": "ipv4-ipv6-mixed",
        "title": "IPv4 与 IPv6 混合链",
        "description": "方括号 IPv6、带端口 IPv6 与 IPv4 映射 IPv6 混合出现，全部规范化后判定。",
        "expectation": {
            "status": "determined",
            "outcome": "trusted_chain",
            "outcome_label": "可信代理链还原成功",
            "final_client": "2001:db9:abcd::7",
            "note": "[2001:db8::1]:443 与 ::ffff:192.0.2.10 都是可信代理。",
        },
        "peer": "[2001:db8:1::10]:8080",
        "headers": _headers(
            xff="2001:db9:abcd::7, [2001:db8::1]:443, ::ffff:192.0.2.10"
        ),
        "config": {
            "name": "演示：IPv4/IPv6 混合",
            "entries": [
                {"value": "2001:db8:1::/48", "label": "IPv6 入口代理"},
                {"value": "2001:db8::1/128", "label": "IPv6 CDN 节点"},
                {"value": "192.0.2.10", "label": "IPv4 回源代理"},
            ],
            "fields": _fields(xff=True, max_hops=6),
        },
    },
    {
        "slug": "field-conflict",
        "title": "两种字段相互冲突",
        "description": "X-Forwarded-For 与 Forwarded 包含相同地址但顺序相反。",
        "expectation": {
            "status": "undetermined",
            "outcome": "order_conflict",
            "outcome_label": "两种转发字段顺序冲突",
            "final_client": None,
            "note": "顺序冲突时依据不足，不挑选看起来合理的一侧。",
        },
        "peer": "10.0.0.5",
        "headers": _headers(
            xff="203.0.113.42, 192.0.2.10, 10.0.0.5",
            forwarded="for=10.0.0.5, for=192.0.2.10, for=203.0.113.42",
        ),
        "config": {
            "name": "演示：字段冲突",
            "entries": [TRUSTED_LAN, TRUSTED_CDN],
            "fields": _fields(xff=True, forwarded=True),
        },
    },
    {
        "slug": "malformed-input",
        "title": "格式错误的输入",
        "description": "链路中含空项、unknown 与非法地址，无法可靠还原。",
        "expectation": {
            "status": "undetermined",
            "outcome": "malformed_hop",
            "outcome_label": "转发链中存在无法解析的地址",
            "final_client": None,
            "note": "空项与非法值使链路中断，明确显示无法判定。",
        },
        "peer": "10.0.0.5",
        "headers": _headers(xff="203.0.113.42, , unknown, 999.1.1.1"),
        "config": {
            "name": "演示：格式错误",
            "entries": [TRUSTED_LAN, TRUSTED_CDN],
            "fields": _fields(xff=True, max_hops=8),
        },
    },
    {
        "slug": "duplicate-header",
        "title": "重复的转发字段",
        "description": "同一 X-Forwarded-For 请求头出现了两次，直接拼接的顺序不可信。",
        "expectation": {
            "status": "undetermined",
            "outcome": "duplicate_field",
            "outcome_label": "同一转发字段重复出现",
            "final_client": None,
            "note": "重复字段不做拼接，直接判定依据不足。",
        },
        "peer": "10.0.0.5",
        "headers": _headers(
            xff=["203.0.113.42, 192.0.2.10", "198.51.100.9"]
        ),
        "config": {
            "name": "演示：重复字段",
            "entries": [TRUSTED_LAN, TRUSTED_CDN],
            "fields": _fields(xff=True),
        },
    },
    {
        "slug": "incomplete-chain",
        "title": "链条不完整",
        "description": "链中所有地址都命中可信配置，原始客户端没有出现。",
        "expectation": {
            "status": "undetermined",
            "outcome": "chain_incomplete",
            "outcome_label": "链路未闭合，缺少原始客户端",
            "final_client": None,
            "note": "无法确定客户端，明确显示依据不足。",
        },
        "peer": "10.0.0.5",
        "headers": _headers(xff="192.0.2.10, 10.0.0.5"),
        "config": {
            "name": "演示：链条不完整",
            "entries": [TRUSTED_LAN, TRUSTED_CDN],
            "fields": _fields(xff=True),
        },
    },
    {
        "slug": "trusted-forwarded-consistent",
        "title": "Forwarded 与 XFF 一致",
        "description": "RFC 7239 Forwarded 与 X-Forwarded-For 跳序一致，可互相印证。",
        "expectation": {
            "status": "determined",
            "outcome": "trusted_chain",
            "outcome_label": "可信代理链还原成功",
            "final_client": "203.0.113.42",
            "note": "两种字段顺序完全一致，结论由两边共同支撑。",
        },
        "peer": "10.0.0.5",
        "headers": _headers(
            xff="203.0.113.42, 192.0.2.10",
            forwarded='for="203.0.113.42";proto=https, for=192.0.2.10',
        ),
        "config": {
            "name": "演示：Forwarded 与 XFF 一致",
            "entries": [
                TRUSTED_LAN,
                {"value": "192.0.2.0/24", "label": "IPv4 回源代理"},
            ],
            "fields": _fields(xff=True, forwarded=True),
        },
    },
    {
        "slug": "single-field-conflict",
        "title": "单值字段与链路矛盾",
        "description": "X-Forwarded-For 还原出的客户端与 X-Real-IP 不一致。",
        "expectation": {
            "status": "undetermined",
            "outcome": "single_conflict",
            "outcome_label": "单值字段与链路结果不一致",
            "final_client": None,
            "note": "单值字段给出不同地址时，不判断哪一份内容可信。",
        },
        "peer": "10.0.0.5",
        "headers": _headers(
            xff="203.0.113.42, 192.0.2.10",
            x_real_ip="198.51.100.99",
        ),
        "config": {
            "name": "演示：单值字段矛盾",
            "entries": [TRUSTED_LAN, TRUSTED_CDN],
            "fields": _fields(xff=True, x_real_ip=True),
        },
    },
    {
        "slug": "hop-limit",
        "title": "链路超过长度上限",
        "description": "配置只允许 2 跳，但请求声明了 3 跳。",
        "expectation": {
            "status": "undetermined",
            "outcome": "hop_limit_exceeded",
            "outcome_label": "转发链长度超出配置上限",
            "final_client": None,
            "note": "超出上限的跳次无法验证，不输出结论。",
        },
        "peer": "10.0.0.5",
        "headers": _headers(
            xff="203.0.113.42, 192.0.2.10, 198.51.100.20"
        ),
        "config": {
            "name": "演示：超长链路",
            "entries": [
                TRUSTED_LAN,
                TRUSTED_CDN,
                {"value": "198.51.100.0/24", "label": "边缘代理"},
            ],
            "fields": _fields(xff=True, max_hops=2),
        },
    },
]

DEMO_BY_SLUG = {demo["slug"]: demo for demo in DEMOS}


def public_demos() -> list[dict[str, Any]]:
    """Demo list for the UI: description plus the expected verdict."""
    return [
        {
            "slug": demo["slug"],
            "title": demo["title"],
            "description": demo["description"],
            "expectation": demo["expectation"],
            "config_name": demo["config"]["name"],
        }
        for demo in DEMOS
    ]


def demo_payload(slug: str) -> dict[str, Any]:
    demo = DEMO_BY_SLUG.get(slug)
    if demo is None:
        raise KeyError(slug)
    return {
        "slug": demo["slug"],
        "title": demo["title"],
        "description": demo["description"],
        "expectation": demo["expectation"],
        "peer": demo["peer"],
        "headers": demo["headers"],
        "config": demo["config"],
        "analysis_request": {
            "peer": demo["peer"],
            "headers": demo["headers"],
            "config": demo["config"],
        },
    }
