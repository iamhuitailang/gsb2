"""Role rule sets.

Each organisation is pinned to one rule set.  A rule set is a small,
versioned policy document; its canonical digest is written into every audit
record so a reader can tell exactly which rules governed a change.
"""

from __future__ import annotations

from typing import Any

from .canonical import canonical_json, sha256_hex

RULE_SETS: dict[str, dict[str, Any]] = {
    "rbac-cn-2026.1": {
        "version": "2026.1",
        "description": "标准角色规则：两名角色上限，组织管理员角色受保护",
        "allowed_roles": ["viewer", "operator", "auditor", "org_admin"],
        "protected_roles": ["org_admin"],
        "max_roles_per_subject": 2,
        "allow_self_change": False,
    },
    "rbac-cn-2026.2": {
        "version": "2026.2",
        "description": "扩展角色规则：三名角色上限，含计费角色且受保护",
        "allowed_roles": ["viewer", "operator", "auditor", "org_admin", "billing"],
        "protected_roles": ["org_admin", "billing"],
        "max_roles_per_subject": 3,
        "allow_self_change": False,
    },
}


def get_rule_set(name: str) -> dict[str, Any]:
    try:
        return RULE_SETS[name]
    except KeyError as exc:
        raise KeyError(f"unknown rule set: {name}") from exc


def rule_set_digest(name: str) -> str:
    return sha256_hex(canonical_json(get_rule_set(name)).encode("utf-8"))


def rule_summary(name: str) -> dict[str, Any]:
    rules = get_rule_set(name)
    return {
        "name": name,
        "version": rules["version"],
        "digest": rule_set_digest(name),
        "allowed_roles": list(rules["allowed_roles"]),
        "protected_roles": list(rules["protected_roles"]),
        "max_roles_per_subject": rules["max_roles_per_subject"],
    }
