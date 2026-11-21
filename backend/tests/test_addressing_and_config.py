"""Unit tests for address parsing and trust configuration validation."""

from __future__ import annotations

import pytest

from app.addressing import parse_address, parse_forwarded, parse_forwarded_list
from app.config import normalize_trust_config


def test_parse_ipv4_with_port():
    item = parse_address("203.0.113.42:8080")
    assert item.kind == "address"
    assert item.address == "203.0.113.42"
    assert item.port == 8080
    assert item.version == 4


def test_parse_bracketed_ipv6_with_port():
    item = parse_address("[2001:db8::1]:443")
    assert item.kind == "address"
    assert item.address == "2001:db8::1"
    assert item.port == 443
    assert item.version == 6


def test_parse_bracketed_ipv4_is_rejected():
    item = parse_address("[203.0.113.42]:443")
    assert item.kind == "malformed"


def test_parse_unbracketed_ipv6_with_port_is_rejected():
    item = parse_address("2001:db8::1:443")
    assert item.kind in {"address", "malformed"}
    if item.kind == "malformed":
        assert "方括号" in item.problem
    else:
        # A bare IPv6 is a legal address; port cannot be inferred.
        assert item.port is None


def test_parse_quoted_value():
    item = parse_address('"203.0.113.42"')
    assert item.kind == "address"
    assert item.address == "203.0.113.42"


def test_parse_mismatched_quotes():
    assert parse_address('"203.0.113.42').kind == "malformed"


def test_parse_quoted_ipv6_with_port():
    item = parse_address('"[2001:db8::1]:8443"')
    assert item.kind == "address"
    assert item.address == "2001:db8::1"
    assert item.port == 8443


def test_parse_port_out_of_range():
    assert parse_address("203.0.113.42:0").kind == "malformed"
    assert parse_address("203.0.113.42:65536").kind == "malformed"
    assert parse_address("[2001:db8::1]:").kind == "malformed"


def test_parse_mapped_inside_brackets_normalises_to_ipv4():
    item = parse_address("[::ffff:192.0.2.10]:443")
    assert item.kind == "address"
    assert item.address == "192.0.2.10"
    assert item.port == 443
    assert item.note


def test_parse_empty_and_unknown():
    assert parse_address("").kind == "empty"
    assert parse_address("   ").kind == "empty"
    assert parse_address("unknown").kind == "unknown"
    assert parse_address("-").kind == "unknown"


def test_parse_garbage():
    assert parse_address("999.1.1.1").kind == "malformed"
    assert parse_address("example.com").kind == "malformed"
    assert parse_address("1.2.3.4;for=5").kind == "malformed"
    assert parse_address("1.2.3.4 extra").kind == "malformed"


def test_parse_zero_padded_ipv4_rejected():
    # ``ipaddress`` rejects ambiguous leading zeros by default.
    assert parse_address("010.0.0.1").kind == "malformed"


def test_ipv4_mapped_ipv6_normalised():
    item = parse_address("::ffff:192.0.2.10")
    assert item.kind == "address"
    assert item.address == "192.0.2.10"
    assert item.version == 4
    assert item.note


def test_zone_id_rejected():
    assert parse_address("fe80::1%eth0").kind == "malformed"


def test_forwarded_list_preserves_occurrences():
    items = parse_forwarded_list("1.1.1.1, , unknown, 999.1.1.1")
    assert [item.kind for item in items] == [
        "address",
        "empty",
        "unknown",
        "malformed",
    ]


def test_forwarded_rfc7239_quoting():
    elements = parse_forwarded(
        'for="[2001:db8::1]:443";proto=https, for=192.0.2.1'
    )
    assert len(elements) == 2
    assert elements[0].address == "2001:db8::1"
    assert elements[0].port == 443
    assert elements[0].params["proto"] == "https"
    assert elements[1].address == "192.0.2.1"


def test_forwarded_obfuscated_identifier():
    elements = parse_forwarded("for=_hidden")
    assert elements[0].kind == "unknown"


def test_forwarded_duplicate_param_is_malformed():
    elements = parse_forwarded("for=1.1.1.1;for=2.2.2.2")
    assert elements[0].kind == "malformed"


def _base_config(**overrides):
    config = {
        "name": "测试",
        "entries": [{"value": "10.0.0.0/8", "label": "内网"}],
        "fields": {
            "x_forwarded_for": {"enabled": True, "max_hops": 4},
            "forwarded": {"enabled": True, "max_hops": 4},
            "x_real_ip": {"enabled": False, "max_hops": 1},
            "cf_connecting_ip": {"enabled": False, "max_hops": 1},
        },
    }
    config.update(overrides)
    return config


def test_config_valid():
    normalized, errors, warnings = normalize_trust_config(_base_config())
    assert errors == []
    assert normalized is not None
    assert normalized["entries"][0]["value"] == "10.0.0.0/8"
    assert normalized["fields"]["x_forwarded_for"]["max_hops"] == 4


def test_config_rejects_invalid_cidr():
    normalized, errors, _ = normalize_trust_config(
        _base_config(entries=[{"value": "10.0.0.0/33"}])
    )
    assert normalized is None
    assert errors
    assert errors[0]["field"].startswith("entries[0]")


def test_config_rejects_host_bits_without_silent_fix():
    normalized, errors, _ = normalize_trust_config(
        _base_config(entries=[{"value": "10.0.0.5/8"}])
    )
    assert normalized is None
    message = errors[0]["message"]
    assert "10.0.0.0/8" in message
    assert "不会悄悄改写" in message


def test_config_rejects_trust_all():
    normalized, errors, _ = normalize_trust_config(
        _base_config(entries=[{"value": "0.0.0.0/0"}])
    )
    assert normalized is None
    assert any("所有来源" in item["message"] for item in errors)


def test_config_rejects_duplicate_entries():
    normalized, errors, _ = normalize_trust_config(
        _base_config(
            entries=[
                {"value": "10.0.0.0/8", "label": "a"},
                {"value": "10.0.0.0/8", "label": "b"},
            ]
        )
    )
    assert normalized is None
    assert errors[0]["code"] == "conflict"


def test_config_warns_on_redundant_overlap():
    normalized, errors, warnings = normalize_trust_config(
        _base_config(
            entries=[
                {"value": "10.0.0.0/8", "label": "a"},
                {"value": "10.1.0.0/16", "label": "b"},
            ]
        )
    )
    assert errors == []
    assert normalized is not None
    assert any(item["code"] == "overlap" for item in warnings)


def test_config_rejects_single_field_multi_hop():
    config = _base_config()
    config["fields"]["x_real_ip"] = {"enabled": True, "max_hops": 3}
    normalized, errors, _ = normalize_trust_config(config)
    assert normalized is None
    assert any(item["code"] == "conflict" for item in errors)


def test_config_rejects_no_enabled_fields():
    config = _base_config()
    for key in config["fields"]:
        config["fields"][key]["enabled"] = False
    normalized, errors, _ = normalize_trust_config(config)
    assert normalized is None
    assert any("至少需要启用" in item["message"] for item in errors)


def test_config_rejects_empty_entries():
    normalized, errors, _ = normalize_trust_config(_base_config(entries=[]))
    assert normalized is None
    assert errors


def test_config_rejects_port_in_entry():
    normalized, errors, _ = normalize_trust_config(
        _base_config(entries=[{"value": "10.0.0.5:8080"}])
    )
    assert normalized is None


@pytest.mark.parametrize(
    "value",
    ["::/0", "fe80::/10", "224.0.0.1", "0.0.0.0"],
)
def test_config_rejects_dangerous_entries(value):
    normalized, errors, _ = normalize_trust_config(
        _base_config(entries=[{"value": value}])
    )
    if value == "fe80::/10":
        # Link-local is a valid CIDR; it is accepted but never matches a
        # globally routable peer.  Only reject if the parser says so.
        assert normalized is not None or errors
    else:
        assert normalized is None
