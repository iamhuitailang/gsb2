"""一次请求的 Cookie 发送决策与脚本可读视图。

逐项给出域、路径、安全连接、有效期、SameSite 的允许/阻止理由;
HttpOnly 只影响脚本读取, 不影响符合条件的请求发送, 两件事在这里分开。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .jar import CookieJar
from .matching import host_only_matches, path_matches
from .model import Cookie, SameSite
from .sites import UrlInfo, is_cross_site, parse_url
from .timeutil import now_ts

# SameSite Lax 下允许带 cookie 的顶层安全方法导航
_SAFE_TOP_LEVEL_METHODS = {"GET", "HEAD", "OPTIONS", "TRACE"}


@dataclass
class CheckItem:
    key: str          # domain/path/secure/expiry/samesite
    label: str        # 中文名称
    passed: bool
    detail: str       # 实际命中的条件说明


@dataclass
class CookieDecision:
    cookie: Cookie
    sent: bool
    checks: list = field(default_factory=list)
    block_reason: str = ""

    def to_dict(self) -> dict:
        return {
            "cookie": self.cookie.to_dict(),
            "sent": self.sent,
            "block_reason": self.block_reason,
            "checks": [c.__dict__ for c in self.checks],
        }


@dataclass
class RequestDecision:
    request_url: str
    top_url: str
    method: str
    is_navigation: bool
    cross_site: bool
    cookie_header: str
    decisions: list
    evaluated_count: int

    def to_dict(self) -> dict:
        return {
            "request_url": self.request_url,
            "top_url": self.top_url,
            "method": self.method,
            "is_navigation": self.is_navigation,
            "cross_site": self.cross_site,
            "cookie_header": self.cookie_header,
            "evaluated_count": self.evaluated_count,
            "decisions": [d.to_dict() for d in self.decisions],
        }


def _samesite_check(cookie: Cookie, cross_site: bool, method: str,
                    is_navigation: bool) -> CheckItem:
    """返回 SameSite 检查项; passed=False 表示该 cookie 被阻止。"""
    ss = cookie.same_site
    if not cross_site:
        return CheckItem("samesite", "SameSite", True,
                         f"同站请求, SameSite={ss.value} 不限制发送")
    # 跨站
    if ss is SameSite.NONE:
        if not cookie.secure:
            return CheckItem("samesite", "SameSite", False,
                             "SameSite=None 但缺少 Secure, 该 cookie 本不应被浏览器接受")
        return CheckItem("samesite", "SameSite", True,
                         "跨站请求; SameSite=None 且带 Secure, 允许随跨站请求发送")
    if ss is SameSite.STRICT:
        return CheckItem("samesite", "SameSite", False,
                         "跨站请求; SameSite=Strict 仅允许同站发送, 阻止")
    # Lax
    if is_navigation and method in _SAFE_TOP_LEVEL_METHODS:
        return CheckItem(
            "samesite", "SameSite", True,
            f"跨站顶层安全方法导航({method}), 符合 Lax 例外, 允许发送",
        )
    if is_navigation:
        return CheckItem(
            "samesite", "SameSite", False,
            f"跨站顶层导航但方法 {method} 不是安全方法, 不满足 Lax 例外, 阻止",
        )
    return CheckItem(
        "samesite", "SameSite", False,
        "跨站普通子资源请求(非顶层导航), Lax 不允许, 阻止",
    )


def evaluate_request(jar: CookieJar, request_url: str, top_url: str,
                     method: str = "GET", is_navigation: bool = False,
                     now: Optional[float] = None) -> RequestDecision:
    """对 jar 中全部 cookie 逐项判断, 生成请求决策与 Cookie 头。"""
    if now is None:
        now = now_ts()
    req = parse_url(request_url)
    top = parse_url(top_url)
    method = (method or "GET").upper()
    cross_site = is_cross_site(req, top)

    decisions: list[CookieDecision] = []
    sent: list[Cookie] = []

    for cookie in jar.all_cookies():
        checks: list[CheckItem] = []
        # 1. 域
        if host_only_matches(cookie, req.host):
            scope = "主机级(host-only), 主机完全一致" if cookie.host_only \
                else f"Domain={cookie.domain}, 请求主机在其完整标签边界内"
            checks.append(CheckItem("domain", "域匹配", True, scope))
        else:
            checks.append(CheckItem(
                "domain", "域匹配", False,
                f"{'主机级 cookie 仅对 ' + cookie.domain + ' 生效' if cookie.host_only else 'Domain=' + cookie.domain + ' 不覆盖请求主机 ' + req.host}",
            ))
        # 2. 路径
        if path_matches(cookie.path, req.path):
            checks.append(CheckItem("path", "路径匹配", True,
                                    f"请求路径 {req.path} 位于 cookie 路径 {cookie.path} 的边界内"))
        else:
            checks.append(CheckItem("path", "路径匹配", False,
                                    f"请求路径 {req.path} 不匹配 cookie 路径 {cookie.path}"))
        # 3. 安全连接
        if cookie.secure and not req.is_secure:
            checks.append(CheckItem("secure", "安全连接", False,
                                    "cookie 带 Secure, 但请求不是 https 安全连接"))
        else:
            detail = "请求为 https, 满足 Secure" if cookie.secure else "cookie 未要求 Secure, 无限制"
            checks.append(CheckItem("secure", "安全连接", True, detail))
        # 4. 有效期
        if cookie.is_expired(now):
            checks.append(CheckItem("expiry", "有效期", False,
                                    f"cookie 已过期(过期时间 {cookie.expires:g})"))
        else:
            if cookie.expires is None:
                checks.append(CheckItem("expiry", "有效期", True, "会话 cookie, 当前会话内有效"))
            else:
                checks.append(CheckItem("expiry", "有效期", True,
                                        f"未过期(将在 {cookie.expires:g} 过期)"))
        # 5. SameSite
        checks.append(_samesite_check(cookie, cross_site, method, is_navigation))

        failed = next((c for c in checks if not c.passed), None)
        decision = CookieDecision(
            cookie=cookie,
            sent=failed is None,
            checks=checks,
            block_reason="" if failed is None else f"[{failed.label}] {failed.detail}",
        )
        decisions.append(decision)
        if failed is None:
            sent.append(cookie)

    # 路径长的在前, 路径相同按创建先后; 名称/域作为最终稳定兜底
    sent.sort(key=lambda c: (-len(c.path), c.seq, c.name, c.domain))
    cookie_header = "; ".join(f"{c.name}={c.value}" for c in sent)

    return RequestDecision(
        request_url=request_url,
        top_url=top_url,
        method=method,
        is_navigation=is_navigation,
        cross_site=cross_site,
        cookie_header=cookie_header,
        decisions=decisions,
        evaluated_count=len(decisions),
    )


@dataclass
class ScriptView:
    """document.cookie 视角: 只含脚本可读 cookie, 明确区别于真实请求头。"""

    document_url: str
    readable_header: str
    readable: list
    excluded: list

    def to_dict(self) -> dict:
        return {
            "document_url": self.document_url,
            "readable_header": self.readable_header,
            "readable": [c.to_dict() for c in self.readable],
            "excluded": [
                {"cookie": item[0].to_dict(), "reason": item[1]} for item in self.excluded
            ],
        }


def script_readable_cookies(jar: CookieJar, document_url: str,
                            now: Optional[float] = None) -> ScriptView:
    """模拟页面脚本 document.cookie 能读到的 cookie。

    规则: 与文档主机/路径匹配、未过期、Secure cookie 仅在 https 文档可读、
    HttpOnly 对脚本不可见(但仍可随请求发送, 见 evaluate_request)。
    """
    if now is None:
        now = now_ts()
    doc = parse_url(document_url)
    readable: list[Cookie] = []
    excluded: list = []

    for cookie in jar.all_cookies():
        if not host_only_matches(cookie, doc.host):
            excluded.append((cookie, f"域不匹配: 文档主机 {doc.host} 不在 cookie 作用域内"))
        elif not path_matches(cookie.path, doc.path):
            excluded.append((cookie, f"路径不匹配: {doc.path} 不在 {cookie.path} 边界内"))
        elif cookie.is_expired(now):
            excluded.append((cookie, "已过期"))
        elif cookie.secure and not doc.is_secure:
            excluded.append((cookie, "Secure cookie 在非 https 文档中对脚本不可见"))
        elif cookie.http_only:
            excluded.append((cookie, "HttpOnly cookie 禁止页面脚本读取(仍可随合规请求发送)"))
        else:
            readable.append(cookie)

    readable.sort(key=lambda c: (-len(c.path), c.seq, c.name, c.domain))
    header = "; ".join(f"{c.name}={c.value}" for c in readable)
    return ScriptView(document_url=document_url, readable_header=header,
                      readable=readable, excluded=excluded)
