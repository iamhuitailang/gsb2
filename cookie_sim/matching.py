"""RFC 6265 风格的域名规范化、完整标签边界匹配与路径匹配。"""
from __future__ import annotations

import ipaddress
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .model import Cookie


def canonicalize_host(host: str) -> str:
    """主机名小写化并去掉根点; 非法输入抛 ValueError。"""
    if host is None:
        raise ValueError("主机名为空")
    text = str(host).strip().lower().rstrip(".")
    if not text:
        raise ValueError("主机名为空")
    if any(ch in text for ch in " \t\r\n") or ".." in text or text.startswith("."):
        raise ValueError(f"主机名不合法: {host!r}")
    return text


def is_ip_address(host: str) -> bool:
    """判断 host 是否为字面量 IPv4/IPv6 地址。"""
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def domain_matches(cookie_domain: str, request_host: str) -> bool:
    """cookie 的域是否覆盖请求主机(完整标签边界, 禁止前缀子串误匹配)。"""
    cd = cookie_domain.lower().rstrip(".")
    rh = request_host.lower().rstrip(".")
    if cd == rh:
        return True
    # 必须以 ".标签" 为边界, 例如 evil-example.com 不得匹配 example.com
    return rh.endswith("." + cd)


def host_only_matches(cookie: "Cookie", request_host: str) -> bool:
    """host-only cookie 仅与完全相同的主机匹配。"""
    if not cookie.host_only:
        return domain_matches(cookie.domain, request_host)
    return cookie.domain.lower().rstrip(".") == request_host.lower().rstrip(".")


def default_path(request_path: str) -> str:
    """RFC 6265 5.1.4 默认路径算法。"""
    if not request_path or not request_path.startswith("/"):
        return "/"
    # 去掉第一个斜杠之后再找最后一个斜杠
    idx = request_path.rfind("/", 1)
    if idx < 0:
        return "/"
    if idx == 0:
        return "/"
    return request_path[:idx]


def path_matches(cookie_path: str, request_path: str) -> bool:
    """RFC 6265 5.1.4 路径匹配(路径边界)。"""
    cp = cookie_path or "/"
    rp = request_path or "/"
    if not rp.startswith(cp):
        return False
    if cp == rp or cp.endswith("/"):
        return True
    # 公共前缀之后必须是路径分隔符, 防止 /store 匹配 /storeother、/cart 匹配 /cartoon
    return rp[len(cp):].startswith("/")
