"""内置本地样例：固定输入 + 预期结果，可重复运行核对。

每个样例包含一组策略和一组请求；``expected`` 给出每条请求的预期最终判定，
``run_samples`` 实际跑一遍引擎并逐条比对，任何偏差都会暴露。
"""

from __future__ import annotations

from dataclasses import dataclass

from .engine import ResourceRequest, evaluate_all
from .parser import parse_policy

PAGE = "https://shop.example/index.html"


@dataclass
class SampleCase:
    key: str
    title: str
    description: str
    policies: list[dict]  # {name, mode, text}
    requests: list[dict]  # ResourceRequest 字段
    expected: list[str]   # 与 requests 等长，allow/block


SAMPLES: list[SampleCase] = [
    SampleCase(
        key="allow-and-block",
        title="样例1：放行与拦截（来源/协议/端口/通配符）",
        description=(
            "img-src 限定图片来源，script-src 限定脚本来源。覆盖主机精确匹配、"
            "通配符子域、协议来源、端口不一致拦截，以及一类资源的放行不会扩散到另一类。"
        ),
        policies=[
            {
                "name": "基础拦截策略",
                "mode": "enforce",
                "text": (
                    "default-src 'none'; "
                    "img-src https://cdn.example.com https://*.img.example.com; "
                    "script-src 'self' https://scripts.example.com; "
                    "style-src 'self'"
                ),
            }
        ],
        requests=[
            {"key": "img-allow", "page_url": PAGE, "resource_type": "img",
             "resource_url": "https://cdn.example.com/a.png", "initiator": "page"},
            {"key": "img-subdomain-allow", "page_url": PAGE, "resource_type": "img",
             "resource_url": "https://static.img.example.com/b.png", "initiator": "page"},
            {"key": "img-block-wildcard-root", "page_url": PAGE, "resource_type": "img",
             "resource_url": "https://img.example.com/c.png", "initiator": "page"},
            {"key": "img-block-other-host", "page_url": PAGE, "resource_type": "img",
             "resource_url": "https://evil.example.net/x.png", "initiator": "page"},
            {"key": "script-allow-self", "page_url": PAGE, "resource_type": "script",
             "resource_url": "https://shop.example/app.js", "initiator": "page"},
            {"key": "script-block-port", "page_url": PAGE, "resource_type": "script",
             "resource_url": "https://scripts.example.com:8443/app.js", "initiator": "page"},
            {"key": "img-host-not-leak-to-script", "page_url": PAGE, "resource_type": "script",
             "resource_url": "https://cdn.example.com/evil.js", "initiator": "page"},
        ],
        expected=["allow", "allow", "block", "block", "allow", "block", "block"],
    ),
    SampleCase(
        key="default-fallback",
        title="样例2：default-src 默认规则回退",
        description=(
            "字体、媒体、子页面没有专用指令，统一回退到 default-src 'self'；"
            "图片因存在专用 img-src 而不使用默认规则。"
        ),
        policies=[
            {
                "name": "默认回退策略",
                "mode": "enforce",
                "text": "default-src 'self'; img-src https://cdn.example.com",
            }
        ],
        requests=[
            {"key": "font-allow-self", "page_url": PAGE, "resource_type": "font",
             "resource_url": "https://shop.example/f.woff2", "initiator": "page"},
            {"key": "font-block", "page_url": PAGE, "resource_type": "font",
             "resource_url": "https://fonts.other.com/f.woff2", "initiator": "page"},
            {"key": "media-block", "page_url": PAGE, "resource_type": "media",
             "resource_url": "https://media.other.com/m.mp4", "initiator": "page"},
            {"key": "frame-block", "page_url": PAGE, "resource_type": "frame",
             "resource_url": "https://widget.other.com/embed", "initiator": "page"},
            {"key": "img-special-not-default", "page_url": PAGE, "resource_type": "img",
             "resource_url": "https://cdn.example.com/a.png", "initiator": "page"},
            {"key": "img-self-blocked", "page_url": PAGE, "resource_type": "img",
             "resource_url": "https://shop.example/a.png", "initiator": "page"},
        ],
        expected=["allow", "block", "block", "block", "allow", "block"],
    ),
    SampleCase(
        key="inline-nonce-hash",
        title="样例3：随机标记、内容摘要与内联限制",
        description=(
            "脚本只接受带正确随机标记或摘要的内联代码；样式允许 'unsafe-inline'。"
            "同时验证 nonce 错误、无标记内联被拦截，以及 unsafe-inline 与 nonce 共存时被忽略。"
        ),
        policies=[
            {
                "name": "内联管控策略",
                "mode": "enforce",
                "text": (
                    "default-src 'none'; "
                    "script-src 'nonce-r4nd0m' 'sha256-d0A9Zq3U4k7Q0YgP8mY3wV2xR1cT6bN5mL8kH0pQeRs='; "
                    "style-src 'unsafe-inline' 'self'"
                ),
            }
        ],
        requests=[
            {"key": "inline-script-nonce-allow", "page_url": PAGE, "resource_type": "script",
             "is_inline": True, "nonce": "r4nd0m", "inline_content": "console.log(1)",
             "initiator": "page"},
            {"key": "inline-script-nonce-block", "page_url": PAGE, "resource_type": "script",
             "is_inline": True, "nonce": "wrong", "inline_content": "console.log(2)",
             "initiator": "page"},
            {"key": "inline-script-no-token-block", "page_url": PAGE, "resource_type": "script",
             "is_inline": True, "inline_content": "console.log(3)", "initiator": "page"},
            {"key": "inline-style-allow", "page_url": PAGE, "resource_type": "style",
             "is_inline": True, "inline_content": "body{color:red}", "initiator": "page"},
            {"key": "external-style-blocked", "page_url": PAGE, "resource_type": "style",
             "resource_url": "https://styles.other.com/a.css", "initiator": "page"},
        ],
        expected=["allow", "block", "block", "allow", "block"],
    ),
    SampleCase(
        key="multi-policy-strict",
        title="样例4：多份策略叠加取最严格结果",
        description=(
            "拦截模式策略 A 与 B 同时生效（与关系）：A 放行的 CDN 图片若 B 不放行仍被拦截；"
            "并验证 strict-dynamic 下主机来源失效、受信任脚本传播信任。"
        ),
        policies=[
            {
                "name": "策略A-宽",
                "mode": "enforce",
                "text": (
                    "default-src 'none'; img-src https://cdn.example.com https://img.other.com; "
                    "script-src 'nonce-abc' https://scripts.example.com 'strict-dynamic'"
                ),
            },
            {
                "name": "策略B-严",
                "mode": "enforce",
                "text": "default-src 'none'; img-src https://cdn.example.com; script-src 'nonce-abc' 'strict-dynamic'",
            },
        ],
        requests=[
            {"key": "img-both-allow", "page_url": PAGE, "resource_type": "img",
             "resource_url": "https://cdn.example.com/a.png", "initiator": "page"},
            {"key": "img-only-a-allow-blocked", "page_url": PAGE, "resource_type": "img",
             "resource_url": "https://img.other.com/b.png", "initiator": "page"},
            {"key": "script-nonce-allow", "page_url": PAGE, "resource_type": "script",
             "resource_url": "https://scripts.example.com/loader.js", "nonce": "abc",
             "initiator": "page"},
            {"key": "script-host-ignored-block", "page_url": PAGE, "resource_type": "script",
             "resource_url": "https://scripts.example.com/loader.js", "initiator": "page"},
            {"key": "script-trusted-propagation-allow", "page_url": PAGE, "resource_type": "script",
             "resource_url": "https://anywhere.example/track.js",
             "initiator": "script", "parent_trusted": True},
            {"key": "script-untrusted-parent-block", "page_url": PAGE, "resource_type": "script",
             "resource_url": "https://anywhere.example/track.js",
             "initiator": "script", "parent_trusted": False},
        ],
        expected=["allow", "block", "allow", "block", "allow", "block"],
    ),
    SampleCase(
        key="report-only",
        title="样例5：仅报告模式只记录不拦截",
        description=(
            "同一份规则分别以拦截模式和仅报告模式运行：报告模式下本应拦截的图片仍然放行，"
            "但会留下包含策略、资源类别、命中原因与时间的报告记录。"
        ),
        policies=[
            {
                "name": "报告模式策略",
                "mode": "report",
                "text": "default-src 'none'; img-src 'self'",
            }
        ],
        requests=[
            {"key": "report-self-allow", "page_url": PAGE, "resource_type": "img",
             "resource_url": "https://shop.example/a.png", "initiator": "page"},
            {"key": "report-foreign-allowed-but-logged", "page_url": PAGE, "resource_type": "img",
             "resource_url": "https://third.example.net/b.png", "initiator": "page"},
            {"key": "report-font-fallback", "page_url": PAGE, "resource_type": "font",
             "resource_url": "https://fonts.other.com/f.woff2", "initiator": "page"},
        ],
        expected=["allow", "allow", "allow"],
    ),
]


def run_samples() -> dict:
    """执行全部样例并比对预期，返回结构化结果（供测试与页面共用）。"""
    results = []
    all_pass = True
    for case in SAMPLES:
        entries = []
        for p in case.policies:
            parsed = parse_policy(p["text"])
            assert parsed.ok, f"样例 {case.key} 自带策略解析失败：{parsed.errors}"
            entries.append({"id": p["name"], "name": p["name"], "mode": p["mode"], "parsed": parsed})
        case_rows = []
        for req_dict, expected in zip(case.requests, case.expected):
            key = req_dict["key"]
            req_fields = {k: v for k, v in req_dict.items() if k != "key"}
            result = evaluate_all(entries, ResourceRequest(**req_fields))
            passed = result.decision == expected
            all_pass = all_pass and passed
            case_rows.append(
                {
                    "key": key,
                    "request": req_fields,
                    "expected": expected,
                    "actual": result.decision,
                    "passed": passed,
                    "reason_summary": result.reason_summary,
                    "policy_decisions": [d.to_dict() for d in result.policy_decisions],
                    "reports": [d.to_dict() for d in result.reports],
                    "resolved": result.resolved,
                }
            )
        results.append(
            {
                "key": case.key,
                "title": case.title,
                "description": case.description,
                "policies": case.policies,
                "rows": case_rows,
                "case_pass": all(r["passed"] for r in case_rows),
            }
        )
    return {"all_pass": all_pass, "cases": results}
