"""来源表达式与请求 URL 的匹配。

严格按 CSP3 的来源匹配语义实现，教学场景下的取舍在 README「规则范围」说明：

* 主机源不含端口时，只匹配资源协议的默认端口；
* ``*.example.com`` 只匹配子域（如 a.example.com），不匹配 example.com 本身；
* 路径按前缀匹配，查询串与片段不参与；
* ``data:`` / ``blob:`` 这类无主机 URL 只能被对应的协议来源（如 ``data:``）放行，
  ``'self'`` 与主机源都不会匹配它们；``about:`` 一律不匹配任何来源。
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlsplit

from .parser import SourceExpression

DEFAULT_PORTS = {"http": 80, "https": 443, "ws": 80, "wss": 443, "ftp": 21}

# 无主机（opaque / 特殊）协议，主机源与 'self' 均不适用
HOSTLESS_SCHEMES = ("data", "blob", "filesystem", "about")


@dataclass
class UrlInfo:
    raw: str
    scheme: str
    host: str
    port: int | None  # 显式端口；默认端口需经 effective_port 计算
    path: str

    @property
    def effective_port(self) -> int | None:
        if self.port is not None:
            return self.port
        return DEFAULT_PORTS.get(self.scheme)


def parse_url(url: str) -> UrlInfo:
    """解析资源/页面 URL。仅做结构化解析，不发起任何网络请求。"""
    if not url or not isinstance(url, str):
        raise ValueError("URL 为空")
    parts = urlsplit(url.strip())
    if not parts.scheme:
        raise ValueError(f"URL {url!r} 缺少协议（如 https://），无法判断来源")
    scheme = parts.scheme.lower()
    if scheme in HOSTLESS_SCHEMES:
        return UrlInfo(
            raw=url.strip(),
            scheme=scheme,
            host="",
            port=None,
            path=parts.path or "",
        )
    if not parts.hostname:
        raise ValueError(f"URL {url!r} 缺少主机名")
    return UrlInfo(
        raw=url.strip(),
        scheme=scheme,
        host=parts.hostname.lower(),
        port=parts.port,
        path=parts.path or "/",
    )


def origin_of(info: UrlInfo) -> tuple[str, str, int | None]:
    return (info.scheme, info.host, info.effective_port)


def _host_matches(pattern: str, host: str) -> bool:
    if pattern == "*":
        return True
    if pattern.startswith("*."):
        suffix = pattern[1:]  # ".example.com"
        return host.endswith(suffix) and len(host) > len(suffix)
    return pattern == host


def _port_matches(expr_port: str | None, url: UrlInfo) -> bool:
    expected = int(expr_port) if expr_port and expr_port != "*" else DEFAULT_PORTS.get(url.scheme)
    if expr_port == "*":
        return True
    return url.effective_port == expected


def _path_matches(pattern: str | None, url: UrlInfo) -> bool:
    if pattern is None:
        return True
    # 查询串/片段不参与，前缀匹配
    return url.path.startswith(pattern)


def match_source(
    expr: SourceExpression,
    resource: UrlInfo,
    page: UrlInfo,
) -> tuple[bool, str]:
    """判断单个来源表达式是否放行某外部资源 URL。

    返回 (是否匹配, 依据说明)。内联专属的 nonce/hash/unsafe-inline 不在此处理。
    """
    kind = expr.kind

    if kind == "keyword":
        kw = expr.keyword
        if kw == "'self'":
            if resource.scheme in HOSTLESS_SCHEMES:
                return False, f"'self' 不匹配无主机协议 {resource.scheme}: 的资源"
            same = origin_of(resource) == origin_of(page)
            if same:
                return True, f"资源来源与页面同源（{page.scheme}://{page.host}），命中 'self'"
            return (
                False,
                f"'self' 要求与页面同源 {page.scheme}://{page.host}"
                f"（端口按默认端口归一），资源为 {resource.scheme}://{resource.host}",
            )
        # 其他关键字（unsafe-inline / unsafe-eval / strict-dynamic / unsafe-hashes /
        # wasm-unsafe-eval）不是外部 URL 来源，不参与匹配
        return False, f"关键字 {kw} 不是外部资源的来源匹配项"

    if kind == "scheme":
        if resource.scheme == expr.scheme:
            return True, f"资源协议 {resource.scheme}: 命中协议来源 {expr.raw}"
        return False, f"协议来源 {expr.raw} 与资源协议 {resource.scheme}: 不一致"

    if kind == "host":
        if resource.scheme in HOSTLESS_SCHEMES:
            return (
                False,
                f"主机源 {expr.raw!r} 不能匹配 {resource.scheme}: 这类无主机 URL，"
                f"如需放行请显式添加 {resource.scheme}: 协议来源",
            )
        # 协议：表达式有协议则要求一致；没有则要求与页面协议一致
        expected_scheme = expr.scheme or page.scheme
        if resource.scheme != expected_scheme:
            return (
                False,
                f"主机源 {expr.raw!r} 要求协议 {expected_scheme}:，资源协议为 {resource.scheme}:",
            )
        if not _host_matches(expr.host, resource.host):
            if expr.host.startswith("*."):
                return (
                    False,
                    f"通配符主机源 {expr.host} 仅匹配其子域（如 a.{expr.host[2:]}），"
                    f"资源主机 {resource.host} 不满足",
                )
            return False, f"主机源 {expr.host} 与资源主机 {resource.host} 不相等"
        if not _port_matches(expr.port, resource):
            want = expr.port if expr.port else str(DEFAULT_PORTS.get(resource.scheme, "?"))
            return (
                False,
                f"端口不匹配：来源 {expr.raw!r} 要求端口 {want}，"
                f"资源实际端口 {resource.effective_port}",
            )
        if not _path_matches(expr.path, resource):
            return False, f"路径前缀 {expr.path!r} 与资源路径 {resource.path!r} 不匹配"
        detail = f"协议 {resource.scheme}:、主机 {resource.host}、端口 {resource.effective_port}"
        if expr.path:
            detail += f"、路径前缀 {expr.path}"
        return True, f"命中主机源 {expr.raw}（{detail}）"

    # nonce / hash / none / unknown 对外部 URL 均不构成来源匹配
    if kind == "nonce":
        return False, "随机标记仅用于内联 <script>/<style>，不匹配外部 URL"
    if kind == "hash":
        return False, "内容摘要仅用于内联内容，不匹配外部 URL"
    if kind == "none":
        return False, "'none' 表示不允许任何来源"
    return False, f"表达式 {expr.raw!r} 含义不明，未参与匹配"
