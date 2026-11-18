"""URL 解析与同站(same-site)判断。

模拟器内置一份小型公共后缀表用于计算可注册域(eTLD+1), 表写死在代码里,
不访问任何外部服务; 未收录的后缀按单标签处理, 界面会注明该局限。
"""
from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlsplit

from .matching import canonicalize_host, is_ip_address

# 内置公共后缀(多标签后缀优先匹配); 仅覆盖常见场景, 不联网更新
STANDARD_SUFFIXES = {
    # 多标签后缀
    "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "ltd.uk", "plc.uk",
    "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
    "co.kr", "or.kr", "go.kr",
    "com.cn", "org.cn", "net.cn", "gov.cn", "edu.cn", "ac.cn",
    "com.hk", "org.hk", "gov.hk",
    "com.tw", "org.tw", "gov.tw",
    "com.au", "org.au", "net.au", "gov.au", "edu.au",
    "co.nz", "govt.nz", "org.nz",
    "co.in", "gov.in", "org.in", "firm.in",
    "com.br", "org.br", "gov.br",
    "com.mx", "com.sg", "com.my", "co.th", "co.za",
    "com.tr", "org.tr",
    "co.il", "org.il",
    "co.ve",
    # 单标签后缀(普通国家/通用顶级域, 数量很多, 这里仅列常见项;
    # 未列出的单标签也按单标签后缀处理, 无需逐一登记)
    "com", "org", "net", "edu", "gov", "mil", "int", "io", "co", "ai",
    "dev", "app", "me", "info", "biz", "tv", "cc", "xyz", "top", "cloud",
    "uk", "jp", "kr", "cn", "hk", "tw", "au", "nz", "in", "br", "mx",
    "sg", "my", "th", "za", "tr", "il", "de", "fr", "eu", "nl", "ru",
    "us", "ca", "ch", "se", "no", "fi", "dk", "it", "es", "pl",
}


@dataclass(frozen=True)
class UrlInfo:
    scheme: str
    host: str
    port: int | None
    path: str

    @property
    def is_secure(self) -> bool:
        # 仅模拟 http/https; https 视为安全连接
        return self.scheme == "https"


def parse_url(url: str) -> UrlInfo:
    """解析并校验 http(s) URL, 返回结构化信息。"""
    if not url or not str(url).strip():
        raise ValueError("URL 为空")
    text = str(url).strip()
    if "://" not in text:
        raise ValueError(f"URL 缺少协议(需以 http:// 或 https:// 开头): {url!r}")
    parts = urlsplit(text)
    if parts.scheme not in ("http", "https"):
        raise ValueError(f"仅支持 http/https 协议, 收到: {parts.scheme!r}")
    if not parts.hostname:
        raise ValueError(f"URL 缺少主机名: {url!r}")
    host = canonicalize_host(parts.hostname)
    path = parts.path or "/"
    return UrlInfo(scheme=parts.scheme, host=host, port=parts.port, path=path)


def registrable_domain(host: str) -> str:
    """计算可注册域(eTLD+1); IP 地址原样返回。"""
    if is_ip_address(host):
        return host
    labels = host.rstrip(".").lower().split(".")
    if len(labels) <= 1:
        return host.lower()
    # 从长到短找公共后缀(至少保留一个标签作为域名本体)
    for size in range(len(labels) - 1, 0, -1):
        suffix = ".".join(labels[-size:])
        if suffix in STANDARD_SUFFIXES:
            return ".".join(labels[-(size + 1):])
    # 未命中内置后缀表: 无法离线确定公共后缀, 浏览器此时把整个主机名
    # 视为可注册域(任意两个该后缀下的主机名都算跨站)
    return host.lower()


def site_key(url: UrlInfo) -> tuple:
    """站点标识 = (协议, 可注册域)。协议不同也算跨站(schemeful same-site)。"""
    return (url.scheme, registrable_domain(url.host))


def is_cross_site(request_url: UrlInfo, top_url: UrlInfo) -> bool:
    """请求站点与顶层页面站点不同即跨站。"""
    return site_key(request_url) != site_key(top_url)
