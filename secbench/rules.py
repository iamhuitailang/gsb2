"""关联检测规则引擎。

三类可解释规则（均要求跨事件的时间关联，单条普通失败不会告警）：

* ``R1_BRUTE_FORCE`` 同一来源地址在时间窗口内对多个账号连续认证失败，随后成功登录
* ``R2_PROBE_THEN_ACCESS`` 可疑路径探测后，同一来源出现相关服务端访问或异常
* ``R3_CROSS_IP_EXPORT`` 同一账号登录后短时间内从不同来源地址执行敏感数据导出

每次导入后全量重评估：新证据并入既有告警（保留处置状态），新告警自动登记。
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from . import storage

RULES_META = {
    "R1_BRUTE_FORCE": {
        "name": "多账号认证失败后成功登录（撞库/暴力破解）",
        "severity": "high",
    },
    "R2_PROBE_THEN_ACCESS": {
        "name": "可疑路径探测后同源相关访问或异常",
        "severity": "medium",
    },
    "R3_CROSS_IP_EXPORT": {
        "name": "登录后跨来源地址敏感数据导出",
        "severity": "high",
    },
}

SENSITIVE_PATH_KEYWORDS = ("/admin", "/config", "/backup", "/.env", "/api/internal")
SERVER_ERROR_PREFIX = ("5",)
EXPORT_ACTIONS = {"bulk_export", "data_export", "file_download"}


@dataclass
class Candidate:
    rule_id: str
    scope_key: str
    summary: str
    rationale: str
    evidence: dict[int, str] = field(default_factory=dict)  # event pk -> 证据角色

    def add(self, pk: int, role: str) -> None:
        # 同一事件在时间线中只出现一次，保留最先赋予的角色
        self.evidence.setdefault(pk, role)


def _parse_ts(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def _is_probe(row: sqlite3.Row) -> bool:
    if row["source"] != "proxy":
        return False
    action = (row["action"] or "").lower()
    target = (row["target"] or "").lower()
    result = (row["result"] or "").lower()
    if action == "path_scan":
        return True
    if action in ("get", "probe") and result == "404":
        return True
    if any(k in target for k in ("/.git", "/wp-admin", "/phpmyadmin", "/actuator")):
        return True
    return False


def _is_sensitive_followup(row: sqlite3.Row) -> bool:
    if row["source"] != "proxy" or _is_probe(row):
        return False
    target = (row["target"] or "").lower()
    result = str(row["result"] or "")
    if any(k in target for k in SENSITIVE_PATH_KEYWORDS):
        return True
    if result.startswith(SERVER_ERROR_PREFIX):
        return True
    return False


def detect_r1(rows: list[sqlite3.Row], settings: dict[str, Any]) -> list[Candidate]:
    """规则一：同 IP 窗口内 >= N 个不同账号认证失败，且随后成功登录。"""
    fail_threshold = int(settings["r1_fail_threshold"])
    fail_window = timedelta(seconds=int(settings["r1_window_seconds"]))
    success_window = timedelta(seconds=int(settings["r1_success_window_seconds"]))

    by_ip: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        if row["source"] == "auth" and row["action"] == "login":
            by_ip.setdefault(row["src_ip"], []).append(row)

    out: list[Candidate] = []
    for ip, events in by_ip.items():
        events = sorted(events, key=lambda r: (_parse_ts(r["event_time"]), r["id"]))
        successes = [e for e in events if (e["result"] or "").lower() == "success"]
        for success in successes:
            t_success = _parse_ts(success["event_time"])
            window_start = t_success - fail_window
            failures = [
                e for e in events
                if (e["result"] or "").lower() in ("failure", "fail", "denied")
                and window_start <= _parse_ts(e["event_time"]) <= t_success
            ]
            distinct_accounts = {e["subject"] for e in failures}
            if len(distinct_accounts) < fail_threshold:
                continue
            # 末次失败与成功登录之间的间隔也必须在成功窗口内
            latest_fail = max(_parse_ts(e["event_time"]) for e in failures)
            if t_success - latest_fail > success_window:
                continue
            scope = f"{ip}|{success['event_id']}"
            cand = Candidate(
                rule_id="R1_BRUTE_FORCE",
                scope_key=scope,
                summary=(
                    f"来源 {ip} 在 {fail_window.total_seconds():.0f}s 窗口内对 "
                    f"{len(distinct_accounts)} 个账号认证失败，随后账号 "
                    f"{success['subject']} 成功登录"
                ),
                rationale=(
                    f"关联依据：同一 src_ip={ip} 的 auth 登录事件中，"
                    f"{t_success - fail_window:%H:%M:%S} 至 {t_success:%H:%M:%S} 之间出现 "
                    f"{len(failures)} 次失败、涉及 {len(distinct_accounts)} 个不同账号"
                    f"（阈值 r1_fail_threshold={fail_threshold}，窗口 r1_window_seconds="
                    f"{int(fail_window.total_seconds())}）；末次失败到成功登录间隔 "
                    f"{(t_success - latest_fail).total_seconds():.0f}s（上限 "
                    f"r1_success_window_seconds={int(success_window.total_seconds())}）。"
                    f"单条失败不触发本规则。"
                ),
            )
            for e in failures:
                cand.add(e["id"], "认证失败")
            cand.add(success["id"], "成功登录")
            out.append(cand)
    return out


def detect_r2(rows: list[sqlite3.Row], settings: dict[str, Any]) -> list[Candidate]:
    """规则二：路径探测后，同 IP 在窗口内出现敏感路径访问或 5xx 异常。"""
    window = timedelta(seconds=int(settings["r2_window_seconds"]))
    by_ip: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        if row["source"] == "proxy":
            by_ip.setdefault(row["src_ip"], []).append(row)

    out: list[Candidate] = []
    for ip, events in by_ip.items():
        events = sorted(events, key=lambda r: (_parse_ts(r["event_time"]), r["id"]))
        probes = [e for e in events if _is_probe(e)]
        if not probes:
            continue
        followup_by_pk: dict[int, sqlite3.Row] = {}
        matched_probes: list[sqlite3.Row] = []
        for probe in probes:
            t0 = _parse_ts(probe["event_time"])
            followups = [
                e for e in events
                if _is_sensitive_followup(e)
                and t0 <= _parse_ts(e["event_time"]) <= t0 + window
            ]
            if followups:
                matched_probes.append(probe)
                for e in followups:
                    followup_by_pk.setdefault(e["id"], e)
        if not followup_by_pk:
            continue
        matched_followups = list(followup_by_pk.values())
        cand = Candidate(
            rule_id="R2_PROBE_THEN_ACCESS",
            scope_key=ip,
            summary=(
                f"来源 {ip} 发起 {len(matched_probes)} 次可疑路径探测，随后 "
                f"{window.total_seconds():.0f}s 内出现 {len(matched_followups)} 次"
                f"敏感路径访问或服务端异常"
            ),
            rationale=(
                f"关联依据：同一 src_ip={ip} 的 proxy 事件中，path_scan/404 探测之后 "
                f"{int(window.total_seconds())}s 内（r2_window_seconds）出现对 "
                f"{', '.join(SENSITIVE_PATH_KEYWORDS)} 等敏感路径的访问或 5xx 响应，"
                f"探测与后续访问按时间顺序关联；单独的 404 不触发本规则。"
            ),
        )
        for e in matched_probes:
            cand.add(e["id"], "路径探测")
        for e in matched_followups:
            cand.add(e["id"], "后续访问/异常")
        out.append(cand)
    return out


def detect_r3(rows: list[sqlite3.Row], settings: dict[str, Any]) -> list[Candidate]:
    """规则三：账号登录后窗口内，从与登录不同的来源地址执行敏感数据导出。"""
    window = timedelta(seconds=int(settings["r3_window_seconds"]))
    logins: dict[str, list[sqlite3.Row]] = {}
    exports_by_subject: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        if row["source"] == "auth" and row["action"] == "login" \
                and (row["result"] or "").lower() == "success":
            logins.setdefault(row["subject"], []).append(row)
        if row["source"] == "endpoint" and (row["action"] or "").lower() in EXPORT_ACTIONS:
            exports_by_subject.setdefault(row["subject"], []).append(row)

    out: list[Candidate] = []
    for subject, login_events in logins.items():
        exports = exports_by_subject.get(subject, [])
        if not exports:
            continue
        for login in sorted(login_events, key=lambda r: (_parse_ts(r["event_time"]), r["id"])):
            t_login = _parse_ts(login["event_time"])
            cross_exports = [
                e for e in exports
                if t_login <= _parse_ts(e["event_time"]) <= t_login + window
                and e["src_ip"] != login["src_ip"]
            ]
            if not cross_exports:
                continue
            other_ips = sorted({e["src_ip"] for e in cross_exports})
            cand = Candidate(
                rule_id="R3_CROSS_IP_EXPORT",
                scope_key=f"{subject}|{login['event_id']}",
                summary=(
                    f"账号 {subject} 从 {login['src_ip']} 登录后 "
                    f"{window.total_seconds():.0f}s 内，在 {len(other_ips)} 个不同来源地址"
                    f"（{', '.join(other_ips)}）执行敏感数据导出"
                ),
                rationale=(
                    f"关联依据：auth 成功登录（src_ip={login['src_ip']}）之后 "
                    f"{int(window.total_seconds())}s 内（r3_window_seconds），endpoint 出现"
                    f" subject={subject} 的 bulk_export/data_export/file_download 事件，"
                    f"且导出端 src_ip 与登录端不同（{', '.join(other_ips)}）。"
                    f"同源地址的导出不触发本规则。"
                ),
            )
            cand.add(login["id"], "成功登录")
            for e in cross_exports:
                cand.add(e["id"], "跨地址数据导出")
            out.append(cand)
    return out


def evaluate(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """全量重评估并对账告警表，返回本次评估后的告警摘要列表。"""
    settings = storage.get_settings(conn)
    rows = storage.all_event_rows(conn)
    candidates = detect_r1(rows, settings) + detect_r2(rows, settings) + detect_r3(rows, settings)
    return _reconcile(conn, candidates)


def _reconcile(conn: sqlite3.Connection, candidates: list[Candidate]) -> list[dict[str, Any]]:
    existing = {
        (r["rule_id"], r["scope_key"]): r
        for r in conn.execute("SELECT * FROM alerts").fetchall()
    }
    candidate_keys = {(c.rule_id, c.scope_key) for c in candidates}

    for cand in candidates:
        meta = RULES_META[cand.rule_id]
        placeholders = ",".join("?" * len(cand.evidence))
        full_rows = conn.execute(
            f"SELECT * FROM events WHERE id IN ({placeholders})",
            list(cand.evidence),
        ).fetchall()
        involved_sources = sorted({r["source"] for r in full_rows})
        involved_subjects = sorted({r["subject"] for r in full_rows if r["subject"]})
        involved_targets = sorted({r["target"] for r in full_rows if r["target"]})
        first_ts = min(r["event_time"] for r in full_rows)
        last_ts = max(r["event_time"] for r in full_rows)
        key = (cand.rule_id, cand.scope_key)
        old = existing.get(key)

        if old is None:
            cur = conn.execute(
                "INSERT INTO alerts(rule_id, rule_version, scope_key, severity, status, "
                "disposition_note, created_at, updated_at, rationale, summary, "
                "involved_sources, involved_subjects, involved_targets, "
                "first_event_time, last_event_time, superseded) "
                "VALUES (?,?,?,?, 'open', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
                (
                    cand.rule_id, storage.RULE_VERSION, cand.scope_key, meta["severity"],
                    storage.now_iso(), storage.now_iso(), cand.rationale, cand.summary,
                    json.dumps(involved_sources, ensure_ascii=False),
                    json.dumps(involved_subjects, ensure_ascii=False),
                    json.dumps(involved_targets, ensure_ascii=False),
                    first_ts, last_ts,
                ),
            )
            alert_id = int(cur.lastrowid)
        else:
            alert_id = old["id"]
            # 迟到事件只补齐时间线和汇总，绝不覆盖处置状态与说明；重新命中时取消失效标记
            conn.execute(
                "UPDATE alerts SET severity=?, updated_at=?, summary=?, involved_sources=?, "
                "involved_subjects=?, involved_targets=?, first_event_time=?, last_event_time=?, "
                "superseded=0 WHERE id=?",
                (
                    meta["severity"], storage.now_iso(), cand.summary,
                    json.dumps(involved_sources, ensure_ascii=False),
                    json.dumps(involved_subjects, ensure_ascii=False),
                    json.dumps(involved_targets, ensure_ascii=False),
                    first_ts, last_ts, alert_id,
                ),
            )
            conn.execute("DELETE FROM alert_events WHERE alert_id=?", (alert_id,))

        conn.executemany(
            "INSERT OR IGNORE INTO alert_events(alert_id, event_pk, evidence_role) VALUES (?, ?, ?)",
            [(alert_id, pk, role) for pk, role in cand.evidence.items()],
        )

    # 已不满足规则的历史告警标记失效并保留（审计需要），不自动删除
    stale = [key for key in existing if key not in candidate_keys]
    for key in stale:
        conn.execute(
            "UPDATE alerts SET superseded=1, updated_at=? WHERE id=?",
            (storage.now_iso(), existing[key]["id"]),
        )
    conn.commit()
    return [
        {"rule_id": k[0], "scope_key": k[1], "stale": True}
        for k in stale
    ]
