"""CSP 策略文本解析器。

解析遵循 CSP3 (https://www.w3.org/TR/CSP3/) 的词法规则，但本工具是教学/审计
用途的独立实现，不会连接网络。设计原则：

* 任何无法确定含义的写法都返回带位置（行、列、片段）的问题说明，绝不静默丢弃；
* 解析返回 errors 与 warnings 两类问题：
  - error：该策略整体不被接受，不允许当作空策略入库（见 README「规则范围」）；
  - warning：策略可入库，但对应写法不参与放行判断或含义有限，界面会逐条说明；
* 位置以 1 起始的行号、列号给出，同时给出问题片段，方便定位。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

# 本工具会真正参与资源放行判断的指令（fetch 类 source-list 指令）
FETCH_DIRECTIVES = (
    "default-src",
    "script-src",
    "script-src-elem",
    "script-src-attr",
    "style-src",
    "style-src-elem",
    "style-src-attr",
    "img-src",
    "font-src",
    "media-src",
    "child-src",
    "frame-src",
    "connect-src",
    "worker-src",
    "manifest-src",
    "object-src",
)

# 识别但本工具不参与资源判定的标准指令（给出说明，不报错）
RECOGNIZED_NONFETCH_DIRECTIVES = (
    "base-uri",
    "form-action",
    "frame-ancestors",
    "navigate-to",
    "report-to",
    "report-uri",
    "sandbox",
    "require-trusted-types-for",
    "trusted-types",
    "upgrade-insecure-requests",
    "block-all-mixed-content",
)

KEYWORD_SOURCES = {
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'",
    "'unsafe-hashes'",
    "'none'",
    "'strict-dynamic'",
    "'wasm-unsafe-eval'",
}

HASH_ALGORITHMS = ("sha256", "sha384", "sha512", "sha1")
_BASE64_RE = re.compile(r"^[A-Za-z0-9+/]+=*$")
_SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:$")
# 主机源：可选 scheme:// + 可选 userinfo@ + 主机 + 可选端口 + 可选路径
_HOST_FULL_RE = re.compile(
    r"^"
    r"(?:(?P<scheme>[a-zA-Z][a-zA-Z0-9+.\-]*)://)?"
    r"(?:(?P<userinfo>[^/@?\s#]+)@)?"
    r"(?P<host>\*|(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9.\-]*[A-Za-z0-9])?)"
    r"(?::(?P<port>\*|\d{1,5}))?"
    r"(?P<path>/[^?#\s]*)?$"
)


@dataclass
class ParseIssue:
    """一条解析问题。level 为 'error' 或 'warning'。"""

    level: str
    code: str
    message: str
    line: int
    column: int
    snippet: str

    def to_dict(self) -> dict:
        return {
            "level": self.level,
            "code": self.code,
            "message": self.message,
            "line": self.line,
            "column": self.column,
            "snippet": self.snippet,
        }


@dataclass
class SourceExpression:
    """一条来源表达式（source expression）。

    kind:
      keyword / none / nonce / hash / scheme / host / unknown
    """

    raw: str
    kind: str
    line: int
    column: int
    # 结构化字段（不同 kind 使用不同子集）
    keyword: Optional[str] = None
    nonce_value: Optional[str] = None
    hash_algorithm: Optional[str] = None
    hash_value: Optional[str] = None
    scheme: Optional[str] = None
    host: Optional[str] = None
    port: Optional[str] = None  # None=未指定端口；'*'=任意端口；数字字符串
    path: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "raw": self.raw,
            "kind": self.kind,
            "line": self.line,
            "column": self.column,
            "keyword": self.keyword,
            "nonce_value": self.nonce_value,
            "hash_algorithm": self.hash_algorithm,
            "hash_value": self.hash_value,
            "scheme": self.scheme,
            "host": self.host,
            "port": self.port,
            "path": self.path,
        }


@dataclass
class Directive:
    name: str
    line: int
    column: int
    sources: list[SourceExpression] = field(default_factory=list)
    tokens: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "line": self.line,
            "column": self.column,
            "sources": [s.to_dict() for s in self.sources],
            "tokens": list(self.tokens),
        }


@dataclass
class ParsedPolicy:
    text: str
    directives: list[Directive] = field(default_factory=list)
    errors: list[ParseIssue] = field(default_factory=list)
    warnings: list[ParseIssue] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def get_directive(self, name: str) -> Optional[Directive]:
        for d in self.directives:
            if d.name == name:
                return d
        return None

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "directives": [d.to_dict() for d in self.directives],
            "errors": [i.to_dict() for i in self.errors],
            "warnings": [i.to_dict() for i in self.warnings],
            "ok": self.ok,
        }


def _line_col(text: str, offset: int) -> tuple[int, int]:
    """把字符偏移量换算成 1 起始的 (行, 列)。"""
    line = text.count("\n", 0, offset) + 1
    last_nl = text.rfind("\n", 0, offset)
    column = offset - last_nl  # last_nl == -1 时 column == offset+1
    return line, column


def _split_segments(text: str) -> list[tuple[int, str]]:
    """按分号切分，返回每段 (起始偏移, 段文本)，保留空段以定位错误。"""
    segments: list[tuple[int, str]] = []
    start = 0
    for i, ch in enumerate(text):
        if ch == ";":
            segments.append((start, text[start:i]))
            start = i + 1
    segments.append((start, text[start:]))
    return segments


def _tokenize(segment: str, base_offset: int) -> list[tuple[int, str]]:
    """按空白切词，返回 (全局偏移, token)。"""
    tokens: list[tuple[int, str]] = []
    i = 0
    n = len(segment)
    while i < n:
        while i < n and segment[i].isspace():
            i += 1
        if i >= n:
            break
        j = i
        while j < n and not segment[j].isspace():
            j += 1
        tokens.append((base_offset + i, segment[i:j]))
        i = j
    return tokens


def _parse_source(token: str, line: int, column: int) -> tuple[SourceExpression, list[ParseIssue]]:
    """解析单个来源表达式，返回 (表达式, 该表达式自身的问题列表)。"""
    issues: list[ParseIssue] = []
    expr = SourceExpression(raw=token, kind="unknown", line=line, column=column)

    # 1) 带引号的写法
    if token.startswith("'"):
        if not token.endswith("'") or len(token) < 2:
            issues.append(
                ParseIssue(
                    "error",
                    "UNCLOSED_QUOTE",
                    f"来源表达式 {token!r} 的引号未闭合，带引号的关键字/随机标记/摘要必须以单引号结尾",
                    line,
                    column,
                    token,
                )
            )
            return expr, issues

        lowered = token.lower()
        if lowered in KEYWORD_SOURCES:
            expr.kind = "none" if lowered == "'none'" else "keyword"
            expr.keyword = lowered
            return expr, issues

        if lowered.startswith("'nonce-"):
            value = token[7:-1]
            if not value:
                issues.append(
                    ParseIssue(
                        "error",
                        "EMPTY_NONCE",
                        "随机标记 'nonce-' 后不能为空，应写为 'nonce-<base64值>'",
                        line,
                        column,
                        token,
                    )
                )
                return expr, issues
            if not _BASE64_RE.match(value):
                issues.append(
                    ParseIssue(
                        "error",
                        "BAD_NONCE",
                        f"随机标记 {token!r} 的值不是合法 base64 字符（仅允许 A-Z a-z 0-9 + / 与结尾的 =）",
                        line,
                        column,
                        token,
                    )
                )
                return expr, issues
            expr.kind = "nonce"
            expr.nonce_value = value
            return expr, issues

        m = re.match(r"^'(sha1|sha256|sha384|sha512)-(.+)'$", token, re.IGNORECASE)
        if m:
            algo = m.group(1).lower()
            value = m.group(2)
            if not _BASE64_RE.match(value):
                issues.append(
                    ParseIssue(
                        "error",
                        "BAD_HASH",
                        f"内容摘要 {token!r} 的值不是合法 base64 字符",
                        line,
                        column,
                        token,
                    )
                )
                return expr, issues
            expr.kind = "hash"
            expr.hash_algorithm = algo
            expr.hash_value = value
            return expr, issues

        # 形如 'sha256-' 但值缺失，或算法不支持
        m2 = re.match(r"^'([a-zA-Z0-9]+)-.*'$", token)
        if m2 and m2.group(1).lower() in HASH_ALGORITHMS:
            issues.append(
                ParseIssue(
                    "error",
                    "EMPTY_HASH",
                    f"内容摘要 {token!r} 缺少摘要值，应写为 '{m2.group(1).lower()}-<base64摘要>'",
                    line,
                    column,
                    token,
                )
            )
            return expr, issues
        if m2:
            issues.append(
                ParseIssue(
                    "error",
                    "UNSUPPORTED_HASH_ALGO",
                    f"内容摘要算法 {m2.group(1)!r} 不在支持范围（sha1/sha256/sha384/sha512）",
                    line,
                    column,
                    token,
                )
            )
            return expr, issues

        issues.append(
            ParseIssue(
                "warning",
                "UNKNOWN_QUOTED_KEYWORD",
                f"带引号写法 {token!r} 不是可识别的关键字/随机标记/摘要，"
                "本工具不会按更宽松的规则猜测，该表达式不参与任何放行判断",
                line,
                column,
                token,
            )
        )
        return expr, issues

    # 2) scheme-source，例如 https:  data:  blob:
    if _SCHEME_RE.match(token):
        expr.kind = "scheme"
        expr.scheme = token[:-1].lower()
        return expr, issues

    # 3) host-source（含通配符、端口、路径）
    m = _HOST_FULL_RE.match(token)
    if m and _looks_like_host(token):
        gd = m.groupdict()
        # 正则只做形状约束，这里再做字符级校验：主机只允许字母数字、点、连字符，
        # 且 * 只能单独出现或作为前导 "*."；防止 'bad@@' 之类被误当主机源
        host = gd["host"]
        host_ok = host == "*" or (
            host.startswith("*.")
            and re.match(r"^[A-Za-z0-9]([A-Za-z0-9.\-]*[A-Za-z0-9])?$", host[2:])
        ) or re.match(r"^[A-Za-z0-9]([A-Za-z0-9.\-]*[A-Za-z0-9])?$", host)
        if not host_ok:
            issues.append(
                ParseIssue(
                    "error",
                    "BAD_HOST",
                    f"主机 {host!r} 非法：主机名只允许字母、数字、点与连字符，"
                    "通配符 * 只能单独使用或作为前导 *.",
                    line,
                    column,
                    token,
                )
            )
            return expr, issues
        if gd["port"] is not None and gd["port"] != "*":
            port_num = int(gd["port"])
            if port_num == 0 or port_num > 65535:
                issues.append(
                    ParseIssue(
                        "error",
                        "BAD_PORT",
                        f"端口 {gd['port']} 超出合法范围（1-65535，或使用 * 表示任意端口）",
                        line,
                        column,
                        token,
                    )
                )
                return expr, issues
        if gd["userinfo"] is not None:
            issues.append(
                ParseIssue(
                    "warning",
                    "USERINFO_IGNORED",
                    f"来源 {token!r} 包含用户信息（userinfo@），CSP 匹配不使用该部分，本工具将其忽略",
                    line,
                    column,
                    token,
                )
            )
        expr.kind = "host"
        expr.scheme = gd["scheme"].lower() if gd["scheme"] else None
        expr.host = gd["host"].lower()
        expr.port = gd["port"]  # None / '*' / 数字
        expr.path = gd["path"]
        return expr, issues

    # 4) 无法识别
    issues.append(
        ParseIssue(
            "error",
            "BAD_SOURCE",
            f"无法识别的来源表达式 {token!r}：合法写法包括 'self'、'none'、'nonce-…'、"
            "'sha256-…'、scheme（如 https:）或主机源（如 https://example.com:443/path）",
            line,
            column,
            token,
        )
    )
    return expr, issues


def _looks_like_host(token: str) -> bool:
    """进一步约束主机源：排除明显不是主机的 token（如裸路径、带查询串）。"""
    if "?" in token or "#" in token:
        return False
    if token.startswith("/") or token.startswith("."):
        return False
    # 必须包含点、通配符、端口或路径，否则视为裸词（非法），避免把任意单词当主机
    if not any(ch in token for ch in (".", "*", ":", "/")):
        return False
    return True


def parse_policy(text: str) -> ParsedPolicy:
    """解析整段策略文本。

    即使出现 error 也会继续解析后续指令，以便一次返回全部问题；
    调用方必须先检查 ``parsed.ok``，error 存在时不得把结果当空策略使用。
    """
    if not isinstance(text, str):
        raise TypeError("policy text must be str")
    parsed = ParsedPolicy(text=text)
    seen_directives: dict[str, Directive] = {}

    for seg_index, (seg_offset, segment) in enumerate(_split_segments(text)):
        tokens = _tokenize(segment, seg_offset)
        if not tokens:
            # 末尾的空段（策略以分号结尾）合法；中间空段是错误
            is_last = seg_index == len(_split_segments(text)) - 1
            if is_last and not segment.strip():
                continue
            line, column = _line_col(text, seg_offset)
            parsed.errors.append(
                ParseIssue(
                    "error",
                    "EMPTY_DIRECTIVE",
                    "连续分号之间存在空指令，每条指令必须至少包含指令名",
                    line,
                    column,
                    segment.strip(),
                )
            )
            continue

        name_offset, name_token = tokens[0]
        name_line, name_col = _line_col(text, name_offset)
        directive_name = name_token.lower()

        if not re.match(r"^[a-zA-Z][a-zA-Z0-9\-]*$", directive_name):
            parsed.errors.append(
                ParseIssue(
                    "error",
                    "BAD_DIRECTIVE_NAME",
                    f"指令名 {name_token!r} 非法：只能包含字母、数字与连字符，例如 default-src",
                    name_line,
                    name_col,
                    name_token,
                )
            )
            continue

        directive = Directive(name=directive_name, line=name_line, column=name_col)
        directive.tokens = [t for _, t in tokens[1:]]

        known_fetch = directive_name in FETCH_DIRECTIVES
        known_nonfetch = directive_name in RECOGNIZED_NONFETCH_DIRECTIVES
        if not known_fetch and not known_nonfetch:
            parsed.warnings.append(
                ParseIssue(
                    "warning",
                    "UNKNOWN_DIRECTIVE",
                    f"指令 {directive_name!r} 不是本工具认识的标准 CSP 指令，"
                    "其内容不会参与任何资源放行判断（不按更宽松规则猜测）",
                    name_line,
                    name_col,
                    directive_name,
                )
            )

        # 重复指令：CSP 规定用户代理忽略重复项，但审计场景应明确报错而不是静默忽略
        if directive_name in seen_directives:
            prev = seen_directives[directive_name]
            parsed.errors.append(
                ParseIssue(
                    "error",
                    "DUPLICATE_DIRECTIVE",
                    f"指令 {directive_name!r} 重复出现（首次位于第 {prev.line} 行第 {prev.column} 列）；"
                    "浏览器会忽略重复指令，本工具要求合并后再录入以避免歧义",
                    name_line,
                    name_col,
                    directive_name,
                )
            )

        # 非 fetch 指令的专门说明
        if known_nonfetch:
            parsed.warnings.append(_nonfetch_warning(directive_name, name_line, name_col))

        # 解析来源表达式
        for token_offset, token in tokens[1:]:
            t_line, t_col = _line_col(text, token_offset)
            expr, expr_issues = _parse_source(token, t_line, t_col)
            for issue in expr_issues:
                if issue.level == "error":
                    parsed.errors.append(issue)
                else:
                    parsed.warnings.append(issue)
            directive.sources.append(expr)

        # fetch 指令的额外语义校验
        if known_fetch:
            _validate_fetch_directive(directive, parsed)

        parsed.directives.append(directive)
        seen_directives.setdefault(directive_name, directive)

    # 完全没有任何指令（空文本/纯空白）：明确提示该策略不施加任何限制，
    # 避免用户误以为自己录入了一条有效策略
    if not parsed.directives and not parsed.errors:
        parsed.warnings.append(
            ParseIssue(
                "warning",
                "EMPTY_POLICY",
                "策略文本为空或不含任何指令，等同于不限制任何资源；"
                "若意图为全部禁止，请显式写 default-src 'none'",
                1,
                1,
                text.strip()[:32],
            )
        )

    # 'none' 与其他来源共存：CSP 规定 'none' 应被忽略
    for directive in parsed.directives:
        if directive.name not in FETCH_DIRECTIVES:
            continue
        raws = [s.raw.lower() for s in directive.sources]
        if "'none'" in raws and len(raws) > 1:
            none_src = next(s for s in directive.sources if s.raw.lower() == "'none'")
            parsed.warnings.append(
                ParseIssue(
                    "warning",
                    "NONE_IGNORED",
                    f"{directive.name} 同时包含 'none' 与其他来源，按 CSP 规则 'none' 会被忽略",
                    none_src.line,
                    none_src.column,
                    "'none'",
                )
            )

    return parsed


def _validate_fetch_directive(directive: Directive, parsed: ParsedPolicy) -> None:
    has_nonce = any(s.kind == "nonce" for s in directive.sources)
    has_hash = any(s.kind == "hash" for s in directive.sources)
    has_unsafe_inline = any(s.keyword == "'unsafe-inline'" for s in directive.sources)
    has_strict_dynamic = any(s.keyword == "'strict-dynamic'" for s in directive.sources)

    if not directive.sources:
        parsed.warnings.append(
            ParseIssue(
                "warning",
                "EMPTY_SOURCE_LIST",
                f"{directive.name} 没有任何来源表达式，等同于不允许任何资源；"
                "若意图为显式禁止，请写 {name} 'none'".format(name=directive.name),
                directive.line,
                directive.column,
                directive.name,
            )
        )

    if has_unsafe_inline and (has_nonce or has_hash):
        ui = next(s for s in directive.sources if s.keyword == "'unsafe-inline'")
        parsed.warnings.append(
            ParseIssue(
                "warning",
                "UNSAFE_INLINE_IGNORED",
                f"{directive.name} 同时含随机标记/摘要与 'unsafe-inline'，"
                "按 CSP 规则 'unsafe-inline' 会被忽略，仅随机标记/摘要生效",
                ui.line,
                ui.column,
                "'unsafe-inline'",
            )
        )

    if has_strict_dynamic and directive.name not in (
        "script-src",
        "script-src-elem",
        "script-src-attr",
        "default-src",
    ):
        sd = next(s for s in directive.sources if s.keyword == "'strict-dynamic'")
        parsed.warnings.append(
            ParseIssue(
                "warning",
                "STRICT_DYNAMIC_SCOPE",
                f"'strict-dynamic' 只对脚本类指令有意义，放在 {directive.name} 中不产生作用",
                sd.line,
                sd.column,
                "'strict-dynamic'",
            )
        )

    if has_strict_dynamic:
        for s in directive.sources:
            if s.kind in ("host", "scheme") or s.keyword == "'self'":
                parsed.warnings.append(
                    ParseIssue(
                        "warning",
                        "HOST_IGNORED_WITH_STRICT_DYNAMIC",
                        f"{directive.name} 含 'strict-dynamic' 时，主机/协议来源（如 {s.raw!r}）"
                        "对脚本加载失效，只有随机标记、摘要与受信任脚本传播的信任有效",
                        s.line,
                        s.column,
                        s.raw,
                    )
                )


def _nonfetch_warning(name: str, line: int, column: int) -> ParseIssue:
    messages = {
        "base-uri": "base-uri 限制 <base> 标签，本工具不模拟页面标签行为，该指令不参与资源判定",
        "form-action": "form-action 限制表单提交跳转，本工具仅判断资源加载，该指令不参与判定",
        "frame-ancestors": "frame-ancestors 限制当前页面被谁嵌入，本工具只判断页面发起的资源请求，该指令不参与判定",
        "navigate-to": "navigate-to 在多数浏览器中尚未实现，本工具不支持，该指令不参与判定",
        "report-to": "report-to 用于向浏览器声明违规上报端点，本工具完全离线、不发送任何请求，该指令不参与判定",
        "report-uri": "report-uri 是已废弃的上报指令，本工具完全离线、不发送任何请求，该指令不参与判定",
        "sandbox": "sandbox 控制页面沙箱能力而非资源来源，本工具不模拟沙箱，该指令不参与判定",
        "require-trusted-types-for": "require-trusted-types-for 属于 Trusted Types 规则，本工具不模拟 DOM 注入，该指令不参与判定",
        "trusted-types": "trusted-types 属于 Trusted Types 规则，本工具不模拟 DOM 注入，该指令不参与判定",
        "upgrade-insecure-requests": "upgrade-insecure-requests 让浏览器升级 http 为 https，本工具不自动改写请求地址，该指令不参与判定",
        "block-all-mixed-content": "block-all-mixed-content 阻止混合内容，本工具不按该指令自动升级或拦截，请在请求中直接给出最终地址",
    }
    return ParseIssue(
        "warning",
        "NONFETCH_DIRECTIVE",
        messages.get(name, f"{name} 不参与本工具的资源放行判断"),
        line,
        column,
        name,
    )
