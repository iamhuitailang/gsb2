"""Rule loading, validation, versioning and path scoping.

A rule is a declarative regular-expression detector.  Two independent version
concepts are maintained:

* the *rule version* changes whenever any part of the rule changes.  It is
  reported in scan output so the exact detection logic can be identified.
* the *semantic hash* only changes when the meaning of a rule changes
  (family, pattern, capture, entropy, allow-list, explicit semantic version).
  Renaming a rule or changing its displayed severity does not invalidate a
  reviewer's decision.
"""

from __future__ import annotations

import fnmatch
import json
import math
import os
import re
import tempfile
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence

from .utils import canonical_json, sha256_hex

SEVERITIES = ("low", "medium", "high", "critical")
SEVERITY_WEIGHT = {"low": 1, "medium": 2, "high": 3, "critical": 4}
KINDS = ("line", "pem_block")

_ALLOWED_RULE_FIELDS = {
    "id",
    "family",
    "name",
    "description",
    "kind",
    "pattern",
    "flags",
    "secret_group",
    "end_pattern",
    "severity",
    "enabled",
    "priority",
    "semantic_version",
    "min_entropy",
    "min_length",
    "max_matches_per_line",
    "max_block_lines",
    "allowlist",
    "path_include",
    "path_exclude",
}

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")
_FAMILY_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,127}$")
_FLAG_MAP = {"i": re.IGNORECASE, "m": re.MULTILINE, "s": re.DOTALL, "x": re.VERBOSE, "a": re.ASCII}


class RuleConfigError(ValueError):
    """Raised when a rule configuration is invalid."""


def shannon_entropy(value: str) -> float:
    if not value:
        return 0.0
    counts: Dict[str, int] = {}
    for char in value:
        counts[char] = counts.get(char, 0) + 1
    length = float(len(value))
    entropy = 0.0
    for count in counts.values():
        probability = count / length
        entropy -= probability * math.log2(probability)
    return entropy


@dataclass
class Rule:
    id: str
    family: str
    name: str
    description: str
    severity: str
    pattern: str
    kind: str = "line"
    flags: str = ""
    secret_group: Any = 0
    end_pattern: Optional[str] = None
    enabled: bool = True
    priority: int = 0
    semantic_version: str = "1"
    min_entropy: float = 0.0
    min_length: int = 0
    max_matches_per_line: int = 10
    max_block_lines: int = 300
    allowlist: List[str] = field(default_factory=list)
    path_include: List[str] = field(default_factory=list)
    path_exclude: List[str] = field(default_factory=list)
    regex: re.Pattern = field(init=False, repr=False)
    end_regex: Optional[re.Pattern] = field(init=False, repr=False, default=None)
    allowlist_regex: List[re.Pattern] = field(init=False, repr=False, default_factory=list)
    version: str = field(init=False, default="")
    semantic_hash: str = field(init=False, default="")

    def __post_init__(self) -> None:
        compile_flags = 0
        for flag in self.flags:
            if flag not in _FLAG_MAP:
                raise RuleConfigError("规则 %s 的 flags 含未知标记 %r" % (self.id, flag))
            compile_flags |= _FLAG_MAP[flag]
        try:
            self.regex = re.compile(self.pattern, compile_flags)
        except re.error as exc:
            raise RuleConfigError("规则 %s 的正则无效：%s" % (self.id, exc)) from None
        if self.kind == "pem_block":
            if not self.end_pattern:
                raise RuleConfigError("规则 %s 为 pem_block，但缺少 end_pattern" % self.id)
            try:
                self.end_regex = re.compile(self.end_pattern, compile_flags)
            except re.error as exc:
                raise RuleConfigError("规则 %s 的 end_pattern 无效：%s" % (self.id, exc)) from None
        if isinstance(self.secret_group, str):
            if self.secret_group not in self.regex.groupindex:
                raise RuleConfigError(
                    "规则 %s 指定了不存在的命名捕获组 %s" % (self.id, self.secret_group)
                )
        elif isinstance(self.secret_group, int):
            if self.secret_group > self.regex.groups:
                raise RuleConfigError("规则 %s 的 secret_group 超出捕获组数量" % self.id)
        else:
            raise RuleConfigError("规则 %s 的 secret_group 必须是组名或序号" % self.id)
        try:
            self.allowlist_regex = [re.compile(item) for item in self.allowlist]
        except re.error as exc:
            raise RuleConfigError("规则 %s 的 allowlist 正则无效：%s" % (self.id, exc)) from None
        self.version = self._compute_version()
        self.semantic_hash = self._compute_semantic_hash()

    def _config_dict(self) -> Dict[str, Any]:
        data: Dict[str, Any] = {
            "id": self.id,
            "family": self.family,
            "name": self.name,
            "description": self.description,
            "kind": self.kind,
            "pattern": self.pattern,
            "flags": self.flags,
            "secret_group": self.secret_group,
            "severity": self.severity,
            "enabled": self.enabled,
            "priority": self.priority,
            "semantic_version": self.semantic_version,
            "min_entropy": self.min_entropy,
            "min_length": self.min_length,
            "max_matches_per_line": self.max_matches_per_line,
            "max_block_lines": self.max_block_lines,
            "allowlist": list(self.allowlist),
            "path_include": list(self.path_include),
            "path_exclude": list(self.path_exclude),
        }
        if self.end_pattern is not None:
            data["end_pattern"] = self.end_pattern
        return data

    def _compute_version(self) -> str:
        return sha256_hex(canonical_json(self._config_dict()))[:16]

    def _compute_semantic_hash(self) -> str:
        """Fields that define what this rule *means*.

        Renames, description edits, severity changes and priority changes are
        cosmetic/operational and do not invalidate reviews.  A changed pattern,
        capture group, entropy floor, allow-list or explicit semantic version
        does.
        """
        semantic = {
            "family": self.family,
            "kind": self.kind,
            "pattern": self.pattern,
            "flags": self.flags,
            "secret_group": self.secret_group,
            "end_pattern": self.end_pattern,
            "min_entropy": self.min_entropy,
            "min_length": self.min_length,
            "allowlist": sorted(self.allowlist),
            "semantic_version": self.semantic_version,
        }
        return sha256_hex(canonical_json(semantic))[:16]

    def path_allowed(self, rel_path: str) -> bool:
        normalised = rel_path.replace(os.sep, "/")
        basename = normalised.rsplit("/", 1)[-1]

        def matches(pattern: str) -> bool:
            # A pattern without a slash matches the file name only, so `*.env`
            # behaves the way people expect for nested files.
            if "/" not in pattern:
                return fnmatch.fnmatchcase(basename, pattern)
            return fnmatch.fnmatchcase(normalised, pattern)

        if self.path_include and not any(matches(pattern) for pattern in self.path_include):
            return False
        if any(matches(pattern) for pattern in self.path_exclude):
            return False
        return True

    def secret_usable(self, value: str) -> bool:
        if not value or len(value) < self.min_length:
            return False
        if self.min_entropy and shannon_entropy(value) < self.min_entropy:
            return False
        for allow in self.allowlist_regex:
            if allow.search(value):
                return False
        return True

    def public_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "family": self.family,
            "name": self.name,
            "description": self.description,
            "severity": self.severity,
            "enabled": self.enabled,
            "version": self.version,
            "semantic_version": self.semantic_version,
            "semantic_hash": self.semantic_hash,
            "kind": self.kind,
            "priority": self.priority,
        }


@dataclass
class RuleSet:
    rules: List[Rule]
    source_path: str
    raw: Dict[str, Any]
    version: str

    @property
    def enabled_rules(self) -> List[Rule]:
        return [rule for rule in self.rules if rule.enabled]

    @property
    def ordered_rules(self) -> List[Rule]:
        return sorted(
            self.enabled_rules,
            key=lambda rule: (-rule.priority, -SEVERITY_WEIGHT.get(rule.severity, 0), rule.id),
        )

    def by_id(self) -> Dict[str, Rule]:
        return {rule.id: rule for rule in self.rules}

    def by_family(self) -> Dict[str, Rule]:
        return {rule.family: rule for rule in self.rules}

    def active_families(self) -> set:
        return {rule.family for rule in self.enabled_rules}

    def snapshot(self) -> Dict[str, Any]:
        return {
            "version": self.version,
            "source_path": self.source_path,
            "rules": [rule.public_dict() for rule in self.rules],
        }


def _coerce_str_list(value: Any, field_name: str, rule_id: str) -> List[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise RuleConfigError("规则 %s 的 %s 必须是字符串数组" % (rule_id, field_name))
    return list(value)


def _parse_rule(data: Any) -> Rule:
    if not isinstance(data, dict):
        raise RuleConfigError("每条规则必须是 JSON 对象")
    unknown = set(data) - _ALLOWED_RULE_FIELDS
    if unknown:
        raise RuleConfigError("规则含未知字段：%s" % ", ".join(sorted(unknown)))
    rule_id = data.get("id")
    if not isinstance(rule_id, str) or not _ID_RE.match(rule_id):
        raise RuleConfigError("规则 id 无效：%r" % (rule_id,))
    family = data.get("family")
    if not isinstance(family, str) or not _FAMILY_RE.match(family):
        raise RuleConfigError("规则 %s 的 family 无效：%r" % (rule_id, family))
    name = data.get("name")
    if not isinstance(name, str) or not name.strip():
        raise RuleConfigError("规则 %s 缺少 name" % rule_id)
    description = data.get("description", "")
    if not isinstance(description, str):
        raise RuleConfigError("规则 %s 的 description 必须是字符串" % rule_id)
    severity = data.get("severity")
    if severity not in SEVERITIES:
        raise RuleConfigError("规则 %s 的 severity 必须是 %s" % (rule_id, "/".join(SEVERITIES)))
    kind = data.get("kind", "line")
    if kind not in KINDS:
        raise RuleConfigError("规则 %s 的 kind 必须是 line 或 pem_block" % rule_id)
    pattern = data.get("pattern")
    if not isinstance(pattern, str) or not pattern:
        raise RuleConfigError("规则 %s 缺少 pattern" % rule_id)
    if len(pattern) > 1000:
        raise RuleConfigError("规则 %s 的 pattern 过长（上限 1000 字符）" % rule_id)
    flags = data.get("flags", "")
    if not isinstance(flags, str) or len(flags) > 8:
        raise RuleConfigError("规则 %s 的 flags 无效" % rule_id)
    secret_group = data.get("secret_group", 0)
    if not isinstance(secret_group, (str, int)) or isinstance(secret_group, bool):
        raise RuleConfigError("规则 %s 的 secret_group 必须是组名或序号" % rule_id)
    end_pattern = data.get("end_pattern")
    if end_pattern is not None and not isinstance(end_pattern, str):
        raise RuleConfigError("规则 %s 的 end_pattern 必须是字符串" % rule_id)
    enabled = data.get("enabled", True)
    if not isinstance(enabled, bool):
        raise RuleConfigError("规则 %s 的 enabled 必须是布尔值" % rule_id)
    try:
        priority = int(data.get("priority", 0))
        min_entropy = float(data.get("min_entropy", 0.0))
        min_length = int(data.get("min_length", 0))
        max_matches = int(data.get("max_matches_per_line", 10))
        max_block = int(data.get("max_block_lines", 300))
    except (TypeError, ValueError):
        raise RuleConfigError("规则 %s 的数值字段无效" % rule_id) from None
    if not (0 <= priority <= 100000):
        raise RuleConfigError("规则 %s 的 priority 超出范围" % rule_id)
    if not (0.0 <= min_entropy <= 8.0):
        raise RuleConfigError("规则 %s 的 min_entropy 超出范围" % rule_id)
    if not (0 <= min_length <= 4096):
        raise RuleConfigError("规则 %s 的 min_length 超出范围" % rule_id)
    if not (1 <= max_matches <= 1000):
        raise RuleConfigError("规则 %s 的 max_matches_per_line 超出范围" % rule_id)
    if not (1 <= max_block <= 100000):
        raise RuleConfigError("规则 %s 的 max_block_lines 超出范围" % rule_id)
    semantic_version = str(data.get("semantic_version", "1"))
    if not semantic_version or len(semantic_version) > 64:
        raise RuleConfigError("规则 %s 的 semantic_version 无效" % rule_id)
    return Rule(
        id=rule_id,
        family=family,
        name=name.strip(),
        description=description.strip(),
        severity=severity,
        pattern=pattern,
        kind=kind,
        flags=flags,
        secret_group=secret_group,
        end_pattern=end_pattern,
        enabled=enabled,
        priority=priority,
        semantic_version=semantic_version,
        min_entropy=min_entropy,
        min_length=min_length,
        max_matches_per_line=max_matches,
        max_block_lines=max_block,
        allowlist=_coerce_str_list(data.get("allowlist"), "allowlist", rule_id),
        path_include=_coerce_str_list(data.get("path_include"), "path_include", rule_id),
        path_exclude=_coerce_str_list(data.get("path_exclude"), "path_exclude", rule_id),
    )


def parse_rules(raw: Any, source_path: str = "<memory>") -> RuleSet:
    if not isinstance(raw, dict):
        raise RuleConfigError("规则文件必须是 JSON 对象")
    items = raw.get("rules")
    if not isinstance(items, list) or not items:
        raise RuleConfigError("规则文件必须包含非空 rules 数组")
    rules = [_parse_rule(item) for item in items]
    ids = [rule.id for rule in rules]
    duplicates = sorted({item for item in ids if ids.count(item) > 1})
    if duplicates:
        raise RuleConfigError("规则 id 重复：%s" % ", ".join(duplicates))
    families = {}
    for rule in rules:
        families.setdefault(rule.family, []).append(rule.id)
    conflicting = ["%s (%s)" % (family, ", ".join(ids_)) for family, ids_ in families.items() if len(ids_) > 1]
    if conflicting:
        # Family is the stable identity namespace, so two active detectors for the
        # same family would make review inheritance ambiguous.
        raise RuleConfigError("同一 family 只能对应一条规则：%s" % "; ".join(conflicting))
    version = sha256_hex(canonical_json({"rules": [rule._config_dict() for rule in rules]}))[:16]
    return RuleSet(rules=rules, source_path=source_path, raw=raw, version=version)


def load_rules(path: str) -> RuleSet:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except FileNotFoundError:
        raise RuleConfigError("规则文件不存在：%s" % path) from None
    except json.JSONDecodeError as exc:
        raise RuleConfigError("规则文件不是合法 JSON（第 %s 行）" % exc.lineno) from None
    return parse_rules(raw, path)


def validate_rules_text(text: str, source_path: str = "<editor>") -> RuleSet:
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuleConfigError("规则 JSON 解析失败（第 %s 行）" % exc.lineno) from None
    return parse_rules(raw, source_path)


def save_rules_text(path: str, text: str) -> RuleSet:
    rule_set = validate_rules_text(text, path)
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=".rules-", suffix=".json", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            if not text.endswith("\n"):
                handle.write("\n")
        os.replace(temp_path, path)
    except BaseException:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise
    return rule_set


def rule_sort_key(rule: Rule) -> tuple:
    return (-rule.priority, -SEVERITY_WEIGHT.get(rule.severity, 0), rule.id)


def iter_rule_spans(rule: Rule, line: str) -> Iterable[re.Match]:
    return rule.regex.finditer(line)
