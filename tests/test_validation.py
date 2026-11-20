"""策略包结构/语义校验测试。"""

from __future__ import annotations

import copy
import json

import pytest

from app.models import (
    diff_documents,
    digest_of,
    validate_document,
)
from app.samples import read_sample


def baseline() -> dict:
    return json.loads(read_sample("01-valid-baseline.json")["text"])


def changed() -> dict:
    return json.loads(read_sample("02-valid-changed.json")["text"])


def codes(result) -> set[str]:
    return {issue.code for issue in result.issues}


def errors(result) -> list:
    return [issue for issue in result.issues if issue.severity == "error"]


def warning_codes(result) -> set[str]:
    return {issue.code for issue in result.issues if issue.severity == "warning"}


# ------------------------------------------------------------ 正常样例


def test_baseline_is_valid_and_deterministic() -> None:
    first = validate_document(baseline())
    second = validate_document(copy.deepcopy(baseline()))
    assert first.ok
    assert first.digest == second.digest
    assert first.normalized is not None
    assert [r["id"] for r in first.normalized["rules"]] == [
        "allow-dns",
        "allow-https-egress",
        "deny-admin-from-office",
    ]


def test_all_valid_samples_pass() -> None:
    for name in ("01-valid-baseline.json", "02-valid-changed.json"):
        result = validate_document(json.loads(read_sample(name)["text"]))
        assert result.ok, (name, [i.as_dict() for i in result.issues])


def test_all_reject_samples_fail_with_expected_code() -> None:
    expectations = {
        "11-reject-unknown-field.json": "unknown_field",
        "12-reject-type-mismatch.json": "type_mismatch",
        "13-reject-conflict.json": "conflicting_rules",
        "14-reject-unsupported-version.json": "unsupported_schema_version",
        "17-reject-semantic.json": "invalid_cidr",
    }
    for name, expected in expectations.items():
        result = validate_document(json.loads(read_sample(name)["text"]))
        assert not result.ok, name
        assert expected in codes(result), (name, codes(result))


def test_conflict_sample_reports_both_duplicate_id_and_conflict() -> None:
    result = validate_document(json.loads(read_sample("13-reject-conflict.json")["text"]))
    assert "duplicate_rule_id" in codes(result)
    assert "conflicting_rules" in codes(result)


def test_semantic_sample_reports_all_three_problems() -> None:
    result = validate_document(json.loads(read_sample("17-reject-semantic.json")["text"]))
    assert {"invalid_cidr", "invalid_port_range", "port_out_of_range", "icmp_with_ports"} <= codes(result)
    paths = {issue.path for issue in result.issues}
    assert "$.rules[0].source_cidrs[0]" in paths
    assert "$.rules[1].destination_ports[0]" in paths


# ------------------------------------------------------------ 结构校验


def test_unknown_top_level_field_rejected() -> None:
    doc = baseline()
    doc["meta"] = {"owner": "x"}
    result = validate_document(doc)
    assert not result.ok
    assert "unknown_field" in codes(result)
    assert any(i.path == "$.meta" for i in result.issues)


def test_unknown_rule_field_rejected() -> None:
    doc = baseline()
    doc["rules"][0]["log_level"] = "debug"
    result = validate_document(doc)
    assert not result.ok
    assert any(
        i.code == "unknown_field" and i.path == "$.rules[0].log_level"
        for i in result.issues
    )


@pytest.mark.parametrize(
    "mutate, expected_path",
    [
        (lambda d: d["rules"][0].__setitem__("priority", "10"), "$.rules[0].priority"),
        (lambda d: d["rules"][0].__setitem__("enabled", "true"), "$.rules[0].enabled"),
        (lambda d: d["rules"][0].__setitem__("protocols", "tcp"), "$.rules[0].protocols"),
        (lambda d: d["rules"][0].__setitem__("source_cidrs", "10.0.0.0/8"), "$.rules[0].source_cidrs"),
        (lambda d: d["rules"][0].__setitem__("name", 42), "$.rules[0].name"),
        (lambda d: d["package"].__setitem__("revision", "1"), "$.package.revision"),
    ],
)
def test_type_mismatches_are_rejected(mutate, expected_path) -> None:
    doc = baseline()
    mutate(doc)
    result = validate_document(doc)
    assert not result.ok
    assert any(i.code == "type_mismatch" and i.path == expected_path for i in result.issues)


def test_missing_required_field_rejected() -> None:
    doc = baseline()
    del doc["rules"][0]["action"]
    result = validate_document(doc)
    assert not result.ok
    assert any(
        i.code == "missing_field" and i.path == "$.rules[0].action"
        for i in result.issues
    )


def test_bool_is_not_accepted_as_int() -> None:
    doc = baseline()
    doc["rules"][0]["priority"] = True
    result = validate_document(doc)
    assert not result.ok
    assert "type_mismatch" in codes(result)


def test_unsupported_schema_version_is_located() -> None:
    doc = baseline()
    doc["schema_version"] = "9.9"
    result = validate_document(doc)
    assert not result.ok
    issue = next(i for i in result.issues if i.code == "unsupported_schema_version")
    assert issue.path == "$.schema_version"


def test_unsupported_action_and_direction() -> None:
    doc = baseline()
    doc["rules"][0]["action"] = "drop"
    doc["rules"][1]["direction"] = "sideways"
    result = validate_document(doc)
    assert not result.ok
    assert "unsupported_action" in codes(result)
    assert "unsupported_direction" in codes(result)


def test_empty_rules_rejected() -> None:
    doc = baseline()
    doc["rules"] = []
    result = validate_document(doc)
    assert not result.ok
    assert "empty_rules" in codes(result)


def test_too_many_rules_rejected() -> None:
    doc = baseline()
    rule = copy.deepcopy(doc["rules"][0])
    doc["rules"] = []
    for index in range(201):
        new_rule = copy.deepcopy(rule)
        new_rule["id"] = f"rule-{index:04d}"
        new_rule["priority"] = index + 1
        doc["rules"].append(new_rule)
    result = validate_document(doc)
    assert not result.ok
    assert "too_many_rules" in codes(result)


def test_too_many_cidrs_rejected() -> None:
    doc = baseline()
    doc["rules"][0]["source_cidrs"] = [
        f"10.{i}.0.0/16" for i in range(65)
    ]
    result = validate_document(doc)
    assert not result.ok
    assert "invalid_list_size" in codes(result)


# ------------------------------------------------------------ 语义校验


def test_duplicate_rule_id_points_to_conflict() -> None:
    doc = baseline()
    doc["rules"][1]["id"] = doc["rules"][0]["id"]
    result = validate_document(doc)
    assert not result.ok
    issue = next(i for i in result.issues if i.code == "duplicate_rule_id")
    assert issue.path == "$.rules[1].id"
    assert "$.rules[0]" in issue.message


def test_conflicting_actions_same_priority_rejected() -> None:
    doc = baseline()
    doc["rules"].append(
        {
            "id": "deny-dns",
            "name": "拒绝 DNS",
            "priority": 10,
            "action": "deny",
            "direction": "outbound",
            "protocols": ["udp"],
            "source_cidrs": ["10.20.9.0/24"],
            "destination_cidrs": ["10.20.0.53/32"],
            "destination_ports": [53],
        }
    )
    result = validate_document(doc)
    assert not result.ok
    issue = next(i for i in result.issues if i.code == "conflicting_rules")
    assert issue.path == "$.rules[3]"
    assert issue.rule_id == "deny-dns"


def test_same_priority_different_scope_is_allowed() -> None:
    doc = baseline()
    doc["rules"].append(
        {
            "id": "allow-alt",
            "name": "另一个范围",
            "priority": 10,
            "action": "deny",
            "direction": "outbound",
            "protocols": ["tcp"],
            "source_cidrs": ["10.99.0.0/24"],
            "destination_cidrs": ["10.99.0.1/32"],
            "destination_ports": ["8080"],
        }
    )
    result = validate_document(doc)
    assert result.ok, [i.as_dict() for i in result.issues]


def test_overlapping_cidr_is_warning_not_error() -> None:
    doc = baseline()
    doc["rules"][0]["source_cidrs"] = ["10.20.0.0/16", "10.20.4.0/24"]
    result = validate_document(doc)
    assert result.ok
    assert "overlapping_cidr" in warning_codes(result)


def test_redundant_rule_is_warning() -> None:
    doc = baseline()
    clone = copy.deepcopy(doc["rules"][0])
    clone["id"] = "allow-dns-clone"
    clone["priority"] = 11
    doc["rules"].append(clone)
    result = validate_document(doc)
    assert result.ok
    assert "redundant_rule" in warning_codes(result)


def test_duplicate_cidr_rejected() -> None:
    doc = baseline()
    doc["rules"][0]["source_cidrs"] = ["10.20.0.0/16", "10.20.0.0/16"]
    result = validate_document(doc)
    assert not result.ok
    assert "duplicate_cidr" in codes(result)


def test_duplicate_protocol_rejected() -> None:
    doc = baseline()
    doc["rules"][0]["protocols"] = ["tcp", "tcp"]
    result = validate_document(doc)
    assert not result.ok
    assert "duplicate_protocol" in codes(result)


def test_overlapping_port_ranges_rejected() -> None:
    doc = baseline()
    doc["rules"][1]["destination_ports"] = ["443", "400-443"]
    result = validate_document(doc)
    assert not result.ok
    assert "overlapping_port_range" in codes(result)


def test_adjacent_non_overlapping_port_ranges_allowed() -> None:
    doc = baseline()
    doc["rules"][1]["destination_ports"] = ["443", "444-500"]
    result = validate_document(doc)
    assert result.ok, [i.as_dict() for i in result.issues]


def test_cidr_with_host_bits_rejected() -> None:
    doc = baseline()
    doc["rules"][0]["source_cidrs"] = ["10.20.0.7/24"]
    result = validate_document(doc)
    assert not result.ok
    assert "invalid_cidr" in codes(result)
    assert any("主机位" in i.message for i in result.issues)


def test_port_range_reversed_rejected() -> None:
    doc = baseline()
    doc["rules"][0]["destination_ports"] = ["9000-8000"]
    result = validate_document(doc)
    assert not result.ok
    assert "invalid_port_range" in codes(result)


def test_icmp_with_ports_rejected() -> None:
    doc = baseline()
    doc["rules"][0]["protocols"] = ["icmp"]
    doc["rules"][0]["destination_ports"] = [53]
    result = validate_document(doc)
    assert not result.ok
    assert "icmp_with_ports" in codes(result)
    assert "ports_without_transport" not in codes(result)


def test_empty_cidr_list_rejected_instead_of_meaning_any() -> None:
    doc = baseline()
    doc["rules"][0]["source_cidrs"] = []
    result = validate_document(doc)
    assert not result.ok
    assert "empty_cidr_list" in codes(result)
    assert any("0.0.0.0/0" in i.message for i in result.issues)


def test_shadowed_rule_warns_when_conditions_identical() -> None:
    doc = baseline()
    clone = copy.deepcopy(doc["rules"][0])
    clone["id"] = "deny-dns-shadow"
    clone["action"] = "deny"
    clone["priority"] = 99
    doc["rules"].append(clone)
    result = validate_document(doc)
    assert result.ok
    assert "shadowed_rule" in warning_codes(result)
    issue = next(i for i in result.issues if i.code == "shadowed_rule")
    assert issue.rule_id == "deny-dns-shadow"
    assert "永远不会命中" in issue.message


def test_empty_rule_id_rejected() -> None:
    doc = baseline()
    doc["rules"][0]["id"] = ""
    result = validate_document(doc)
    assert not result.ok
    assert {"empty_value", "value_too_short"} & codes(result)


def test_ipv6_cidr_supported() -> None:
    doc = baseline()
    doc["rules"][0]["source_cidrs"] = ["fd00::/48"]
    result = validate_document(doc)
    assert result.ok


# ------------------------------------------------------------ 规范化与差异


def test_normalization_reorders_and_stabilizes_digest() -> None:
    a = baseline()
    b = baseline()
    b["rules"].reverse()
    for rule in b["rules"]:
        rule["protocols"] = list(reversed(rule["protocols"]))
    result_a = validate_document(a)
    result_b = validate_document(b)
    assert result_a.ok and result_b.ok
    assert result_a.digest == result_b.digest
    assert result_a.normalized == result_b.normalized


def test_digest_changes_when_semantics_change() -> None:
    a = validate_document(baseline())
    doc = baseline()
    doc["rules"][0]["priority"] = 999
    b = validate_document(doc)
    assert a.digest != b.digest


def test_diff_reports_add_remove_modify() -> None:
    before = validate_document(baseline()).normalized
    after = validate_document(changed()).normalized
    diff = diff_documents(before, after)
    assert [item["id"] for item in diff["added"]] == ["allow-ops-ssh"]
    assert [item["id"] for item in diff["removed"]] == ["deny-admin-from-office"]
    assert [item["id"] for item in diff["modified"]] == ["allow-https-egress"]
    modified = diff["modified"][0]["changes"]
    assert "destination_cidrs" in modified
    assert modified["destination_cidrs"]["before"] == ["10.20.1.0/24"]
    assert diff["package"]["revision"] == {"before": 1, "after": 2}


def test_diff_with_no_active_version() -> None:
    after = validate_document(baseline()).normalized
    diff = diff_documents(None, after)
    assert diff["summary"]["added"] == 3
    assert diff["summary"]["removed"] == 0
    assert diff["summary"]["has_changes"] is True


def test_digest_ignores_key_order_in_source() -> None:
    first = digest_of(validate_document(baseline()).normalized)
    doc = baseline()
    reordered = dict(reversed(list(doc.items())))
    second = digest_of(validate_document(reordered).normalized)
    assert first == second
