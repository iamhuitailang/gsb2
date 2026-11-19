"""告警筛选结果导出：规则版本、判断依据、证据事件编号与原始事件内容一并落盘。"""
from __future__ import annotations

import json
import sqlite3
from typing import Any

from . import storage


def build_export_payload(conn: sqlite3.Connection, alerts: list[sqlite3.Row]) -> dict[str, Any]:
    exported_alerts: list[dict[str, Any]] = []
    for alert in alerts:
        evidence = []
        for ev in storage.alert_evidence(conn, alert["id"]):
            evidence.append({
                "event_pk": ev["id"],
                "source": ev["source"],
                "event_id": ev["event_id"],          # 证据事件编号
                "event_time": ev["event_time"],
                "evidence_role": ev["evidence_role"],
                "normalized": json.loads(ev["normalized"]),
                "raw_record": json.loads(ev["raw_line"]),  # 原始事件内容，可与页面逐条核对
            })
        exported_alerts.append({
            "alert_id": alert["id"],
            "rule_id": alert["rule_id"],
            "rule_version": alert["rule_version"],   # 规则版本
            "severity": alert["severity"],
            "status": alert["status"],
            "status_label": storage.STATUS_LABEL[alert["status"]],
            "disposition_note": alert["disposition_note"],
            "summary": alert["summary"],
            "rationale": alert["rationale"],         # 告警判断（关联依据）
            "scope_key": alert["scope_key"],
            "involved_sources": json.loads(alert["involved_sources"]),
            "involved_subjects": json.loads(alert["involved_subjects"]),
            "involved_targets": json.loads(alert["involved_targets"]),
            "first_event_time": alert["first_event_time"],
            "last_event_time": alert["last_event_time"],
            "evidence": evidence,                    # 按事件时间升序
        })

    return {
        "exported_at": storage.now_iso(),
        "engine_rule_version": storage.RULE_VERSION,
        "alert_count": len(exported_alerts),
        "alerts": exported_alerts,
    }


def to_json_text(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2)


def to_jsonl_text(payload: dict[str, Any]) -> str:
    """JSONL 形式：每行一条告警，便于按行核对。"""
    lines = [json.dumps(a, ensure_ascii=False, separators=(",", ":"))
             for a in payload["alerts"]]
    return "\n".join(lines) + ("\n" if lines else "")
