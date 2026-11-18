"""敏感内容遮蔽。

所有从被核查文件中读出的文本，在进入任何发现项、日志、导出之前都必须经过
本模块处理。原则：
- 只保留键名/规则名，绝不保留令牌原文；
- 提供脱敏后的展示文本（值固定替换为 ``[REDACTED]``）；
- 提供仅由值本身哈希得到的指纹，用于在不泄露内容的前提下判断值是否变化；
- 命中记录只写行号，不写原文。

样例中的虚构口令（含 ``EXAMPLE-FAKE`` 标记）同样会被遮蔽——遮蔽逻辑不依赖
凭据真假，保证真实环境里也不会因为"看起来像假的"而泄露。
"""

from __future__ import annotations

import hashlib
import re

REDACTION = "[REDACTED]"

# 形如 password = secret / token: abc / api_key="xyz" 的赋值
_ASSIGN_RE = re.compile(
    r"""(?ix)
    ^
    (?P<prefix>
        (?:export\s+)?
        [\w.\-]*
        (?:pass(?:word|wd)?|passphrase|secret|token|api[_-]?key|
           access[_-]?key|private[_-]?key|auth(?:orization)?|credential|
           client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key)
        [\w.\-]*
    )
    (?P<sep>\s*[:=]\s*)
    (?P<quote>["']?)
    (?P<value>[^"'\s#;]+)
    """,
)
# URL 内嵌凭据：scheme://user:pass@host
_URL_CRED_RE = re.compile(
    r"(?P<scheme>[a-zA-Z][a-zA-Z0-9+.\-]*://) (?P<user>[^:/@\s]+) : (?P<pw>[^@\s]+) @",
    re.VERBOSE,
)
_PEM_RE = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
    re.DOTALL,
)
_AUTH_HEADER_RE = re.compile(
    r"(?i)(authorization\s*[:=]\s*)(?:bearer|basic|token)\s+[A-Za-z0-9._\-+/=]+"
)
# AWS 风格访问密钥（AKIA…）作为兜底
_AWS_KEY_RE = re.compile(r"\bAKIA[0-9A-Z]{16}\b")


def value_fingerprint(value: str) -> str:
    """对敏感值取短哈希，用于判断"值是否变化"，不泄露值本身。"""
    return "sha256:" + hashlib.sha256(value.encode("utf-8", "replace")).hexdigest()[:16]


def scan_line(line: str) -> list[dict]:
    """扫描一行文本，返回命中描述（不含任何原文敏感值）。"""
    hits: list[dict] = []
    stripped = line.strip()

    m = _ASSIGN_RE.match(stripped)
    if m and m.group("value"):
        hits.append(
            {
                "kind": "secret_assignment",
                "key": m.group("prefix").strip(),
                "value_fingerprint": value_fingerprint(m.group("value")),
            }
        )

    m = _URL_CRED_RE.search(line)
    if m:
        hits.append(
            {
                "kind": "url_credentials",
                "key": m.group("scheme") + m.group("user") + ":***@",
                "value_fingerprint": value_fingerprint(m.group("pw")),
            }
        )

    if _PEM_RE.search(line):
        block = _PEM_RE.search(line)
        hits.append(
            {
                "kind": "private_key_pem",
                "key": "PEM private key block",
                "value_fingerprint": value_fingerprint(block.group(0)),
            }
        )

    if _AUTH_HEADER_RE.search(line):
        hits.append(
            {
                "kind": "auth_header",
                "key": "Authorization header",
                "value_fingerprint": value_fingerprint(line),
            }
        )

    if _AWS_KEY_RE.search(line):
        key = _AWS_KEY_RE.search(line).group(0)
        hits.append(
            {
                "kind": "aws_access_key_id",
                "key": "AWS access key id",
                "value_fingerprint": value_fingerprint(key),
            }
        )

    return hits


def redact_line(line: str) -> str:
    """返回遮蔽后的行文本（保留键名与结构，值替换为 [REDACTED]）。"""
    result: str = line

    m = _ASSIGN_RE.match(result.strip())
    if m and m.group("value"):
        result = (
            m.group("prefix")
            + m.group("sep")
            + (m.group("quote") or "")
            + REDACTION
            + (m.group("quote") if m.group("quote") else "")
        )
        return result

    result = _URL_CRED_RE.sub(lambda mm: mm.group("scheme") + mm.group("user") + ":" + REDACTION + "@", result)
    result = _PEM_RE.sub(REDACTION + " (private key block)", result)
    result = _AUTH_HEADER_RE.sub(lambda mm: mm.group(1) + "Bearer " + REDACTION, result)
    result = _AWS_KEY_RE.sub(REDACTION, result)
    return result


def redact_mapping(data: dict) -> dict:
    """遮蔽键值结构中的敏感值（解析后的配置字典在记录前统一过一遍）。"""
    safe: dict = {}
    for key, value in data.items():
        key_s = str(key)
        if scan_line(key_s + " = " + str(value)):
            safe[key_s] = REDACTION
        elif isinstance(value, dict):
            safe[key_s] = redact_mapping(value)
        else:
            safe[key_s] = value
    return safe


# 自由文本（例外理由、日志细节）的兜底：长且高熵的疑似令牌
_LOOSE_TOKEN_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._\-]{11,}[A-Za-z0-9]")


def _looks_like_secret_token(token: str) -> bool:
    letters = sum(c.isalpha() for c in token)
    digits = sum(c.isdigit() for c in token)
    if letters == 0 or digits == 0:
        return False  # 纯单词或纯数字不处理，避免误伤自然语言
    return len(set(token)) >= 8  # 字符种类足够多才视为高熵令牌


def scrub_free_text(text: str) -> str:
    """对自由文本做兜底遮蔽：捕获没有键名上下文的独立疑似令牌。"""
    def replace(match):
        token = match.group(0)
        return REDACTION if _looks_like_secret_token(token) else token

    return _LOOSE_TOKEN_RE.sub(replace, str(text))


def safe_path_for_log(path: str) -> str:
    """写入日志前去掉绝对路径，只保留末段名称。"""
    cleaned = path.replace("\\", "/").rstrip("/")
    return cleaned.rsplit("/", 1)[-1] or "/"
