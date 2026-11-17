"""检测规则引擎。

包含四类规则, 每条规则都有稳定标识 (rule_id) 和严重级别:

1. 内置正则规则: 常见凭据赋值 (assignment)、知名厂商令牌格式、
   PEM 私钥标记;
2. 高熵规则: 不依赖已知格式, 用长度、香农熵与字符分布信号发现
   疑似随机密钥;
3. 配置文件中声明的自定义正则规则。

同一行上重叠的命中会被去重: 严重级别高者胜, 同级时规则标识
字典序靠前者胜, 保证同一段内容只产生一条告警。
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

from .errors import ConfigError
from .models import SEVERITIES, severity_rank

# ---------------------------------------------------------------------------
# 规则与命中的数据结构
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RawMatch:
    """规则在单行文本上产生的原始命中 (尚未去重)。"""

    start: int  # 相对行首的字符偏移, 0 起始
    end: int
    rule_id: str
    severity: str
    reason: str


class Rule:
    """所有规则的基类。scan_line 返回该行上的原始命中列表。"""

    rule_id: str
    severity: str
    reason: str

    def scan_line(self, line: str) -> list[RawMatch]:  # pragma: no cover - 抽象方法
        raise NotImplementedError


class RegexRule(Rule):
    """基于正则的规则。

    pattern 中若存在名为 ``value`` 的捕获组, 命中区间取该组
    (用于 ``password = "..."`` 这类赋值, 只告警凭据本身);
    否则取整个匹配。
    """

    def __init__(self, rule_id: str, severity: str, pattern: str, reason: str):
        if severity not in SEVERITIES:
            raise ConfigError(f"规则 {rule_id} 的严重级别非法: {severity!r}")
        try:
            self._compiled = re.compile(pattern)
        except re.error as exc:
            raise ConfigError(f"规则 {rule_id} 的正则无法编译: {exc}") from exc
        self.rule_id = rule_id
        self.severity = severity
        self.reason = reason
        self._has_value_group = "value" in (self._compiled.groupindex or {})

    def scan_line(self, line: str) -> list[RawMatch]:
        results: list[RawMatch] = []
        for match in self._compiled.finditer(line):
            if self._has_value_group and match.group("value"):
                start, end = match.span("value")
            else:
                start, end = match.span()
            results.append(
                RawMatch(start, end, self.rule_id, self.severity, self.reason)
            )
        return results


# ---------------------------------------------------------------------------
# 高熵规则
# ---------------------------------------------------------------------------


class EntropyRule(Rule):
    """基于香农熵与字符分布的高熵字符串检测。

    判定一个候选片段需要同时满足:
    - 长度落在 [min_length, max_length];
    - 香农熵 (按字符频率, 单位 bit) 不低于 min_entropy;
    - 同时出现的字符类别数不低于 min_char_classes (默认要求字母
      与数字混合, 抑制普通英文单词);
    - 数字占比不高于 max_digit_ratio (抑制长串数字、时间戳)。
    """

    rule_id = "entropy.high"
    severity = "low"
    reason = "高熵字符串: 长度、字符分布与香农熵符合随机密钥特征"

    def __init__(
        self,
        min_length: int = 20,
        max_length: int = 256,
        min_entropy: float = 4.0,
        min_char_classes: int = 2,
        max_digit_ratio: float = 0.6,
    ):
        self.min_length = min_length
        self.max_length = max_length
        self.min_entropy = min_entropy
        self.min_char_classes = min_char_classes
        self.max_digit_ratio = max_digit_ratio
        # 候选 token: 字母/数字及常见 base64/URL 安全符号组成的连续片段
        self._token_re = re.compile(r"[A-Za-z0-9+/=_\-]{2,}")

    @staticmethod
    def shannon_entropy(text: str) -> float:
        if not text:
            return 0.0
        counts: dict[str, int] = {}
        for char in text:
            counts[char] = counts.get(char, 0) + 1
        length = len(text)
        entropy = 0.0
        for count in counts.values():
            probability = count / length
            entropy -= probability * math.log2(probability)
        return entropy

    @staticmethod
    def _char_classes(text: str) -> int:
        classes = 0
        if re.search(r"[a-z]", text):
            classes += 1
        if re.search(r"[A-Z]", text):
            classes += 1
        if re.search(r"[0-9]", text):
            classes += 1
        if re.search(r"[^A-Za-z0-9]", text):
            classes += 1
        return classes

    def _looks_like_secret(self, token: str) -> bool:
        if not (self.min_length <= len(token) <= self.max_length):
            return False
        if self.shannon_entropy(token) < self.min_entropy:
            return False
        if self._char_classes(token) < self.min_char_classes:
            return False
        digit_ratio = sum(char.isdigit() for char in token) / len(token)
        if digit_ratio > self.max_digit_ratio:
            return False
        return True

    def scan_line(self, line: str) -> list[RawMatch]:
        results: list[RawMatch] = []
        for match in self._token_re.finditer(line):
            token = match.group(0)
            if self._looks_like_secret(token):
                results.append(
                    RawMatch(
                        match.start(),
                        match.end(),
                        self.rule_id,
                        self.severity,
                        self.reason,
                    )
                )
        return results


# ---------------------------------------------------------------------------
# 内置规则定义
# ---------------------------------------------------------------------------

# 赋值类规则共用的左值/右值结构: 支持 NAME=value、NAME: value、
# NAME = "value" 三种常见写法, 右值支持引号包裹。
_ASSIGNMENT_TEMPLATE = r"""(?ix:
    \b(?:{keys})\b
    \s*[:=]\s*
    ["']?(?P<value>[^\s"']+)["']?
)"""

_BUILTIN_REGEX_RULES: tuple[tuple[str, str, str, str], ...] = (
    (
        "credential.assignment",
        "high",
        _ASSIGNMENT_TEMPLATE.format(
            keys="password|passwd|secret|token|api[_-]?key|auth[_-]?token|"
            "access[_-]?key|client[_-]?secret|private[_-]?token"
        ),
        "疑似凭据赋值: 敏感名称的变量被赋予了非空值",
    ),
    (
        "aws.access_key_id",
        "critical",
        r"\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b",
        "匹配 AWS 访问密钥 ID 的已知格式",
    ),
    (
        "github.pat",
        "critical",
        r"\bgh[pousr]_[A-Za-z0-9]{36,255}\b",
        "匹配 GitHub 个人访问令牌的已知格式",
    ),
    (
        "slack.token",
        "high",
        r"\bxox[baprs]-[A-Za-z0-9-]{10,72}\b",
        "匹配 Slack 令牌的已知格式",
    ),
    (
        "google.api_key",
        "high",
        r"\bAIza[0-9A-Za-z_\-]{35}\b",
        "匹配 Google API 密钥的已知格式",
    ),
    (
        "pem.private_key",
        "critical",
        r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----",
        "出现 PEM 私钥块起始标记",
    ),
    (
        "auth.bearer",
        "medium",
        r"(?i:\bBearer\s+)(?P<value>[A-Za-z0-9._\-]{8,})",
        "HTTP Authorization 头中携带 Bearer 令牌",
    ),
)


def build_builtin_rules(entropy: EntropyRule | None) -> list[Rule]:
    rules: list[Rule] = [
        RegexRule(rule_id, severity, pattern, reason)
        for rule_id, severity, pattern, reason in _BUILTIN_REGEX_RULES
    ]
    if entropy is not None:
        rules.append(entropy)
    return rules


def build_custom_rules(specs: list[dict]) -> list[Rule]:
    """从配置文件的 [[rules.custom]] 段构造自定义正则规则。"""

    rules: list[Rule] = []
    for index, spec in enumerate(specs):
        if not isinstance(spec, dict):
            raise ConfigError(f"自定义规则第 {index + 1} 项必须是表 (table)")
        missing = {"id", "pattern", "severity"} - set(spec)
        if missing:
            raise ConfigError(
                f"自定义规则第 {index + 1} 项缺少字段: {', '.join(sorted(missing))}"
            )
        rule_id = str(spec["id"])
        if not re.fullmatch(r"[a-z0-9][a-z0-9_.\-]*", rule_id):
            raise ConfigError(
                f"自定义规则标识 {rule_id!r} 非法: 仅允许小写字母、数字、"
                "点、下划线与连字符"
            )
        rules.append(
            RegexRule(
                rule_id=rule_id,
                severity=str(spec["severity"]),
                pattern=str(spec["pattern"]),
                reason=str(spec.get("reason", "命中用户自定义规则")),
            )
        )
    return rules


# ---------------------------------------------------------------------------
# 同区间去重
# ---------------------------------------------------------------------------


def dedupe_matches(matches: list[RawMatch]) -> list[RawMatch]:
    """对同一行上的原始命中按区间去重。

    完全重叠或包含关系中只保留优先级最高的一条; 互不重叠的命中
    全部保留。优先级: 严重级别高者优先, 同级按规则标识字典序,
    再按起始位置稳定排序。
    """

    if not matches:
        return []
    ordered = sorted(
        matches,
        key=lambda item: (
            -severity_rank(item.severity),
            item.rule_id,
            item.start,
            item.end,
        ),
    )
    kept: list[RawMatch] = []
    for candidate in ordered:
        # 与已保留的高优先级命中发生任何重叠即视为同一段内容, 跳过;
        # 能进入这一步说明候选的优先级不高于任何已保留命中。
        if any(
            candidate.start < existing.end and candidate.end > existing.start
            for existing in kept
        ):
            continue
        kept.append(candidate)
    return sorted(kept, key=lambda item: (item.start, item.end))
