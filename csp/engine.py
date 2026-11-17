"""单请求在一份或多份策略下的判定引擎。

关键语义（与 CSP3 对齐，取舍见 README）：

* 指令回退链：专用指令缺失时逐级回退到 default-src；都没有则该资源不受限。
* 一份策略内部：来源列表是「或」关系，任一来源命中即放行。
* 多份策略之间：是「与」关系——所有拦截模式策略都放行才放行，
  取最严格结果；仅报告模式策略的拦截只记录、不改变最终结果。
* 随机标记/摘要只对内联内容（以及带 nonce 的外部 <script> 元素）生效，
  绝不会让一个主机来源被另一类资源复用。
* 'strict-dynamic' 仅影响脚本：主机/协议来源失效，信任由受信任脚本
  发起的加载传播（需要在请求中显式标注父脚本是否受信任）。
"""

from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass, field
from typing import Optional

from .matcher import UrlInfo, match_source, parse_url
from .parser import ParsedPolicy, SourceExpression

# 资源类别 -> 指令回退链（找不到就继续向后回退）
DIRECTIVE_CHAINS: dict[str, tuple[str, ...]] = {
    "img": ("img-src", "default-src"),
    "script": ("script-src-elem", "script-src", "default-src"),
    "style": ("style-src-elem", "style-src", "default-src"),
    "font": ("font-src", "default-src"),
    "media": ("media-src", "default-src"),
    "frame": ("frame-src", "child-src", "default-src"),
    # 额外支持（题目六类之外，供进阶演示，README 注明）
    "connect": ("connect-src", "default-src"),
    "worker": ("worker-src", "child-src", "script-src", "default-src"),
    "object": ("object-src", "default-src"),
}

RESOURCE_LABELS = {
    "img": "图片",
    "script": "脚本",
    "style": "样式",
    "font": "字体",
    "media": "媒体",
    "frame": "子页面(iframe)",
    "connect": "接口连接",
    "worker": "Worker",
    "object": "插件对象",
}

INLINE_CAPABLE = ("script", "style")


@dataclass
class ResourceRequest:
    """一次页面资源请求的全部输入。"""

    page_url: str
    resource_type: str  # img/script/style/font/media/frame/...
    resource_url: str = ""        # 外部资源地址；内联时可为空
    is_inline: bool = False       # 是否为内联 <script>/<style>
    nonce: Optional[str] = None   # 元素上的 nonce 随机标记
    inline_content: Optional[str] = None  # 内联原文（服务端本地计算摘要，不外发）
    inline_digest: Optional[str] = None   # 也可直接给 'sha256-<base64>'
    initiator: str = "page"       # page=页面本身发起；script=脚本动态发起
    parent_trusted: bool = False  # 发起加载的父脚本是否受信任（strict-dynamic 用）

    def to_dict(self) -> dict:
        return {
            "page_url": self.page_url,
            "resource_type": self.resource_type,
            "resource_url": self.resource_url,
            "is_inline": self.is_inline,
            "nonce": self.nonce,
            "inline_content": self.inline_content,
            "inline_digest": self.inline_digest,
            "initiator": self.initiator,
            "parent_trusted": self.parent_trusted,
        }


@dataclass
class SourceCheck:
    raw: str
    kind: str
    matched: bool
    reason: str

    def to_dict(self) -> dict:
        return {"raw": self.raw, "kind": self.kind, "matched": self.matched, "reason": self.reason}


@dataclass
class PolicyDecision:
    policy_id: str
    policy_name: str
    mode: str  # enforce / report
    decision: str  # allow / block
    directive_chain: list[str]
    matched_directive: Optional[str]
    reason: str
    source_checks: list[SourceCheck] = field(default_factory=list)

    @property
    def would_block(self) -> bool:
        return self.decision == "block"

    def to_dict(self) -> dict:
        return {
            "policy_id": self.policy_id,
            "policy_name": self.policy_name,
            "mode": self.mode,
            "decision": self.decision,
            "directive_chain": list(self.directive_chain),
            "matched_directive": self.matched_directive,
            "reason": self.reason,
            "would_block": self.would_block,
            "source_checks": [c.to_dict() for c in self.source_checks],
        }


@dataclass
class OverallResult:
    decision: str  # allow / block
    reason_summary: str
    policy_decisions: list[PolicyDecision]
    reports: list[PolicyDecision]  # 所有「本来会拦截」的判定（含拦截模式与报告模式）
    resource: dict
    resolved: dict  # 解析后的 URL / 摘要等辅助信息

    def to_dict(self) -> dict:
        return {
            "decision": self.decision,
            "reason_summary": self.reason_summary,
            "policy_decisions": [d.to_dict() for d in self.policy_decisions],
            "reports": [d.to_dict() for d in self.reports],
            "resource": dict(self.resource),
            "resolved": dict(self.resolved),
        }


def _digests_for_content(content: str) -> dict[str, str]:
    """本地计算内联内容的 sha 摘要，返回 {sha256: 'sha256-<b64>', ...}。"""
    raw = content.encode("utf-8")
    out = {}
    for algo in ("sha256", "sha384", "sha512"):
        digest = base64.b64encode(hashlib.new(algo, raw).digest()).decode("ascii")
        out[algo] = f"{algo}-{digest}"
    return out


def _effective_sources(directive) -> list[SourceExpression]:
    raws = [s.raw.lower() for s in directive.sources]
    if "'none'" in raws:
        # 'none' 与其他来源共存时被忽略（解析阶段已给 warning）
        if len(raws) > 1:
            return [s for s in directive.sources if s.kind != "none"]
        return [s for s in directive.sources if s.kind == "none"]
    return list(directive.sources)


def _find_directive(parsed: ParsedPolicy, resource_type: str):
    chain = DIRECTIVE_CHAINS.get(resource_type)
    if chain is None:
        raise ValueError(f"不支持的资源类型 {resource_type!r}")
    for name in chain:
        directive = parsed.get_directive(name)
        if directive is not None:
            return name, chain, directive
    return None, chain, None


def _check_inline(
    directive, sources, request: ResourceRequest, resolved_digest: Optional[str]
) -> tuple[str, str, list[SourceCheck]]:
    """内联脚本/样式的判定，返回 (decision, reason, checks)。"""
    checks: list[SourceCheck] = []
    has_nonce_src = any(s.kind == "nonce" for s in sources)
    has_hash_src = any(s.kind == "hash" for s in sources)

    # 1) nonce 命中
    if request.nonce:
        for s in sources:
            if s.kind == "nonce":
                ok = s.nonce_value == request.nonce
                checks.append(
                    SourceCheck(
                        s.raw, "nonce", ok,
                        f"请求携带 nonce={request.nonce!r}，与 {s.raw} "
                        + ("一致，随机标记命中" if ok else "不一致"),
                    )
                )
                if ok:
                    return "allow", f"内联内容携带的随机标记命中 {s.raw}", checks
    # 2) 摘要命中
    if resolved_digest:
        algo, value = resolved_digest.split("-", 1)
        for s in sources:
            if s.kind == "hash":
                ok = s.hash_algorithm == algo and s.hash_value == value
                checks.append(
                    SourceCheck(
                        s.raw, "hash", ok,
                        f"内联内容摘要 {resolved_digest} 与 {s.raw} "
                        + ("一致，摘要命中" if ok else "不一致"),
                    )
                )
                if ok:
                    return "allow", f"内联内容的{algo}摘要命中 {s.raw}", checks
    else:
        for s in sources:
            if s.kind == "hash":
                checks.append(
                    SourceCheck(s.raw, "hash", False, "请求未提供内联原文或摘要，无法进行摘要比对")
                )

    # 3) 'unsafe-inline'：存在 nonce/hash 来源时被 CSP 规则忽略
    for s in sources:
        if s.keyword == "'unsafe-inline'":
            if has_nonce_src or has_hash_src:
                checks.append(
                    SourceCheck(
                        s.raw, "keyword", False,
                        "指令中同时存在随机标记/摘要，'unsafe-inline' 按 CSP 规则被忽略",
                    )
                )
            else:
                checks.append(SourceCheck(s.raw, "keyword", True, "命中 'unsafe-inline'，内联内容允许"))
                return "allow", "命中 'unsafe-inline'，内联内容允许", checks

    # 4) 其他关键字不能放行内联
    for s in sources:
        if s.kind == "keyword" and s.keyword not in ("'unsafe-inline'",):
            checks.append(SourceCheck(s.raw, "keyword", False, f"{s.keyword} 不能放行内联内容"))
        if s.kind in ("host", "scheme", "none", "unknown"):
            checks.append(SourceCheck(s.raw, s.kind, False, "该表达式不能用于内联内容"))

    reason = "内联内容未命中任何随机标记或摘要，且不允许 'unsafe-inline'，被拦截"
    return "block", reason, checks


def _check_external(
    directive, sources, request: ResourceRequest, resource: UrlInfo, page: UrlInfo,
    resource_type: str,
) -> tuple[str, str, list[SourceCheck]]:
    checks: list[SourceCheck] = []
    strict_dynamic = any(s.keyword == "'strict-dynamic'" for s in sources)
    is_script_like = resource_type in ("script", "worker")

    # 'none' 独占
    if len(sources) == 1 and sources[0].kind == "none":
        return (
            "block",
            f"{directive.name} 为 'none'，不允许任何外部{RESOURCE_LABELS.get(resource_type, '')}资源",
            [SourceCheck("'none'", "none", False, "'none' 表示禁止一切来源")],
        )

    # 外部 <script> 元素仍可携带 nonce（strict-dynamic 下依然有效）
    if request.nonce:
        for s in sources:
            if s.kind == "nonce":
                ok = s.nonce_value == request.nonce
                checks.append(
                    SourceCheck(
                        s.raw, "nonce", ok,
                        f"元素携带 nonce={request.nonce!r}，与 {s.raw} "
                        + ("一致" if ok else "不一致"),
                    )
                )
                if ok:
                    return "allow", f"外部元素的随机标记命中 {s.raw}", checks

    if strict_dynamic and is_script_like:
        # 主机/协议来源全部失效
        for s in sources:
            if s.kind in ("host", "scheme") or s.keyword == "'self'":
                checks.append(
                    SourceCheck(
                        s.raw, s.kind, False,
                        "'strict-dynamic' 生效时主机/协议/'self' 来源对脚本加载失效",
                    )
                )
        if request.initiator == "script":
            if request.parent_trusted:
                return (
                    "allow",
                    "请求由受信任脚本动态发起，'strict-dynamic' 传播信任予以放行",
                    checks,
                )
            return (
                "block",
                "请求由脚本动态发起，但父脚本未标注为受信任，'strict-dynamic' 不传播信任",
                checks,
            )
        return (
            "block",
            "页面自身直接发起的脚本加载，在 'strict-dynamic' 下只能靠随机标记/摘要获信，"
            "主机来源已失效",
            checks,
        )

    # 常规：来源列表 OR 匹配
    matched_any = False
    for s in sources:
        if s.kind in ("host", "scheme", "keyword"):
            ok, why = match_source(s, resource, page)
            checks.append(SourceCheck(s.raw, s.kind, ok, why))
            if ok:
                matched_any = True
        elif s.kind == "nonce":
            checks.append(SourceCheck(s.raw, "nonce", False, "该外部元素未携带匹配的 nonce 属性"))
        elif s.kind == "hash":
            checks.append(SourceCheck(s.raw, "hash", False, "摘要只用于内联内容，不匹配外部 URL"))
        elif s.kind == "none":
            checks.append(SourceCheck(s.raw, "none", False, "'none' 不放行任何来源"))
        else:
            checks.append(SourceCheck(s.raw, s.kind, False, "含义不明的表达式不参与放行"))

    if matched_any:
        hit = next(c for c in checks if c.matched)
        return "allow", f"来源 {hit.raw!r} 命中：{hit.reason}", checks
    return (
        "block",
        f"资源地址未命中 {directive.name} 中的任何允许来源",
        checks,
    )


def evaluate_one(
    parsed: ParsedPolicy,
    request: ResourceRequest,
    mode: str = "enforce",
    policy_id: str = "",
    policy_name: str = "",
) -> PolicyDecision:
    """评估请求在单份策略下的结果。调用方需保证 parsed.ok。"""
    if not parsed.ok:
        raise ValueError("策略存在解析错误，不能用于判定；请先修正后再录入")

    page = parse_url(request.page_url)
    matched_name, chain, directive = _find_directive(parsed, request.resource_type)

    if directive is None:
        return PolicyDecision(
            policy_id=policy_id,
            policy_name=policy_name,
            mode=mode,
            decision="allow",
            directive_chain=list(chain),
            matched_directive=None,
            reason=(
                f"策略未配置 {chain[0]} 等任何回退链指令，也没有 default-src，"
                "该类资源不受本策略限制"
            ),
        )

    sources = _effective_sources(directive)
    resolved_digest = request.inline_digest
    resolved: dict = {}

    if request.is_inline:
        if request.resource_type not in INLINE_CAPABLE:
            return PolicyDecision(
                policy_id, policy_name, mode, "block",
                list(chain), matched_name,
                f"{RESOURCE_LABELS.get(request.resource_type, '该')}资源不存在内联形式，"
                "内联标记只对 <script>/<style> 有意义",
            )
        if request.inline_content and not resolved_digest:
            resolved["digests"] = _digests_for_content(request.inline_content)
            # 默认按 sha256 参与比对，其余算法在来源中出现时也逐一比对
            resolved_digest = resolved["digests"]["sha256"]
        if request.inline_content and resolved_digest:
            algo = resolved_digest.split("-", 1)[0]
            if algo in resolved.get("digests", {}):
                resolved_digest = resolved["digests"][algo]
        decision, reason, checks = _check_inline(directive, sources, request, resolved_digest)
    else:
        resource = parse_url(request.resource_url)
        decision, reason, checks = _check_external(
            directive, sources, request, resource, page, request.resource_type
        )

    return PolicyDecision(
        policy_id=policy_id,
        policy_name=policy_name,
        mode=mode,
        decision=decision,
        directive_chain=list(chain),
        matched_directive=matched_name,
        reason=reason,
        source_checks=checks,
    )


def evaluate_all(policy_entries: list[dict], request: ResourceRequest) -> OverallResult:
    """在多份策略（enforce/report-only 混合）下评估同一请求。

    policy_entries: [{"id", "name", "mode", "parsed": ParsedPolicy}, ...]
    """
    page = parse_url(request.page_url)
    resolved: dict = {"page_origin": f"{page.scheme}://{page.host}"}
    if not request.is_inline:
        resource = parse_url(request.resource_url)
        resolved["resource_scheme"] = resource.scheme
        resolved["resource_host"] = resource.host
        resolved["resource_port"] = resource.effective_port
    if request.inline_content:
        resolved.setdefault("digests", _digests_for_content(request.inline_content))
        if not request.inline_digest:
            request.inline_digest = resolved["digests"]["sha256"]

    decisions: list[PolicyDecision] = []
    for entry in policy_entries:
        decision = evaluate_one(
            entry["parsed"],
            request,
            mode=entry.get("mode", "enforce"),
            policy_id=entry.get("id", ""),
            policy_name=entry.get("name", ""),
        )
        decisions.append(decision)

    if not decisions:
        return OverallResult(
            decision="allow",
            reason_summary="未选择任何策略，不施加限制",
            policy_decisions=[],
            reports=[],
            resource=request.to_dict(),
            resolved=resolved,
        )

    enforced = [d for d in decisions if d.mode == "enforce"]
    reports = [d for d in decisions if d.would_block]

    blocks = [d for d in enforced if d.decision == "block"]
    if blocks:
        first = blocks[0]
        summary = (
            f"被拦截模式策略「{first.policy_name}」拦截（{first.matched_directive}）：{first.reason}"
        )
        if len(blocks) > 1:
            summary += f"；另有 {len(blocks) - 1} 份拦截模式策略同样拦截"
        overall = "block"
    else:
        report_blocks = [d for d in decisions if d.mode == "report" and d.would_block]
        if report_blocks:
            first = report_blocks[0]
            summary = (
                f"实际放行（所有拦截模式策略均放行）；仅报告模式策略「{first.policy_name}」"
                f"本会拦截：{first.reason}，已记入报告"
            )
        else:
            summary = "所有参与策略均放行"
        overall = "allow"

    return OverallResult(
        decision=overall,
        reason_summary=summary,
        policy_decisions=decisions,
        reports=reports,
        resource=request.to_dict(),
        resolved=resolved,
    )
