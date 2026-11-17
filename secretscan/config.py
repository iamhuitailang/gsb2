"""扫描配置: 默认值、TOML 解析与字段校验。

配置文件示例见 README 与 examples/secretscan.toml。任何字段缺失
或取值非法都会抛出 ConfigError, 由 CLI 转换为退出码 2。
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field

from .errors import ConfigError
from .rules import EntropyRule, Rule, build_builtin_rules, build_custom_rules

# 默认跳过的版本控制目录名 (匹配路径中的任意一段)。
DEFAULT_VCS_DIRS = [".git", ".hg", ".svn", ".bzr", "_darcs", ".jj"]

# 按扩展名识别的明显二进制文件。
DEFAULT_BINARY_EXTENSIONS = [
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
    ".zip", ".gz", ".tar", ".bz2", ".xz", ".7z", ".rar",
    ".jar", ".war", ".class", ".pyc", ".pyo",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav", ".flv",
    ".so", ".dll", ".dylib", ".a", ".o", ".bin", ".wasm",
    ".ttf", ".otf", ".woff", ".woff2", ".eot",
    ".sqlite", ".sqlite3", ".db",
]

# 默认单文件大小上限: 1 MiB。
DEFAULT_MAX_FILE_BYTES = 1024 * 1024


@dataclass
class EntropyConfig:
    enabled: bool = True
    min_length: int = 20
    max_length: int = 256
    min_entropy: float = 4.0
    min_char_classes: int = 2
    max_digit_ratio: float = 0.6

    def build_rule(self) -> EntropyRule | None:
        if not self.enabled:
            return None
        return EntropyRule(
            min_length=self.min_length,
            max_length=self.max_length,
            min_entropy=self.min_entropy,
            min_char_classes=self.min_char_classes,
            max_digit_ratio=self.max_digit_ratio,
        )


@dataclass
class Config:
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES
    skip_vcs_dirs: list[str] = field(default_factory=lambda: list(DEFAULT_VCS_DIRS))
    binary_extensions: list[str] = field(
        default_factory=lambda: list(DEFAULT_BINARY_EXTENSIONS)
    )
    enable_builtin_rules: bool = True
    entropy: EntropyConfig = field(default_factory=EntropyConfig)
    custom_rule_specs: list[dict] = field(default_factory=list)

    def build_rules(self) -> list[Rule]:
        rules: list[Rule] = []
        entropy_rule = self.entropy.build_rule()
        if self.enable_builtin_rules:
            rules.extend(build_builtin_rules(entropy_rule))
        elif entropy_rule is not None:
            # 关闭内置格式规则时, 熵检测仍可单独启用。
            rules.append(entropy_rule)
        rules.extend(build_custom_rules(self.custom_rule_specs))
        if not rules:
            raise ConfigError("当前配置下没有任何启用的规则, 扫描无意义")
        return rules


def _require_type(table: dict, key: str, expected: type, section: str) -> object:
    value = table.get(key)
    if not isinstance(value, expected):
        kind = expected.__name__
        raise ConfigError(f"配置段 [{section}] 的 {key!r} 必须是 {kind}")
    return value


def _parse_entropy(table: dict) -> EntropyConfig:
    cfg = EntropyConfig()
    if not table:
        return cfg
    cfg.enabled = bool(_require_type(table, "enabled", bool, "entropy"))
    cfg.min_length = int(_require_type(table, "min_length", int, "entropy"))
    cfg.max_length = int(_require_type(table, "max_length", int, "entropy"))
    cfg.min_entropy = float(
        _require_type(table, "min_entropy", (int, float), "entropy")
    )
    cfg.min_char_classes = int(
        _require_type(table, "min_char_classes", int, "entropy")
    )
    cfg.max_digit_ratio = float(
        _require_type(table, "max_digit_ratio", (int, float), "entropy")
    )
    if cfg.min_length < 4 or cfg.max_length < cfg.min_length:
        raise ConfigError("entropy 长度区间非法, 要求 4 <= min_length <= max_length")
    if not 0.0 <= cfg.min_entropy <= 8.0:
        raise ConfigError("entropy.min_entropy 应落在 [0, 8]")
    if not 1 <= cfg.min_char_classes <= 4:
        raise ConfigError("entropy.min_char_classes 应落在 [1, 4]")
    if not 0.0 <= cfg.max_digit_ratio <= 1.0:
        raise ConfigError("entropy.max_digit_ratio 应落在 [0, 1]")
    return cfg


def load_config(path: str | None) -> Config:
    """读取并校验 TOML 配置; path 为 None 时返回全默认配置。"""

    if path is None:
        return Config()
    try:
        with open(path, "rb") as handle:
            raw = tomllib.load(handle)
    except FileNotFoundError as exc:
        raise ConfigError(f"配置文件不存在: {path}") from exc
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"配置文件不是合法 TOML: {exc}") from exc
    except OSError as exc:
        raise ConfigError(f"配置文件无法读取: {exc}") from exc

    cfg = Config()
    if "max_file_bytes" in raw:
        value = raw["max_file_bytes"]
        if not isinstance(value, int) or value <= 0:
            raise ConfigError("max_file_bytes 必须是正整数")
        cfg.max_file_bytes = value
    if "skip_vcs_dirs" in raw:
        value = raw["skip_vcs_dirs"]
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            raise ConfigError("skip_vcs_dirs 必须是字符串数组")
        cfg.skip_vcs_dirs = value
    if "binary_extensions" in raw:
        value = raw["binary_extensions"]
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            raise ConfigError("binary_extensions 必须是字符串数组")
        cfg.binary_extensions = [
            item if item.startswith(".") else f".{item}" for item in value
        ]
    if "enable_builtin_rules" in raw:
        if not isinstance(raw["enable_builtin_rules"], bool):
            raise ConfigError("enable_builtin_rules 必须是布尔值")
        cfg.enable_builtin_rules = raw["enable_builtin_rules"]
    if "entropy" in raw:
        if not isinstance(raw["entropy"], dict):
            raise ConfigError("[entropy] 段必须是表")
        cfg.entropy = _parse_entropy(raw["entropy"])
    if "rules" in raw:
        rules_table = raw["rules"]
        if not isinstance(rules_table, dict) or not isinstance(
            rules_table.get("custom", []), list
        ):
            raise ConfigError("[rules] 段下 custom 必须是表数组 [[rules.custom]]")
        cfg.custom_rule_specs = rules_table.get("custom", [])
    # 提前构造一次规则, 让自定义规则的正则/字段错误在扫描前暴露。
    cfg.build_rules()
    return cfg
