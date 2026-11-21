"""End-to-end behaviour tests for the trust-chain evaluator."""

from __future__ import annotations

import pytest

from app.analyzer import analyze
from app.config import normalize_trust_config
from app.demos import DEMOS
from app.headers import normalize_headers


def config(
    entries=("10.0.0.0/8", "192.0.2.0/24"),
    *,
    xff=True,
    forwarded=False,
    x_real_ip=False,
    cf=False,
    xff_hops=5,
    forwarded_hops=5,
):
    return normalize_trust_config(
        {
            "name": "测试配置",
            "entries": [{"value": value, "label": None} for value in entries],
            "fields": {
                "x_forwarded_for": {"enabled": xff, "max_hops": xff_hops},
                "forwarded": {
                    "enabled": forwarded,
                    "max_hops": forwarded_hops,
                },
                "x_real_ip": {"enabled": x_real_ip, "max_hops": 1},
                "cf_connecting_ip": {"enabled": cf, "max_hops": 1},
            },
        }
    )[0]


def run(peer, headers, **kwargs):
    headers, errors = normalize_headers(headers)
    assert errors == []
    return analyze(peer, headers, config(**kwargs))


def test_trusted_chain():
    result = run(
        "10.0.0.5",
        {"x_forwarded_for": "203.0.113.42, 192.0.2.10, 10.0.0.5"},
    )
    assert result["verdict"]["status"] == "determined"
    assert result["verdict"]["outcome"] == "trusted_chain"
    assert result["verdict"]["final_client"] == "203.0.113.42"
    hops = result["fields"][0]["hops"]
    assert [hop["decision"] for hop in hops] == ["client", "proxy", "proxy"]
    assert [hop["decision_label"] for hop in hops] == [
        "采用为客户端",
        "可信代理",
        "可信代理",
    ]


def test_untrusted_peer_ignores_spoofed_headers():
    result = run(
        "198.51.100.77",
        {
            "x_forwarded_for": "10.0.0.5, 127.0.0.1",
            "x_real_ip": "10.1.2.3",
        },
        x_real_ip=True,
    )
    assert result["verdict"]["outcome"] == "untrusted_peer"
    assert result["verdict"]["final_client"] == "198.51.100.77"
    assert all(field["used"] is False for field in result["fields"])
    for field in result["fields"]:
        if field["present"]:
            assert field["status"] == "ignored_untrusted_peer"
            for hop in field["hops"]:
                assert hop["decision"] == "excluded"
    # The internal-looking hop is not marked trusted just because it looks
    # like a private address.
    assert result["peer"]["trusted"] is False


def test_private_peer_is_not_implicitly_trusted():
    result = run("10.1.2.3", {"x_forwarded_for": "203.0.113.1"}, entries=["192.0.2.0/24"])
    assert result["verdict"]["outcome"] == "untrusted_peer"
    assert result["verdict"]["final_client"] == "10.1.2.3"


def test_internal_looking_hop_is_client_when_not_configured():
    # 10.0.0.5 looks like a private proxy, but only 192.0.2.0/24 is trusted.
    result = run(
        "192.0.2.10",
        {"x_forwarded_for": "10.0.0.5, 192.0.2.10"},
        entries=["192.0.2.0/24"],
    )
    assert result["verdict"]["outcome"] == "trusted_chain"
    assert result["verdict"]["final_client"] == "10.0.0.5"
    hops = result["fields"][0]["hops"]
    assert hops[0]["trust"] == "untrusted"
    assert hops[0]["decision"] == "client"


def test_direct_peer_without_headers():
    result = run("10.0.0.5", {})
    assert result["verdict"]["outcome"] == "direct_peer"
    assert result["verdict"]["final_client"] == "10.0.0.5"


def test_disabled_field_only():
    result = run("10.0.0.5", {"forwarded": "for=203.0.113.1"})
    assert result["verdict"]["outcome"] == "forwarding_disabled"
    assert result["verdict"]["final_client"] == "10.0.0.5"


def test_ipv4_ipv6_mixed():
    result = run(
        "[2001:db8:1::10]:8080",
        {
            "x_forwarded_for": (
                "2001:db9:abcd::7, [2001:db8::1]:443, ::ffff:192.0.2.10"
            )
        },
        entries=("2001:db8:1::/48", "2001:db8::1/128", "192.0.2.10"),
        xff_hops=6,
    )
    assert result["verdict"]["outcome"] == "trusted_chain"
    assert result["verdict"]["final_client"] == "2001:db9:abcd::7"
    hops = result["fields"][0]["hops"]
    assert hops[1]["address"] == "2001:db8::1"
    assert hops[1]["port"] == 443
    assert hops[2]["address"] == "192.0.2.10"
    mapped = hops[2]
    assert mapped["note"]


def test_field_order_conflict_undetermined():
    result = run(
        "10.0.0.5",
        {
            "x_forwarded_for": "203.0.113.42, 192.0.2.10, 10.0.0.5",
            "forwarded": "for=10.0.0.5, for=192.0.2.10, for=203.0.113.42",
        },
        forwarded=True,
    )
    assert result["verdict"]["status"] == "undetermined"
    assert result["verdict"]["outcome"] == "order_conflict"
    assert result["verdict"]["final_client"] is None
    assert result["cross_check"]["status"] == "order_conflict"
    assert all(field["used"] is False for field in result["fields"])


def test_two_fields_consistent():
    result = run(
        "10.0.0.5",
        {
            "x_forwarded_for": "203.0.113.42, 192.0.2.10",
            "forwarded": 'for="203.0.113.42";proto=https, for=192.0.2.10',
        },
        forwarded=True,
    )
    assert result["verdict"]["outcome"] == "trusted_chain"
    assert result["verdict"]["final_client"] == "203.0.113.42"
    assert result["cross_check"]["status"] == "consistent"


def test_field_mismatch_undetermined():
    result = run(
        "10.0.0.5",
        {
            "x_forwarded_for": "203.0.113.42, 192.0.2.10",
            "forwarded": "for=203.0.113.42, for=198.51.100.7",
        },
        forwarded=True,
    )
    assert result["verdict"]["status"] == "undetermined"
    assert result["verdict"]["outcome"] == "field_conflict"
    assert result["verdict"]["final_client"] is None


def test_duplicate_list_field_undetermined():
    result = run(
        "10.0.0.5",
        {"x_forwarded_for": ["203.0.113.42, 192.0.2.10", "198.51.100.9"]},
    )
    assert result["verdict"]["status"] == "undetermined"
    assert result["verdict"]["outcome"] == "duplicate_field"
    assert result["fields"][0]["duplicate_field"] is True


def test_malformed_hop_undetermined():
    result = run(
        "10.0.0.5", {"x_forwarded_for": "203.0.113.42, , unknown, 999.1.1.1"}
    )
    assert result["verdict"]["status"] == "undetermined"
    assert result["verdict"]["outcome"] == "malformed_hop"
    hops = result["fields"][0]["hops"]
    assert [hop["kind"] for hop in hops] == [
        "address",
        "empty",
        "unknown",
        "malformed",
    ]
    assert all(hop["decision"] == "excluded" for hop in hops)


def test_incomplete_chain():
    result = run("10.0.0.5", {"x_forwarded_for": "192.0.2.10, 10.0.0.5"})
    assert result["verdict"]["status"] == "undetermined"
    assert result["verdict"]["outcome"] == "chain_incomplete"


def test_hop_limit_exceeded():
    result = run(
        "10.0.0.5",
        {"x_forwarded_for": "203.0.113.42, 192.0.2.10, 198.51.100.20"},
        entries=("10.0.0.0/8", "192.0.2.0/24", "198.51.100.0/24"),
        xff_hops=2,
    )
    assert result["verdict"]["status"] == "undetermined"
    assert result["verdict"]["outcome"] == "hop_limit_exceeded"


def test_duplicate_hop_in_chain():
    result = run(
        "10.0.0.5",
        {"x_forwarded_for": "203.0.113.42, 192.0.2.10, 192.0.2.10"},
    )
    assert result["verdict"]["status"] == "undetermined"
    assert result["verdict"]["outcome"] == "duplicate_hop"


def test_single_field_mismatch_with_chain():
    result = run(
        "10.0.0.5",
        {
            "x_forwarded_for": "203.0.113.42, 192.0.2.10",
            "x_real_ip": "198.51.100.99",
        },
        x_real_ip=True,
    )
    assert result["verdict"]["status"] == "undetermined"
    assert result["verdict"]["outcome"] == "single_conflict"


def test_single_field_consistent_with_chain():
    result = run(
        "10.0.0.5",
        {
            "x_forwarded_for": "203.0.113.42, 192.0.2.10",
            "x_real_ip": "203.0.113.42",
        },
        x_real_ip=True,
    )
    assert result["verdict"]["outcome"] == "trusted_chain"
    assert result["verdict"]["final_client"] == "203.0.113.42"
    assert result["cross_check"]["status"] == "consistent"


def test_invalid_peer():
    result = run("not-an-ip", {"x_forwarded_for": "203.0.113.42"})
    assert result["verdict"]["status"] == "undetermined"
    assert result["verdict"]["outcome"] == "peer_invalid"
    assert result["verdict"]["final_client"] is None


def test_every_demo_matches_its_expectation():
    for demo in DEMOS:
        headers, errors = normalize_headers(demo["headers"])
        assert errors == [], demo["slug"]
        normalized, config_errors, _ = normalize_trust_config(demo["config"])
        assert config_errors == [], demo["slug"]
        result = analyze(demo["peer"], headers, normalized)
        expectation = demo["expectation"]
        assert result["verdict"]["status"] == expectation["status"], demo["slug"]
        assert result["verdict"]["outcome"] == expectation["outcome"], demo["slug"]
        assert (
            result["verdict"]["final_client"] == expectation["final_client"]
        ), demo["slug"]
        assert (
            result["verdict"]["outcome_label"] == expectation["outcome_label"]
        ), demo["slug"]


@pytest.mark.parametrize(
    "peer",
    [
        "203.0.113.42",
        "[2001:db8::1]:443",
        "::ffff:192.0.2.10",
        "2001:db8::1",
    ],
)
def test_peer_formats(peer):
    result = run(peer, {})
    assert result["verdict"]["status"] in {"determined", "undetermined"}
    assert result["peer"]["kind"] == "address"
