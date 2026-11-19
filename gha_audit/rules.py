"""规则实现：对已解析的工作流做结构化检查。

分析基于解析后的 YAML 结构（含行号），区分工作流级/任务级配置、
权限继承以及表达式出现的字段，而不是简单的字符串搜索。
"""
from __future__ import annotations

import re

from .loader import line_of, real_items, wf_get
from .model import CONFIRMED, UNDETERMINED, Finding

# 规则注册表：编号 -> 标题（例外注释会校验编号是否在此表中）
RULES = {
    "GHA001": "权限范围过大",
    "GHA002": "权限设置无法确认",
    "GHA010": "外部动作未固定到不可变版本",
    "GHA020": "不可信数据直接拼入命令",
    "GHA021": "手动触发输入直接拼入命令",
    "GHA030": "高风险触发器检出不可信代码",
    "GHA031": "高风险触发器组合写权限与机密",
    "GHA900": "无法识别的结构",
    "GHA901": "例外格式或规则编号无效",
    "GHA902": "例外已过期",
}

# 高风险触发器：在目标仓库上下文中运行、可访问机密与写权限令牌，
# 同时又能被仓库外贡献者的输入触发
RISKY_TRIGGERS = ("pull_request_target", "issue_comment", "workflow_run")

_ABSENT = object()

# 攻击者可控制的上下文路径（PR 标题/正文、评论、讨论等）
_UNTRUSTED_CONTEXTS = tuple(
    re.compile(p)
    for p in (
        r"github\.event\.issue\.(title|body)",
        r"github\.event\.pull_request\.(title|body)",
        r"github\.event\.pull_request\.head\.(ref|label|repo)(\.[A-Za-z0-9_]+)*",
        r"github\.event\.(comment|review|review_comment)\.body",
        r"github\.event\.discussion\.(title|body)",
        r"github\.event\.workflow_run\.(head_branch|head_commit)(\.[A-Za-z0-9_]+)*",
        r"github\.event\.pages(\.[A-Za-z0-9_]+)*",
        r"github\.head_ref",
    )
)
_INPUTS_CONTEXT = re.compile(r"(inputs|github\.event\.inputs)(\.[A-Za-z0-9_]+)*")

_EXPR_RE = re.compile(r"\$\{\{(.*?)\}\}", re.DOTALL)
_TOKEN_RE = re.compile(
    r"\b(?:github|inputs|secrets|env|needs|steps|matrix|vars|job|runner|strategy)"
    r"(?:\.[A-Za-z0-9_]+)*"
)
_BRACKET_RE = re.compile(r"\[\s*['\"]([^'\"]+)['\"]\s*\]")
_SHA_RE = re.compile(r"[0-9a-f]{40}")
_UNTRUSTED_REF_RE = re.compile(r"github\.(event\.pull_request\.head|head_ref)")


def _clip(text, limit=120):
    text = text.strip()
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _context_tokens(text):
    """提取文本中所有 ${{ }} 表达式引用到的上下文路径（统一为点分形式）。"""
    for match in _EXPR_RE.finditer(text):
        expr = _BRACKET_RE.sub(r".\1", match.group(1))
        for tok in _TOKEN_RE.finditer(expr):
            yield tok.group(0)


def _triggers(on) -> list[str]:
    """归一化 on 字段（字符串 / 列表 / 映射三种写法）为触发器名列表。"""
    if isinstance(on, str):
        return [on]
    if isinstance(on, list):
        out = []
        for item in on:
            if isinstance(item, str):
                out.append(item)
            elif isinstance(item, dict):
                out.extend(k for k, _ in real_items(item) if isinstance(k, str))
        return out
    if isinstance(on, dict):
        return [k for k, _ in real_items(on) if isinstance(k, str)]
    return []


def _write_scopes(perms):
    """解析 permissions，返回 (写权限集合, 是否无法确认)。"""
    if perms is _ABSENT or perms is None:
        return set(), True
    if isinstance(perms, str):
        if perms == "write-all":
            return {"*"}, False
        if perms == "read-all":
            return set(), False
        return set(), True
    if isinstance(perms, dict):
        writes = {str(k) for k, v in real_items(perms) if v == "write"}
        unknown = any(v not in ("read", "write", "none") for _, v in real_items(perms))
        return writes, unknown
    return set(), True


def _walk_strings(node):
    """遍历结构中的所有字符串值（跳过 secrets 子树与内部行号键）。"""
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for key, value in real_items(node):
            if key == "secrets":
                continue
            yield from _walk_strings(value)
    elif isinstance(node, list):
        for item in node:
            yield from _walk_strings(item)


def _job_uses_secrets(job) -> bool:
    # 可复用工作流调用通过 secrets: 传递机密
    if "secrets" in job:
        return True
    for text in _walk_strings(job):
        for tok in _context_tokens(text):
            if tok == "secrets" or tok.startswith("secrets."):
                return True
    return False


def _permission_findings(path, container, where, job_id):
    """检查单个 permissions 块（工作流级或任务级）。"""
    if "permissions" not in container:
        return []
    perms = container["permissions"]
    line = line_of(container, "permissions")
    loc = {"job": job_id}
    if isinstance(perms, str):
        if perms == "write-all":
            return [Finding("GHA001", "high", path, line,
                            f"{where} permissions 为 write-all，授予了全部写权限",
                            evidence=["permissions: write-all"], **loc)]
        if perms == "read-all":
            return []
        return [Finding("GHA002", "notice", path, line,
                        f"{where} permissions 取值无法识别: {_clip(perms, 40)!r}",
                        confidence=UNDETERMINED, **loc)]
    if isinstance(perms, dict):
        writes = sorted(str(k) for k, v in real_items(perms) if v == "write")
        unknown = sorted(f"{k}={v!r}" for k, v in real_items(perms)
                         if v not in ("read", "write", "none"))
        out = []
        if writes:
            out.append(Finding("GHA001", "medium", path, line,
                               f"{where} 授予了写权限，请确认是否都是实际需要: "
                               + ", ".join(writes),
                               evidence=[f"{s}: write" for s in writes], **loc))
        if unknown:
            out.append(Finding("GHA002", "notice", path, line,
                               f"{where} permissions 含无法识别的取值",
                               confidence=UNDETERMINED, evidence=unknown, **loc))
        return out
    return [Finding("GHA002", "notice", path, line,
                    f"{where} permissions 不是可识别的结构，无法确认实际权限",
                    confidence=UNDETERMINED, **loc)]


def _uses_findings(path, line, uses, kind, job_id, step_label):
    """检查 uses 引用是否固定到不可变版本。"""
    loc = {"job": job_id, "step": step_label}
    if not isinstance(uses, str):
        return [Finding("GHA010", "notice", path, line,
                        f"{kind}的 uses 不是字符串，无法确认是否固定",
                        confidence=UNDETERMINED, **loc)]
    if "${{" in uses:
        return [Finding("GHA010", "notice", path, line,
                        f"{kind}使用动态引用，无法确认是否固定: {_clip(uses)}",
                        confidence=UNDETERMINED, **loc)]
    if uses.startswith("./"):
        return []  # 仓库内本地动作，随仓库提交固定
    if uses.startswith("docker://"):
        if "@sha256:" in uses:
            return []
        return [Finding("GHA010", "medium", path, line,
                        f"Docker 镜像未固定到摘要（标签可被重新推送）: {_clip(uses)}",
                        evidence=[uses], **loc)]
    if "@" not in uses:
        return [Finding("GHA010", "medium", path, line,
                        f"{kind}缺少版本引用: {_clip(uses)}",
                        evidence=[uses], **loc)]
    ref = uses.rsplit("@", 1)[1]
    if _SHA_RE.fullmatch(ref):
        return []
    return [Finding("GHA010", "medium", path, line,
                    f"{kind}未固定到完整提交 SHA（引用 {ref!r} 可被重新指向）: "
                    f"{_clip(uses)}",
                    evidence=[uses], **loc)]


def _injection_findings(path, line, run, triggers, job_id, step_label):
    """检查 run 命令中是否直接拼接了不可信上下文。"""
    untrusted, inputs = set(), set()
    for tok in _context_tokens(run):
        if any(p.fullmatch(tok) for p in _UNTRUSTED_CONTEXTS):
            untrusted.add(tok)
        elif _INPUTS_CONTEXT.fullmatch(tok):
            inputs.add(tok)
    out = []
    if untrusted:
        out.append(Finding(
            "GHA020", "high", path, line,
            "run 命令中直接拼接了攻击者可控制的上下文数据，存在命令注入风险",
            job=job_id, step=step_label, evidence=sorted(untrusted)))
    if inputs and "workflow_dispatch" in triggers:
        out.append(Finding(
            "GHA021", "medium", path, line,
            "run 命令中直接拼接了 workflow_dispatch 输入",
            job=job_id, step=step_label, evidence=sorted(inputs)))
    return out


def _step_label(step, index):
    name = step.get("name")
    return name if isinstance(name, str) and name else f"第 {index + 1} 步"


def _check_steps(path, job, job_id, triggers):
    out = []
    steps = job.get("steps")
    if steps is None:
        return out
    if not isinstance(steps, list):
        out.append(Finding("GHA900", "notice", path, line_of(job, "steps"),
                           "steps 不是列表结构，已跳过该任务的分析",
                           confidence=UNDETERMINED, job=job_id))
        return out
    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            out.append(Finding("GHA900", "notice", path, line_of(job, "steps"),
                               f"第 {index + 1} 步不是映射结构，已跳过",
                               confidence=UNDETERMINED, job=job_id))
            continue
        label = _step_label(step, index)
        if "uses" in step:
            out.extend(_uses_findings(path, line_of(step, "uses"), step["uses"],
                                      "外部动作", job_id, label))
        run = step.get("run")
        if isinstance(run, str):
            out.extend(_injection_findings(path, line_of(step, "run"), run,
                                           triggers, job_id, label))
    return out


def _check_risky_combos(path, job, job_id, wf_perms, risky):
    """高风险触发器与敏感操作的组合检查（按任务分别判断）。"""
    out = []
    trigger_text = ", ".join(risky)
    steps = job.get("steps")
    step_list = steps if isinstance(steps, list) else []

    # GHA030: 检出 PR 不可信代码
    for index, step in enumerate(step_list):
        if not isinstance(step, dict):
            continue
        uses = step.get("uses")
        if not (isinstance(uses, str) and uses.startswith("actions/checkout@")):
            continue
        with_block = step.get("with")
        if not isinstance(with_block, dict):
            continue
        for key in ("ref", "repository"):
            value = with_block.get(key)
            if isinstance(value, str) and _UNTRUSTED_REF_RE.search(value):
                out.append(Finding(
                    "GHA030", "high", path, line_of(with_block, key),
                    f"高风险触发器（{trigger_text}）下检出了 Pull Request 的不可信代码，"
                    "其内容将以目标仓库权限执行",
                    job=job_id, step=_step_label(step, index),
                    evidence=[f"{key}: {_clip(value, 80)}"]))

    # GHA031: 写权限 + 机密
    perms = job.get("permissions", wf_perms)
    writes, unknown = _write_scopes(perms)
    if _job_uses_secrets(job):
        if writes:
            scope_text = "write-all" if writes == {"*"} else ", ".join(sorted(writes))
            out.append(Finding(
                "GHA031", "medium", path,
                line_of(job, "permissions") if "permissions" in job else line_of(job),
                f"高风险触发器（{trigger_text}）下的任务同时拥有写权限"
                f"（{scope_text}）并访问机密",
                job=job_id,
                evidence=[f"写权限: {scope_text}", "任务中引用了 secrets"]))
        elif unknown:
            out.append(Finding(
                "GHA031", "medium", path, line_of(job),
                f"高风险触发器（{trigger_text}）下的任务访问了机密，"
                "但未显式声明 permissions，实际权限取决于仓库设置，无法确认",
                confidence=UNDETERMINED, job=job_id,
                evidence=["任务中引用了 secrets", "permissions 未显式声明"]))
    return out


def analyze_workflow(path, data) -> list[Finding]:
    """对单个已解析的工作流执行全部规则，返回发现列表。"""
    findings = []
    triggers = _triggers(wf_get(data, "on"))
    wf_perms = data.get("permissions", _ABSENT)

    findings.extend(_permission_findings(path, data, "工作流级", None))

    jobs = data.get("jobs")
    if not isinstance(jobs, dict):
        findings.append(Finding("GHA900", "notice", path, line_of(data),
                                "jobs 不是映射结构，已跳过任务级分析",
                                confidence=UNDETERMINED))
        jobs = {}

    # 工作流未声明权限且存在未自行声明权限的任务时，实际权限取决于仓库设置
    if wf_perms is _ABSENT:
        for _, job in real_items(jobs):
            if isinstance(job, dict) and "permissions" not in job:
                findings.append(Finding(
                    "GHA002", "notice", path, 1,
                    "工作流未声明 permissions，实际权限取决于仓库设置，无法确认",
                    confidence=UNDETERMINED))
                break

    risky = sorted(set(triggers) & set(RISKY_TRIGGERS))

    for job_id, job in real_items(jobs):
        if not isinstance(job, dict):
            findings.append(Finding("GHA900", "notice", path,
                                    line_of(jobs, str(job_id)),
                                    f"任务 {job_id} 不是映射结构，已跳过",
                                    confidence=UNDETERMINED, job=str(job_id)))
            continue
        job_id = str(job_id)
        findings.extend(_permission_findings(path, job, f"任务 {job_id}", job_id))
        # 可复用工作流调用（jobs.<id>.uses）
        if "uses" in job:
            findings.extend(_uses_findings(path, line_of(job, "uses"), job["uses"],
                                           "可复用工作流", job_id, None))
        findings.extend(_check_steps(path, job, job_id, triggers))
        if risky:
            findings.extend(_check_risky_combos(path, job, job_id, wf_perms, risky))

    return findings
