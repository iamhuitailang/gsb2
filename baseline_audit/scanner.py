"""只读基线扫描器。

输入一个已解析为真实路径的根目录，输出：
- findings：发现项（稳定 id、规则、风险等级、相对路径、可复核证据、判断理由）
- notices：三类问题（read_error / parse_error / tool_error）

扫描过程不修改任何文件、不执行任何程序；敏感值在写入发现项之前统一遮蔽。
"""

from __future__ import annotations

import hashlib
import os
import stat

from . import config_parser, masking, rules, walker
from .errors import PARSE_ERROR, READ_ERROR, TOOL_ERROR

MAX_FILE_SIZE = 1 * 1024 * 1024  # 1 MiB，超过则跳过内容分析并记录

# 即使规则目录不认识，也尝试按文本读取的后缀（用于暴露解析/编码失败）
TEXT_LIKE_SUFFIXES = (
    ".conf", ".cfg", ".config", ".ini", ".env", ".txt", ".md",
    ".service", ".properties", ".yaml", ".yml", ".json", ".toml", ".key", ".pem",
)


def _finding_id(rule_id: str, rel: str, aspect: str) -> str:
    """稳定身份：规则 + 相对路径 + 规则内维度（不含行号、不含值）。"""
    raw = f"{rule_id}\x1f{rel}\x1f{aspect}"
    return "F-" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _change_fingerprint(parts: list[str]) -> str:
    return "fp-" + hashlib.sha1("\x1f".join(parts).encode("utf-8")).hexdigest()[:16]


def _mode_string(mode: int) -> str:
    return stat.filemode(mode) + f" ({oct(stat.S_IMODE(mode))})"


def _is_sensitive_name(rel: str) -> bool:
    name = rel.rsplit("/", 1)[-1].lower()
    if any(frag in name for frag in rules.SENSITIVE_NAME_FRAGMENTS):
        return True
    return any(name.endswith(suffix) for suffix in rules.SENSITIVE_NAME_SUFFIXES)


def _make_finding(rule_id, rel, aspect, reason, evidence, change_parts):
    rule = rules.get_rule(rule_id)
    return {
        "id": _finding_id(rule_id, rel, aspect),
        "rule_id": rule_id,
        "severity": rule["severity"],
        "title": rule["title"],
        "rationale": rule["rationale"],
        "remediation": rule["remediation"],
        "rel_path": rel,
        "aspect": aspect,
        "reason": reason,
        "evidence": evidence,
        "change_fingerprint": _change_fingerprint(change_parts),
    }


# ---------------- 权限检查 ----------------

def _permission_findings(entry: dict) -> list[dict]:
    st: os.stat_result = entry["st"]
    mode = st.st_mode
    rel = entry["rel"] or "."
    is_dir = entry["kind"] == "dir"
    perm = stat.S_IMODE(mode)
    out: list[dict] = []

    if mode & stat.S_IWOTH:
        if is_dir:
            if not (mode & stat.S_ISVTX):
                out.append(
                    _make_finding(
                        "PERM-WORLD-WRITABLE-DIR",
                        rel,
                        "mode",
                        f"目录权限 {_mode_string(mode)}：other 拥有写位且未设置粘滞位。",
                        {"mode": _mode_string(mode)},
                        [str(perm)],
                    )
                )
        else:
            out.append(
                _make_finding(
                    "PERM-WORLD-WRITABLE-FILE",
                    rel,
                    "mode",
                    f"文件权限 {_mode_string(mode)}：other 拥有写位，任何本地用户均可修改。",
                    {"mode": _mode_string(mode)},
                    [str(perm)],
                )
            )

    if not is_dir and mode & stat.S_ISUID:
        out.append(
            _make_finding(
                "PERM-SETUID", rel, "mode",
                f"文件设置了 setuid 位：{_mode_string(mode)}。",
                {"mode": _mode_string(mode)}, [str(perm)],
            )
        )
    if not is_dir and mode & stat.S_ISGID:
        out.append(
            _make_finding(
                "PERM-SETGID", rel, "mode",
                f"文件设置了 setgid 位：{_mode_string(mode)}。",
                {"mode": _mode_string(mode)}, [str(perm)],
            )
        )

    if mode & stat.S_IROTH and _is_sensitive_name(rel):
        out.append(
            _make_finding(
                "PERM-SENSITIVE-WORLD-READABLE",
                rel,
                "mode",
                f"敏感文件名且 other 拥有读位：{_mode_string(mode)}。",
                {"mode": _mode_string(mode)},
                [str(perm)],
            )
        )

    if not is_dir and (mode & stat.S_IWGRP) and config_parser.profile_for(rel) is not None:
        out.append(
            _make_finding(
                "PERM-GROUP-WRITABLE-CONFIG",
                rel,
                "mode",
                f"配置文件 group 拥有写位：{_mode_string(mode)}。",
                {"mode": _mode_string(mode)},
                [str(perm)],
            )
        )

    return out


# ---------------- 服务配置检查 ----------------

def _directive_findings(rel: str, profile: str, parsed: list[dict]) -> list[dict]:
    out: list[dict] = []

    def add(rule_id, aspect, reason, evidence, change_parts, item):
        out.append(
            _make_finding(
                rule_id, rel, aspect, reason,
                {**evidence, "lineno": item["lineno"],
                 "redacted_line": masking.redact_line(
                     (item["directive"] + " " + item["args"]).strip()
                 )},
                change_parts,
            )
        )

    for item in parsed:
        directive = item["directive"]
        args = item["args"]
        low = directive.lower()
        arg_low = args.lower()

        if profile == "sshd":
            if low == "permitrootlogin" and arg_low in ("yes", "prohibit-password"):
                add(
                    "SVC-SSHD-PERMIT-ROOT-LOGIN", f"line:{item['lineno']}",
                    f"sshd 配置 PermitRootLogin {args}，允许 root 直接登录。",
                    {"directive": directive, "value_masked": args},
                    [directive, args], item,
                )
            if low == "passwordauthentication" and arg_low == "yes":
                add(
                    "SVC-SSHD-PASSWORD-AUTH", f"line:{item['lineno']}",
                    "sshd 配置 PasswordAuthentication yes，启用了口令认证。",
                    {"directive": directive, "value_masked": args},
                    [directive, args], item,
                )

        if profile == "nginx" and low == "listen" and ("443" not in args and "ssl" not in arg_low):
            add(
                "SVC-NGINX-HTTP-LISTEN", f"line:{item['lineno']}",
                f"nginx listen {args} 为明文 HTTP 监听。",
                {"directive": directive, "value_masked": args},
                [directive, args], item,
            )

        if profile == "apache" and low == "listen" and "443" not in args:
            add(
                "SVC-APACHE-HTTP-LISTEN", f"line:{item['lineno']}",
                f"Apache Listen {args} 为明文 HTTP 监听。",
                {"directive": directive, "value_masked": args},
                [directive, args], item,
            )

        if profile == "systemd" and (item.get("section") or "") == "[Service]":
            if low == "user" and arg_low in ("root", "0"):
                add(
                    "SVC-SYSTEMD-ROOT-USER", f"line:{item['lineno']}",
                    f"systemd 服务 User={args}，以 root 身份运行。",
                    {"directive": directive, "value_masked": args},
                    [directive, args], item,
                )

        if "0.0.0.0" in args:
            add(
                "SVC-INSECURE-BIND-ALL", f"line:{item['lineno']}",
                f"指令 {directive} 绑定 0.0.0.0，对所有网卡暴露。",
                {"directive": directive, "value_masked": "0.0.0.0"},
                [directive, args], item,
            )

    return out


def _secret_findings(rel: str, text: str) -> list[dict]:
    """逐行扫描明文凭据；只记录键名、行号、值指纹与遮蔽行。"""
    out: list[dict] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        hits = masking.scan_line(line)
        for hit in hits:
            aspect = f"{hit['kind']}:{hit['key']}"
            out.append(
                _make_finding(
                    "SVC-PLAINTEXT-SECRET", rel, aspect,
                    f"第 {lineno} 行包含疑似明文凭据（{hit['key']}），内容已遮蔽。",
                    {
                        "lineno": lineno,
                        "secret_kind": hit["kind"],
                        "key_name": hit["key"],
                        "value_fingerprint": hit["value_fingerprint"],
                        "redacted_line": masking.redact_line(line),
                    },
                    [hit["kind"], hit["key"], hit["value_fingerprint"]],
                )
            )
    return out


def _systemd_exec_findings(
    rel: str, profile: str, parsed: list[dict], entry_by_realpath: dict,
    root_real: str,
) -> list[dict]:
    """检查 systemd ExecStart 启动路径的可写权限（只检查根目录内的目标）。"""
    if profile != "systemd":
        return []
    out: list[dict] = []
    for item in parsed:
        if item["directive"].lower() != "execstart":
            continue
        tokens = item["args"].split()
        if not tokens:
            continue
        exec_path = tokens[0]
        if not os.path.isabs(exec_path):
            continue
        # 先按真实绝对路径找；找不到再尝试把它当作核查根内的绝对路径映射。
        # 两种前缀形式（/var 与 /private/var）都尝试，避免符号链接前缀差异。
        target = entry_by_realpath.get(os.path.realpath(exec_path))
        if target is None:
            candidate = os.path.normpath(os.path.join(root_real, exec_path.lstrip("/")))
            target = entry_by_realpath.get(candidate)
            if target is None:
                target = entry_by_realpath.get(os.path.realpath(candidate))
        if target is None:
            # 目标在选定目录之外或不存在：不越界检查，也不臆测结论
            continue
        mode = target["st"].st_mode
        if mode & (stat.S_IWGRP | stat.S_IWOTH):
            out.append(
                _make_finding(
                    "SVC-SYSTEMD-WRITABLE-EXEC",
                    rel,
                    f"exec:{exec_path}",
                    f"ExecStart 指向 {exec_path}（根内映射 {target['rel']}），其权限 "
                    f"{_mode_string(mode)} 允许组或其他用户写入。",
                    {
                        "lineno": item["lineno"],
                        "exec_rel_path": target["rel"],
                        "mode": _mode_string(mode),
                        "redacted_line": masking.redact_line(
                            (item["directive"] + " " + item["args"]).strip()
                        ),
                    },
                    [exec_path, str(stat.S_IMODE(mode))],
                )
            )
    return out


# ---------------- 扫描入口 ----------------

def scan(root_real: str, excluded_realpaths: set[str] | None = None) -> dict:
    entries, notices = walker.walk(root_real, excluded_realpaths)
    findings: list[dict] = []
    entry_by_realpath = {e["abs"]: e for e in entries if e.get("st") is not None}

    for entry in entries:
        kind = entry["kind"]

        if kind == "symlink":
            # 链接本身的 777 权限是平台常态，不做权限判定；目标不跟随
            continue
        if kind == "other":
            continue

        try:
            findings.extend(_permission_findings(entry))
        except Exception as exc:  # 单条失败不影响整体结果
            notices.append(
                {"category": TOOL_ERROR, "code": "permission_check_failed",
                 "rel": entry["rel"] or ".", "detail": f"权限检查异常：{type(exc).__name__}"}
            )

        if kind != "file":
            continue

        rel = entry["rel"]
        profile = config_parser.profile_for(rel)
        lower_name = rel.rsplit("/", 1)[-1].lower()
        text_like = profile is not None or _is_sensitive_name(rel) or (
            lower_name.endswith(TEXT_LIKE_SUFFIXES)
        )
        if not text_like:
            continue

        size = entry["st"].st_size
        if size > MAX_FILE_SIZE:
            notices.append(
                {"category": PARSE_ERROR, "code": "file_too_large", "rel": rel,
                 "detail": f"文件 {size} 字节超过 {MAX_FILE_SIZE} 字节上限，跳过内容分析。"}
            )
            continue

        try:
            with open(entry["abs"], "rb") as handle:
                raw = handle.read(MAX_FILE_SIZE + 1)
        except OSError as exc:
            notices.append(
                {"category": READ_ERROR, "code": "read_failed", "rel": rel,
                 "detail": f"文件内容无法读取：{type(exc).__name__}"}
            )
            continue

        if b"\x00" in raw:
            notices.append(
                {"category": PARSE_ERROR, "code": "binary_file", "rel": rel,
                 "detail": "疑似二进制文件，跳过配置解析与凭据扫描。"}
            )
            continue

        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            notices.append(
                {"category": PARSE_ERROR, "code": "decode_failed", "rel": rel,
                 "detail": "文件不是有效的 UTF-8 文本，跳过配置解析。"}
            )
            continue

        # 凭据扫描适用于所有文本类配置/敏感文件，先做遮蔽再做结构化判断
        try:
            findings.extend(_secret_findings(rel, text))
        except Exception as exc:
            notices.append(
                {"category": TOOL_ERROR, "code": "secret_scan_failed", "rel": rel,
                 "detail": f"凭据扫描异常：{type(exc).__name__}"}
            )

        if profile is None:
            continue

        try:
            parsed = config_parser.parse(text, profile)
        except config_parser.ConfigParseError as exc:
            notices.append(
                {"category": PARSE_ERROR, "code": "parse_failed", "rel": rel,
                 "detail": f"配置解析失败（{profile}）：{type(exc).__name__}"}
            )
            continue

        try:
            findings.extend(_directive_findings(rel, profile, parsed))
            findings.extend(
                _systemd_exec_findings(rel, profile, parsed, entry_by_realpath, root_real)
            )
        except Exception as exc:
            notices.append(
                {"category": TOOL_ERROR, "code": "config_check_failed", "rel": rel,
                 "detail": f"配置规则检查异常：{type(exc).__name__}"}
            )

    return {
        "findings": findings,
        "notices": notices,
        "stats": {
            "entries_scanned": len(entries),
            "findings_total": len(findings),
            "notices_total": len(notices),
            "by_severity": {
                sev: sum(1 for f in findings if f["severity"] == sev)
                for sev in rules.SEVERITIES
            },
        },
    }
