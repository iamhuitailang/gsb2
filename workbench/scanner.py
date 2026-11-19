"""Project file discovery and credential rule matching.

Security boundaries enforced here:

* the walk never follows symbolic links (files or directories), and every
  candidate is re-checked against the real path of the project root before it
  is opened;
* files are read as bytes with a hard per-file size limit, and their content is
  never logged or returned verbatim;
* binary files are detected before decoding and are reported as skipped;
* every candidate that was not scanned is recorded with a machine-readable
  reason and a human explanation.

Only a redacted preview of a matching line ever leaves this module.  The raw
secret is placed in the internal ``_secret`` key purely so the service layer can
derive a keyed fingerprint, and must be dropped immediately afterwards.
"""

from __future__ import annotations

import fnmatch
import os
import re
import stat
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence, Set, Tuple

from .rules import Rule, RuleSet, SEVERITY_WEIGHT, shannon_entropy
from .utils import (
    clean_preview,
    context_digest,
    is_within,
    redact_spans,
    safe_message,
)

DEFAULT_EXCLUDED_DIRS = (
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "bower_components",
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "dist",
    "build",
    "target",
    "coverage",
    ".idea",
    ".vscode",
    "vendor",
)

# Reasons a candidate path was not inspected.  They are part of the export
# contract, and the UI groups them by remediation advice.
SKIP_REASONS = {
    "symlink": "符号链接：为防止越界，扫描器从不跟随符号链接",
    "symlink_outside_root": "符号链接指向项目根目录之外，未读取目标内容",
    "binary": "二进制文件：前 8 KiB 含 NUL 字节或控制字符比例过高，未做文本扫描",
    "too_large": "文件超过单文件大小上限，未读取",
    "total_size_limit": "本次扫描累计读取达到上限，未读取",
    "file_limit": "本次扫描文件数量达到上限，未读取",
    "unreadable": "文件无法读取（权限或 I/O 错误）",
    "not_regular_file": "不是普通文件（设备、管道或套接字）",
    "outside_root": "解析后的真实路径位于项目根目录之外，拒绝读取",
    "excluded": "命中排除规则（默认忽略目录或用户排除模式）",
    "line_limit": "文件含超长行，超长部分已截断，未扫描",
}

TEXT_ENCODINGS = ("utf-8", "gb18030", "latin-1")
BINARY_SAMPLE_BYTES = 8192


@dataclass
class ScanOptions:
    max_file_bytes: int = 2 * 1024 * 1024
    max_total_bytes: int = 256 * 1024 * 1024
    max_files: int = 20000
    max_line_chars: int = 20000
    excluded_dirs: Tuple[str, ...] = DEFAULT_EXCLUDED_DIRS
    exclude_patterns: Tuple[str, ...] = ()

    def public_dict(self) -> Dict[str, object]:
        return {
            "max_file_bytes": self.max_file_bytes,
            "max_total_bytes": self.max_total_bytes,
            "max_files": self.max_files,
            "max_line_chars": self.max_line_chars,
            "excluded_dirs": list(self.excluded_dirs),
            "exclude_patterns": list(self.exclude_patterns),
            "follow_symlinks": False,
        }


@dataclass
class SkippedFile:
    path: str
    reason: str
    size: int = 0
    message: str = ""

    def public_dict(self) -> Dict[str, object]:
        return {
            "path": self.path,
            "reason": self.reason,
            "message": self.message or SKIP_REASONS.get(self.reason, self.reason),
            "size": self.size,
        }


@dataclass
class ScanOutput:
    root: str
    findings: List[Dict[str, object]]
    skipped: List[SkippedFile]
    inspected_paths: Set[str]
    files_seen: int
    files_inspected: int
    bytes_read: int
    line_count: int
    truncated_line_files: int
    ruleset_version: str


@dataclass
class _Candidate:
    rule: Rule
    line_no: int
    column: int
    end_column: int
    secret: str
    secret_span: Tuple[int, int]
    redact_span: Tuple[int, int]
    block: bool = False
    block_start: int = 0
    block_end: int = 0
    terminated: bool = True

    @property
    def overlap_key(self) -> Tuple[int, int]:
        return self.redact_span

    @property
    def specificity(self) -> int:
        return self.end_column - self.column


def _match_glob(rel_path: str, patterns: Sequence[str]) -> bool:
    return any(fnmatch.fnmatchcase(rel_path, pattern) for pattern in patterns)


def _is_probably_binary(sample: bytes) -> bool:
    if b"\x00" in sample:
        return True
    if not sample:
        return False
    control = sum(1 for byte in sample if byte < 9 or 13 < byte < 32)
    return control / float(len(sample)) > 0.30


def _decode(data: bytes) -> Optional[str]:
    for encoding in TEXT_ENCODINGS:
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return None


def discover_files(
    root: str, options: ScanOptions
) -> Tuple[List[str], List[SkippedFile], int]:
    """Walk the project without following symlinks.

    Returns (relative paths to inspect, skipped entries, files seen).
    """
    root_abs = os.path.abspath(root)
    root_real = os.path.realpath(root)
    to_scan: List[str] = []
    skipped: List[SkippedFile] = []
    files_seen = 0
    size_budget = options.max_total_bytes

    stack: List[str] = [""]
    while stack:
        rel_dir = stack.pop()
        abs_dir = os.path.join(root_abs, rel_dir) if rel_dir else root_abs
        try:
            entries = sorted(os.scandir(abs_dir), key=lambda item: item.name)
        except OSError as exc:
            skipped.append(
                SkippedFile(rel_dir or ".", "unreadable", 0, safe_message(exc))
            )
            continue
        for entry in entries:
            rel_path = (os.path.join(rel_dir, entry.name) if rel_dir else entry.name)
            rel_path = rel_path.replace(os.sep, "/")
            try:
                info = entry.stat(follow_symlinks=False)
            except OSError as exc:
                files_seen += 1
                skipped.append(SkippedFile(rel_path, "unreadable", 0, safe_message(exc)))
                continue

            if stat.S_ISLNK(info.st_mode):
                files_seen += 1
                try:
                    target = os.path.realpath(os.path.join(abs_dir, entry.name))
                except OSError:
                    target = ""
                reason = (
                    "symlink_outside_root"
                    if target and not is_within(root_real, target)
                    else "symlink"
                )
                skipped.append(SkippedFile(rel_path, reason, 0, ""))
                continue

            if stat.S_ISDIR(info.st_mode):
                if entry.name in options.excluded_dirs or _match_glob(
                    rel_path, options.exclude_patterns
                ):
                    skipped.append(
                        SkippedFile(rel_path, "excluded", 0, "目录：%s" % entry.name)
                    )
                    continue
                stack.append(rel_path)
                continue

            if not stat.S_ISREG(info.st_mode):
                files_seen += 1
                skipped.append(SkippedFile(rel_path, "not_regular_file", 0, ""))
                continue

            files_seen += 1
            if entry.name in options.excluded_dirs or _match_glob(
                rel_path, options.exclude_patterns
            ):
                skipped.append(SkippedFile(rel_path, "excluded", info.st_size, ""))
                continue
            if len(to_scan) >= options.max_files:
                skipped.append(SkippedFile(rel_path, "file_limit", info.st_size, ""))
                continue
            if info.st_size > options.max_file_bytes:
                skipped.append(SkippedFile(rel_path, "too_large", info.st_size, ""))
                continue
            if info.st_size > size_budget:
                skipped.append(
                    SkippedFile(rel_path, "total_size_limit", info.st_size, "")
                )
                continue
            # Re-check the resolved path: a bind mount or unusual link must not
            # let a file outside the project root into the reading loop.
            try:
                real = os.path.realpath(os.path.join(abs_dir, entry.name))
            except OSError as exc:
                skipped.append(
                    SkippedFile(rel_path, "unreadable", info.st_size, safe_message(exc))
                )
                continue
            if not is_within(root_real, real):
                skipped.append(SkippedFile(rel_path, "outside_root", info.st_size, ""))
                continue
            size_budget -= info.st_size
            to_scan.append(rel_path)
    to_scan.sort()
    return to_scan, skipped, files_seen


def _candidate_group(match: re.Match, group: object) -> Tuple[str, Tuple[int, int]]:
    try:
        value = match.group(group)  # type: ignore[arg-type]
        span = match.span(group)  # type: ignore[arg-type]
    except (IndexError, KeyError):
        return "", (0, 0)
    return value or "", span


def _line_candidates(rule: Rule, line: str, line_no: int) -> List[_Candidate]:
    out: List[_Candidate] = []
    if rule.kind != "line":
        return out
    for match in rule.regex.finditer(line):
        if len(out) >= rule.max_matches_per_line:
            break
        secret, span = _candidate_group(match, rule.secret_group)
        if not rule.secret_usable(secret):
            continue
        out.append(
            _Candidate(
                rule=rule,
                line_no=line_no,
                column=span[0] + 1,
                end_column=span[1],
                secret=secret,
                secret_span=span,
                redact_span=span,
            )
        )
    return out


def _pem_candidate(
    rule: Rule, lines: Sequence[str], index: int
) -> Optional[_Candidate]:
    line = lines[index]
    start = rule.regex.search(line)
    if not start:
        return None
    last = min(len(lines) - 1, index + rule.max_block_lines)
    end_index = index
    terminated = False
    for probe in range(index + 1, last + 1):
        end_index = probe
        if rule.end_regex and rule.end_regex.search(lines[probe]):
            terminated = True
            break
    body = "\n".join(lines[index + 1 : end_index])
    if not terminated:
        # An unterminated private-key header is still a strong signal.
        body = body or line
    truncated = not terminated and end_index >= last
    if terminated and not rule.secret_usable(body.strip()):
        return None
    return _Candidate(
        rule=rule,
        line_no=index + 1,
        column=start.start() + 1,
        end_column=start.end(),
        secret=body.strip() if body.strip() else line,
        secret_span=(start.start(), start.end()),
        redact_span=(start.start(), start.end()),
        block=True,
        block_start=index,
        block_end=end_index,
        terminated=terminated and not truncated,
    )


def _resolve_overlaps(candidates: List[_Candidate]) -> List[_Candidate]:
    """Keep the most specific/highest-priority detector for overlapping bytes.

    Losers are not reported as duplicate findings; the winner records their rule
    ids in ``overlaps`` so the UI can explain why only one result appears.
    """
    ranked = sorted(
        candidates,
        key=lambda cand: (
            -cand.rule.priority,
            -SEVERITY_WEIGHT.get(cand.rule.severity, 0),
            -cand.specificity,
            cand.rule.id,
        ),
    )
    winners: List[_Candidate] = []
    for cand in ranked:
        clash = [
            other
            for other in winners
            if max(other.overlap_key[0], cand.overlap_key[0])
            < min(other.overlap_key[1], cand.overlap_key[1])
        ]
        if clash:
            for other in clash:
                other_overlaps = getattr(other, "_overlaps", None)
                if other_overlaps is None:
                    other_overlaps = set()
                    setattr(other, "_overlaps", other_overlaps)
                other_overlaps.add(cand.rule.id)
            continue
        winners.append(cand)
    return winners


def _scan_text(
    text: str, rel_path: str, rules: Sequence[Rule], options: ScanOptions
) -> Tuple[List[Dict[str, object]], int, int]:
    lines = text.splitlines()
    findings: List[Dict[str, object]] = []
    truncated_lines = 0
    consumed_until = 0

    for index, line in enumerate(lines):
        if index < consumed_until:
            continue
        line_no = index + 1
        scan_line = line
        if len(scan_line) > options.max_line_chars:
            scan_line = scan_line[: options.max_line_chars]
            truncated_lines += 1

        candidates: List[_Candidate] = []
        for rule in rules:
            if not rule.path_allowed(rel_path):
                continue
            if rule.kind == "pem_block":
                pem = _pem_candidate(rule, lines, index)
                if pem is not None:
                    candidates.append(pem)
                continue
            candidates.extend(_line_candidates(rule, scan_line, line_no))

        if not candidates:
            continue

        winners = _resolve_overlaps(candidates)
        # Redact every match on this line, not only the winners, so a losing
        # overlapping match can never leak through the winner's preview.
        redaction_spans = [cand.redact_span for cand in candidates if not cand.block]
        for winner in winners:
            if winner.block:
                preview = clean_preview(
                    redact_spans(scan_line, [winner.redact_span])
                    + " … [私钥内容已遮蔽]"
                )
                redacted_line = redact_spans(scan_line, [winner.redact_span])
                consumed_until = max(consumed_until, winner.block_end + 1)
            else:
                redacted_line = redact_spans(scan_line, redaction_spans)
                preview = clean_preview(redacted_line)
            overlaps = sorted(getattr(winner, "_overlaps", set()))
            findings.append(
                {
                    "rule_id": winner.rule.id,
                    "family": winner.rule.family,
                    "severity": winner.rule.severity,
                    "rule_version": winner.rule.version,
                    "rule_semantic_hash": winner.rule.semantic_hash,
                    "path": rel_path,
                    "line": winner.line_no,
                    "column": winner.column,
                    "end_column": winner.end_column,
                    "preview": preview,
                    "context_hash": context_digest(redacted_line),
                    "secret_length": len(winner.secret),
                    "secret_entropy": round(shannon_entropy(winner.secret), 3),
                    "block": winner.block,
                    "block_line_count": (
                        winner.block_end - winner.block_start + 1 if winner.block else 1
                    ),
                    "terminated": winner.terminated,
                    "overlaps": overlaps,
                    "_secret": winner.secret,
                }
            )
    return findings, len(lines), truncated_lines


def scan_project(
    project_root: str,
    rule_set: RuleSet,
    options: Optional[ScanOptions] = None,
    progress: Optional[Callable[[int, int, int, int, int], None]] = None,
) -> ScanOutput:
    options = options or ScanOptions()
    root_abs = os.path.abspath(project_root)
    if not os.path.isdir(root_abs):
        raise NotADirectoryError("项目目录不存在或不可访问")
    rules = rule_set.ordered_rules
    to_scan, skipped, files_seen = discover_files(root_abs, options)
    findings: List[Dict[str, object]] = []
    inspected_paths: Set[str] = set()
    bytes_read = 0
    total_lines = 0
    truncated_files = 0
    total = len(to_scan)

    for position, rel_path in enumerate(to_scan, start=1):
        abs_path = os.path.join(root_abs, rel_path)
        try:
            with open(abs_path, "rb") as handle:
                data = handle.read(options.max_file_bytes + 1)
        except OSError as exc:
            skipped.append(SkippedFile(rel_path, "unreadable", 0, safe_message(exc)))
            continue
        if len(data) > options.max_file_bytes:
            skipped.append(SkippedFile(rel_path, "too_large", len(data), ""))
            continue
        bytes_read += len(data)
        if _is_probably_binary(data[:BINARY_SAMPLE_BYTES]):
            skipped.append(SkippedFile(rel_path, "binary", len(data), ""))
            continue
        text = _decode(data)
        del data
        if text is None:
            skipped.append(SkippedFile(rel_path, "binary", 0, "无法按文本编码解码"))
            continue
        file_findings, line_count, truncated_lines = _scan_text(
            text, rel_path, rules, options
        )
        del text
        inspected_paths.add(rel_path)
        total_lines += line_count
        if truncated_lines:
            truncated_files += 1
            skipped.append(
                SkippedFile(
                    rel_path,
                    "line_limit",
                    0,
                    "有 %s 行超过 %s 字符，超长部分未扫描"
                    % (truncated_lines, options.max_line_chars),
                )
            )
        findings.extend(file_findings)
        if progress is not None and (position % 25 == 0 or position == total):
            progress(position, total, len(inspected_paths), len(skipped), total_lines)

    skipped.sort(key=lambda item: (item.path, item.reason))
    return ScanOutput(
        root=root_abs,
        findings=findings,
        skipped=skipped,
        inspected_paths=inspected_paths,
        files_seen=files_seen,
        files_inspected=len(inspected_paths),
        bytes_read=bytes_read,
        line_count=total_lines,
        truncated_line_files=truncated_files,
        ruleset_version=rule_set.version,
    )
