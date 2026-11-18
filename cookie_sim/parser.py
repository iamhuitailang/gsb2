"""Set-Cookie 头解析与合法性校验(RFC 6265 / 6265bis 思路)。

所有拒收都返回明确的中文原因, 不静默丢弃; 不致命的问题以 warning 形式保留。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

from .matching import canonicalize_host, default_path, domain_matches, is_ip_address
from .model import Cookie, SameSite
from .sites import STANDARD_SUFFIXES, parse_url
from .timeutil import now_ts, parse_http_date

_MAX_AGE_RE = re.compile(r"^-?[0-9]+$")
# RFC 7230 token: 名称里禁止出现的分隔符与空白
_NAME_FORBIDDEN = set('()<>@,;:\\"/[]?={} \t')
# 非引号 value 禁止出现的字符
_VALUE_FORBIDDEN = set(' \t";,\\')
_CONTROL = set(chr(c) for c in range(0, 32)) | {"\x7f"}

_BOOLEAN_ATTRS = {"secure", "httponly"}
_VALUE_ATTRS = {"expires", "max-age", "domain", "path", "samesite"}
_KNOWN_ATTRS = _BOOLEAN_ATTRS | _VALUE_ATTRS


@dataclass
class ParseResult:
    cookie: Optional[Cookie] = None
    accepted: bool = False
    reason: str = ""
    warnings: list = field(default_factory=list)


def _valid_name(name: str) -> bool:
    if not name:
        return False
    return not any(ch in _NAME_FORBIDDEN or ch in _CONTROL or ord(ch) > 126 for ch in name)


def _valid_value(value: str) -> bool:
    if value == "":
        return True
    if any(ch in _CONTROL or ord(ch) == 127 for ch in value):
        return False
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        inner = value[1:-1]
        return '"' not in inner and ";" not in inner
    return not any(ch in _VALUE_FORBIDDEN or ord(ch) > 126 for ch in value)


def _reject(reason: str, detail: str = "") -> ParseResult:
    return ParseResult(cookie=None, accepted=False, reason=reason, warnings=[detail] if detail else [])


def parse_set_cookie(raw: str, source_url: str, now: Optional[float] = None) -> ParseResult:
    """解析一条 Set-Cookie 响应头。

    raw: Set-Cookie 的完整文本(不含 "Set-Cookie:" 前缀)
    source_url: 产生该响应头的请求 URL, 用于取主机与默认路径
    """
    if now is None:
        now = now_ts()
    if raw is None or not str(raw).strip():
        return _reject("Set-Cookie 内容为空")
    text = str(raw).strip()
    if any(ch in _CONTROL for ch in text):
        return _reject("包含控制字符, 格式错误")

    try:
        source = parse_url(source_url)
    except ValueError as exc:
        return _reject(f"来源 URL 无法解析: {exc}")
    host = source.host

    segments = text.split(";")
    head = segments[0].strip()
    if "=" not in head:
        return _reject("缺少 name=value 结构, 格式错误", f"首段为 {head!r}")
    name, value = head.split("=", 1)
    name = name.strip()
    value = value.strip()
    if not _valid_name(name):
        return _reject("Cookie 名称包含非法字符或空白", f"名称: {name!r}")
    if not _valid_value(value):
        return _reject("Cookie 值包含非法字符(控制字符/分号/未转义空白等)", f"值: {value!r}")
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        value = value[1:-1]  # 引号只是包裹符, 不进入实际值

    warnings: list = []
    seen: dict = {}

    def record(attr: str, attr_value: Optional[str]) -> Optional[str]:
        """登记属性; 出现冲突时返回错误原因。"""
        key = attr.lower()
        if key not in _KNOWN_ATTRS:
            warnings.append(f"忽略无法识别的属性 {attr!r}")
            return None
        if key in seen:
            if key in _BOOLEAN_ATTRS:
                return None  # 布尔标志重复出现无冲突
            old = seen[key]
            if old == attr_value:
                warnings.append(f"属性 {attr!r} 重复且取值一致, 已合并")
                return None
            return f"属性 {attr!r} 冲突: 同时出现 {old!r} 与 {attr_value!r}"
        seen[key] = attr_value
        return None

    for segment in segments[1:]:
        piece = segment.strip()
        if piece == "":
            continue
        if "=" in piece:
            attr, attr_value = piece.split("=", 1)
            attr, attr_value = attr.strip(), attr_value.strip()
        else:
            attr, attr_value = piece.strip(), None
        if attr == "":
            return _reject("存在空属性名, 格式错误")
        conflict = record(attr, attr_value)
        if conflict:
            return _reject(conflict)

    # ---- 有效期: Max-Age 优先于 Expires ----
    expires: Optional[float] = None
    if "max-age" in seen:
        max_age = seen["max-age"]
        if max_age is None or not _MAX_AGE_RE.match(max_age):
            return _reject("Max-Age 格式错误, 必须是整数秒", f"收到: {max_age!r}")
        expires = now + int(max_age)
        if "expires" in seen:
            warnings.append("同时存在 Max-Age 与 Expires, 按规范采用 Max-Age")
    elif "expires" in seen:
        parsed = parse_http_date(seen["expires"] or "")
        if parsed is None:
            return _reject("Expires 不是合法的 HTTP 日期(需 GMT)", f"收到: {seen['expires']!r}")
        expires = parsed

    # ---- Domain: 区分 host-only 与 Domain 范围 cookie ----
    host_only = True
    domain = host
    if "domain" in seen:
        domain_value = (seen["domain"] or "").strip().lstrip(".").lower()
        if domain_value == "":
            return _reject("Domain 属性为空")
        try:
            domain_value = canonicalize_host(domain_value)
        except ValueError as exc:
            return _reject(f"Domain 不合法: {exc}")
        if is_ip_address(domain_value):
            return _reject("IP 地址不能作为 Domain 属性", f"收到: {domain_value!r}")
        if not domain_matches(domain_value, host):
            return _reject(
                "Domain 与来源主机不在同一域(完整标签边界校验失败)",
                f"来源主机 {host!r} 不属于域 {domain_value!r}",
            )
        if domain_value in STANDARD_SUFFIXES or ("." not in domain_value and domain_value != host):
            return _reject("Domain 是公共后缀或顶级标签, 不能在其上设置 cookie", f"收到: {domain_value!r}")
        domain = domain_value
        host_only = False

    # ---- Path ----
    path = default_path(source.path)
    if "path" in seen:
        raw_path = seen["path"] or ""
        if any(ch in _CONTROL or ch == ";" for ch in raw_path):
            return _reject("Path 包含非法字符", f"收到: {raw_path!r}")
        if raw_path.startswith("/"):
            path = raw_path
        else:
            warnings.append(f"Path {raw_path!r} 不是绝对路径, 已忽略并使用默认路径 {path!r}")

    # ---- 布尔属性 ----
    secure = "secure" in seen
    http_only = "httponly" in seen

    # ---- SameSite ----
    same_site = SameSite.LAX
    if "samesite" in seen:
        ss = (seen["samesite"] or "").strip().lower()
        mapping = {"strict": SameSite.STRICT, "lax": SameSite.LAX, "none": SameSite.NONE}
        if ss not in mapping:
            return _reject("SameSite 取值无法识别(仅允许 Strict/Lax/None)", f"收到: {seen['samesite']!r}")
        same_site = mapping[ss]
        if same_site is SameSite.NONE and not secure:
            return _reject("SameSite=None 必须同时带 Secure 属性, 否则浏览器不接受")
    else:
        warnings.append("未指定 SameSite, 按现代浏览器默认规则视为 Lax")

    cookie = Cookie(
        name=name,
        value=value,
        domain=domain,
        path=path,
        host_only=host_only,
        secure=secure,
        http_only=http_only,
        same_site=same_site,
        expires=expires,
        created_at=now,
        seq=-1,  # 由 CookieJar 入库时分配
    )
    return ParseResult(cookie=cookie, accepted=True, reason="", warnings=warnings)
