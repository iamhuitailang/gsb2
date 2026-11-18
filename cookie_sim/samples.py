"""一组可操作的本地样例。

每个样例都带有期望结果, tests/test_samples.py 会用同一套引擎实际执行并核对,
确保界面展示的样例结果与服务端决策一致。所有样例使用固定时间戳, 可重复运行。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .jar import CookieJar
from .parser import parse_set_cookie

# 固定 "当前时间", 样例中的 Max-Age 都相对它计算, 保证测试确定性
SAMPLE_NOW = 1_000_000.0


@dataclass
class Sample:
    id: str
    title: str
    description: str
    source_url: str
    set_cookies: list
    request_url: str
    top_url: str
    method: str
    is_navigation: bool
    expect_sent_names: list = field(default_factory=list)
    expect_cross_site: bool = False
    expect_reject_count: int = 0
    expect_reject_reasons: list = field(default_factory=list)
    document_url: Optional[str] = None
    expect_script_readable: list = field(default_factory=list)


def build_sample_jar(sample: Sample, now: float = SAMPLE_NOW) -> CookieJar:
    """按样例的 Set-Cookie 列表构建一个全新的 jar(走真实解析逻辑)。"""
    jar = CookieJar(now_func=lambda: now)
    for raw in sample.set_cookies:
        result = parse_set_cookie(raw, sample.source_url, now=now)
        if result.accepted:
            jar.add(result.cookie)
        else:
            jar.reject(raw, sample.source_url, result.reason,
                       "; ".join(result.warnings))
    return jar


SAMPLES: list[Sample] = [
    Sample(
        id="same-site-basic",
        title="同站 GET: 域/路径都匹配的 cookie 正常带上",
        description="同站子资源请求, host-only 与 Domain cookie 同时满足条件。",
        source_url="https://shop.example.com/account/orders",
        set_cookies=[
            "sid=abc123; Path=/; HttpOnly",
            "theme=dark; Path=/",
        ],
        request_url="https://shop.example.com/api/cart",
        top_url="https://shop.example.com/home",
        method="GET",
        is_navigation=False,
        expect_sent_names=["sid", "theme"],
        expect_cross_site=False,
        document_url="https://shop.example.com/api/cart",
        expect_script_readable=["theme"],
    ),
    Sample(
        id="lax-cross-site-subresource",
        title="Lax 跨站子资源: cookie 被阻止",
        description="其它站点页面里的图片/接口请求属于跨站普通子资源, Lax cookie 不发送。",
        source_url="https://shop.example.com/",
        set_cookies=["sid=abc123; Path=/; SameSite=Lax"],
        request_url="https://shop.example.com/track/pixel",
        top_url="https://blog.example.org/post/1",
        method="GET",
        is_navigation=False,
        expect_sent_names=[],
        expect_cross_site=True,
    ),
    Sample(
        id="lax-cross-site-navigation",
        title="Lax 跨站顶层 GET 导航: Lax 例外放行",
        description="从外站点击链接产生的顶层安全方法导航, Lax cookie 允许发送。",
        source_url="https://shop.example.com/",
        set_cookies=["sid=abc123; Path=/; SameSite=Lax"],
        request_url="https://shop.example.com/landing",
        top_url="https://blog.example.org/post/1",
        method="GET",
        is_navigation=True,
        expect_sent_names=["sid"],
        expect_cross_site=True,
    ),
    Sample(
        id="lax-cross-site-post",
        title="Lax 跨站 POST 表单: 即使顶层导航也阻止",
        description="跨站顶层导航但方法是 POST, 不满足 Lax 的安全方法例外。",
        source_url="https://shop.example.com/",
        set_cookies=["sid=abc123; Path=/; SameSite=Lax"],
        request_url="https://shop.example.com/transfer",
        top_url="https://blog.example.org/form",
        method="POST",
        is_navigation=True,
        expect_sent_names=[],
        expect_cross_site=True,
    ),
    Sample(
        id="strict-cross-site",
        title="Strict: 任何跨站请求都不发送(含顶层导航)",
        description="SameSite=Strict 没有 Lax 那样的顶层导航例外。",
        source_url="https://shop.example.com/",
        set_cookies=["sid=abc123; Path=/; SameSite=Strict"],
        request_url="https://shop.example.com/welcome",
        top_url="https://blog.example.org/links",
        method="GET",
        is_navigation=True,
        expect_sent_names=[],
        expect_cross_site=True,
    ),
    Sample(
        id="none-requires-secure",
        title="SameSite=None 拒收与放行对照",
        description="缺 Secure 的 None 直接拒收; 带 Secure 的 None 可随跨站请求发送。",
        source_url="https://ads.example.net/",
        set_cookies=[
            "track=1; Path=/; SameSite=None",
            "track2=2; Path=/; SameSite=None; Secure",
        ],
        request_url="https://ads.example.net/pixel",
        top_url="https://news.example.org/front",
        method="GET",
        is_navigation=False,
        expect_sent_names=["track2"],
        expect_cross_site=True,
        expect_reject_count=1,
        expect_reject_reasons=["SameSite=None 必须同时带 Secure"],
    ),
    Sample(
        id="host-only-vs-domain",
        title="host-only 与 Domain 范围: 完整标签边界",
        description="无 Domain 的只对 shop.example.com 生效; Domain=example.com 覆盖子域; evil-example.com 不得误匹配。",
        source_url="https://shop.example.com/",
        set_cookies=[
            "host=h1; Path=/",
            "wide=w1; Path=/; Domain=example.com",
        ],
        request_url="https://api.example.com/v1/data",
        top_url="https://api.example.com/dash",
        method="GET",
        is_navigation=False,
        expect_sent_names=["wide"],
        expect_cross_site=False,
    ),
    Sample(
        id="path-boundary-sort",
        title="路径边界与发送排序",
        description="/cart 不得匹配 /cartoon; 多个 cookie 按路径长度降序、创建先后稳定排序。",
        source_url="https://shop.example.com/store/list",
        set_cookies=[
            "root=r; Path=/",
            "store=s; Path=/store",
            "cart=c; Path=/store/cart",
            "trap=t; Path=/cart",
        ],
        request_url="https://shop.example.com/store/cart/items",
        top_url="https://shop.example.com/store/cart",
        method="GET",
        is_navigation=False,
        expect_sent_names=["cart", "store", "root"],
        expect_cross_site=False,
    ),
    Sample(
        id="reject-bad-domain",
        title="非法 Domain 拒收: 公共后缀与域外主机",
        description="Domain=com 是公共后缀; Domain=other.com 与来源主机不同域, 均拒收并说明原因。",
        source_url="https://shop.example.com/",
        set_cookies=[
            "a=1; Path=/; Domain=com",
            "b=2; Path=/; Domain=other.com",
        ],
        request_url="https://shop.example.com/",
        top_url="https://shop.example.com/",
        method="GET",
        is_navigation=False,
        expect_sent_names=[],
        expect_reject_count=2,
        expect_reject_reasons=["公共后缀", "不在同一域"],
    ),
    Sample(
        id="max-age-delete-update",
        title="Max-Age 删除与同名不同路径并存",
        description="Max-Age=0 只删除同名同域同路径的组合; 不同路径上的同名 cookie 继续存在。",
        source_url="https://shop.example.com/app/home",
        set_cookies=[
            "token=first; Path=/app",
            "token=second; Path=/app/home",
            "token=expired; Path=/app; Max-Age=0",
        ],
        request_url="https://shop.example.com/app/home",
        top_url="https://shop.example.com/app/home",
        method="GET",
        is_navigation=False,
        expect_sent_names=["token"],
        expect_cross_site=False,
    ),
    Sample(
        id="secure-http-block",
        title="Secure cookie 不通过 http 发送",
        description="同一主机的 http 请求拿不到 Secure cookie, 非 Secure 的不受影响。",
        source_url="https://secure.example.com/",
        set_cookies=[
            "secret=s; Path=/; Secure",
            "plain=p; Path=/",
        ],
        request_url="http://secure.example.com/account",
        top_url="http://secure.example.com/start",
        method="GET",
        is_navigation=False,
        expect_sent_names=["plain"],
        expect_cross_site=False,
    ),
]


def get_sample(sample_id: str) -> Optional[Sample]:
    return next((s for s in SAMPLES if s.id == sample_id), None)
