"""导入、并发、原子切换与恢复的集成测试。"""

from __future__ import annotations

import json
import sqlite3

import pytest

from app.db import Database, VersionConflict
from app.main import create_app
from app.samples import read_sample
from app.service import PolicyService, parse_submission


def payload(text: str, **overrides) -> dict:
    body = {
        "document_text": text,
        "source_note": "集成测试来源",
        "base_generation": 0,
    }
    body.update(overrides)
    return body


class _Submission:
    """轻量构造 ParsedSubmission，用于直接调用服务层。"""

    def __init__(self, document, source_note, base_generation, confirm_digest):
        self.document = document
        self.source_note = source_note
        self.base_generation = base_generation
        self.confirm_digest = confirm_digest


def post_json(client, url: str, body: dict):
    return client.post(url, content=json.dumps(body), headers={"Content-Type": "application/json"})


def preview_then_apply(client, text: str, *, source_note: str = "集成测试来源", generation: int | None = None):
    base = client.get("/api/state").json()["generation"]
    body = payload(
        text,
        source_note=source_note,
        base_generation=base if generation is None else generation,
    )
    preview = post_json(client, "/api/import/preview", body)
    assert preview.status_code == 200, preview.text
    apply_body = dict(body, confirm_digest=preview.json()["digest"])
    return post_json(client, "/api/import/apply", apply_body)


BASELINE = lambda: read_sample("01-valid-baseline.json")["text"]
CHANGED = lambda: read_sample("02-valid-changed.json")["text"]


# --------------------------------------------------------------- 基本流


def test_initial_state_is_empty(client) -> None:
    state = client.get("/api/state").json()
    assert state["active_version"] is None
    assert state["generation"] == 0
    assert state["document"] is None


def test_preview_does_not_change_active_version(client) -> None:
    response = post_json(client, "/api/import/preview", payload(BASELINE()))
    assert response.status_code == 200
    body = response.json()
    assert body["applied"] is False
    assert body["stage"] == "preview"
    assert body["summary"]["rule_count"] == 3
    state = client.get("/api/state").json()
    assert state["active_version"] is None
    assert state["generation"] == 0


def test_preview_reports_diff_against_active(client) -> None:
    applied = preview_then_apply(client, BASELINE())
    assert applied.status_code == 200
    preview = post_json(client, "/api/import/preview", payload(CHANGED()))
    diff = preview.json()["diff"]
    assert [item["id"] for item in diff["added"]] == ["allow-ops-ssh"]
    assert [item["id"] for item in diff["removed"]] == ["deny-admin-from-office"]


def test_apply_requires_confirmation_digest(client) -> None:
    body = payload(BASELINE())
    response = post_json(client, "/api/import/apply", body)
    assert response.status_code == 409
    assert response.json()["code"] == "confirmation_required"
    assert client.get("/api/state").json()["active_version"] is None


def test_apply_rejects_mismatched_digest(client) -> None:
    body = payload(BASELINE(), confirm_digest="0" * 64)
    response = post_json(client, "/api/import/apply", body)
    assert response.status_code == 409
    assert response.json()["code"] == "confirmation_mismatch"
    assert client.get("/api/state").json()["active_version"] is None


def test_apply_requires_source_note(client) -> None:
    base = client.get("/api/state").json()["generation"]
    preview = post_json(client, "/api/import/preview", payload(BASELINE(), base_generation=base))
    response = post_json(
        client,
        "/api/import/apply",
        payload(
            BASELINE(),
            source_note="",
            base_generation=base,
            confirm_digest=preview.json()["digest"],
        ),
    )
    assert response.status_code == 400
    assert response.json()["code"] == "missing_source_note"
    assert client.get("/api/state").json()["generation"] == 0


def test_successful_apply_creates_version_and_audit(client) -> None:
    response = preview_then_apply(client, BASELINE(), source_note="来自变更单 #1")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["applied"] is True
    assert body["generation"] == 1
    assert body["version"]["version_no"] == 1

    state = client.get("/api/state").json()
    assert state["active_version"]["version_no"] == 1
    assert state["document"]["package"]["id"] == "baseline-office"

    history = client.get("/api/history").json()
    assert len(history["versions"]) == 1
    applied_audit = [a for a in history["audit"] if a["outcome"] == "applied"]
    assert len(applied_audit) == 1
    assert applied_audit[0]["source_note"] == "来自变更单 #1"
    assert applied_audit[0]["version_no"] == 1
    assert applied_audit[0]["action"] == "apply"


def test_rejected_import_is_audited_but_does_not_change_active(client) -> None:
    preview_then_apply(client, BASELINE())
    before = client.get("/api/state").json()

    bad = read_sample("13-reject-conflict.json")["text"]
    response = post_json(client, "/api/import/preview", payload(bad))
    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation_failed"
    assert body["issues"]
    assert any(issue["code"] == "conflicting_rules" for issue in body["issues"])

    after = client.get("/api/state").json()
    assert after["generation"] == before["generation"]
    assert after["active_version"] == before["active_version"]

    # 预览是只读检查，不写审计；正式应用的失败才写审计。
    history = client.get("/api/history").json()
    assert [a["outcome"] for a in history["audit"]] == ["applied"]

    apply_response = post_json(
        client,
        "/api/import/apply",
        payload(bad, confirm_digest="x"),
    )
    assert apply_response.status_code == 422
    history = client.get("/api/history").json()
    assert any(a["outcome"] == "rejected" for a in history["audit"])
    rejected = next(a for a in history["audit"] if a["outcome"] == "rejected")
    assert rejected["source_note"] == "集成测试来源"
    assert rejected["code"] == "validation_failed"
    assert rejected["at"]


def test_preview_validation_failure_has_located_reasons(client) -> None:
    response = post_json(client, "/api/import/preview", payload(read_sample("17-reject-semantic.json")["text"]))
    assert response.status_code == 422
    body = response.json()
    paths = {issue["path"] for issue in body["issues"]}
    assert "$.rules[0].source_cidrs[0]" in paths
    assert all(issue["message"] for issue in body["issues"])


def test_duplicate_key_is_rejected_before_schema_validation(client) -> None:
    response = post_json(client, "/api/import/preview", payload(read_sample("10-reject-duplicate-key.json")["text"]))
    assert response.status_code == 400
    body = response.json()
    assert body["code"] == "invalid_json"
    assert body["details"]["code"] == "duplicate_key"
    assert body["details"]["path"] == "$.rules[0].action"


def test_oversize_document_rejected(client) -> None:
    response = post_json(client, "/api/import/preview", payload(read_sample("16-reject-oversize.json")["text"]))
    assert response.status_code == 400
    assert response.json()["details"]["code"] == "document_too_large"
    assert client.get("/api/state").json()["generation"] == 0


def test_deep_nesting_rejected(client) -> None:
    response = post_json(client, "/api/import/preview", payload(read_sample("15-reject-deep-nesting.json")["text"]))
    assert response.status_code == 400
    assert response.json()["details"]["code"] == "depth_exceeded"


def test_oversize_http_body_rejected(client) -> None:
    from app.config import MAX_REQUEST_BYTES

    huge = "x" * (MAX_REQUEST_BYTES + 10)
    response = client.post(
        "/api/import/preview",
        content=huge,
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 413
    assert response.json()["code"] == "request_too_large"


def test_unknown_envelope_field_rejected(client) -> None:
    body = payload(BASELINE())
    body["auto_apply"] = True
    response = post_json(client, "/api/import/preview", body)
    assert response.status_code == 400
    assert response.json()["code"] == "unknown_envelope_field"


def test_apply_requires_base_generation(client) -> None:
    base = client.get("/api/state").json()["generation"]
    preview = post_json(client, "/api/import/preview", payload(BASELINE()))
    response = post_json(
        client,
        "/api/import/apply",
        {
            "document_text": BASELINE(),
            "source_note": "缺少版本号",
            "confirm_digest": preview.json()["digest"],
        },
    )
    assert response.status_code == 400
    assert response.json()["code"] == "missing_base_generation"
    assert client.get("/api/state").json()["generation"] == base


def test_apply_rejects_content_changed_after_preview(client) -> None:
    preview = post_json(client, "/api/import/preview", payload(BASELINE()))
    digest = preview.json()["digest"]
    tampered = json.loads(BASELINE())
    tampered["rules"][0]["action"] = "deny"
    response = post_json(
        client,
        "/api/import/apply",
        payload(json.dumps(tampered), confirm_digest=digest),
    )
    assert response.status_code == 409
    assert response.json()["code"] == "confirmation_mismatch"
    assert client.get("/api/state").json()["active_version"] is None


def test_restore_requires_source_note(client) -> None:
    preview_then_apply(client, BASELINE())
    versions = client.get("/api/history").json()["versions"]
    v1 = versions[0]
    body = client.get(f"/api/versions/{v1['id']}/restore-preview").json()
    response = client.post(
        f"/api/versions/{v1['id']}/restore",
        content=json.dumps(
            {
                "source_note": "",
                "base_generation": body["base_generation"],
                "confirm_digest": body["digest"],
            }
        ),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 400
    assert response.json()["code"] == "missing_source_note"
    assert client.get("/api/state").json()["generation"] == 1


def test_static_assets_and_health_are_served(client) -> None:
    assert client.get("/api/health").json()["ok"] is True
    index = client.get("/")
    assert index.status_code == 200
    assert "本地安全策略管理台" in index.text
    assert client.get("/styles.css").status_code == 200
    assert client.get("/app.js").status_code == 200


def test_invalid_json_body_is_rejected(client) -> None:
    response = client.post(
        "/api/import/preview",
        content='{"document_text": "{}", "source_note": "x", "source_note": "y"}',
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 400
    assert response.json()["details"]["code"] == "duplicate_key"


# --------------------------------------------------------------- 并发


def test_stale_generation_is_rejected_and_active_intact(client) -> None:
    assert preview_then_apply(client, BASELINE()).status_code == 200
    # 第二个客户端仍以为 generation=0，先预览拿到 digest。
    stale_preview = post_json(client, "/api/import/preview", payload(CHANGED(), base_generation=0))
    digest = stale_preview.json()["digest"]
    response = post_json(
        client,
        "/api/import/apply",
        payload(CHANGED(), base_generation=0, confirm_digest=digest),
    )
    assert response.status_code == 409
    assert response.json()["code"] == "stale_generation"
    state = client.get("/api/state").json()
    assert state["generation"] == 1
    assert state["active_version"]["version_no"] == 1
    history = client.get("/api/history").json()
    assert any(a["code"] == "stale_generation" for a in history["audit"])


def test_service_detects_concurrent_write_between_preview_and_apply(db: Database) -> None:
    service = PolicyService(db)
    submission = parse_submission(json.dumps(payload(CHANGED())).encode())
    preview = service.preview(submission)
    digest = preview["digest"]

    # 另一个写入者抢先提交（模拟并发）。
    other = parse_submission(json.dumps(payload(BASELINE(), base_generation=0)).encode())
    other_preview = service.preview(other)
    service.apply(_Submission(other.document, other.source_note, 0, other_preview["digest"]))

    from app.service import ServiceError

    with pytest.raises(ServiceError) as info:
        service.apply(
            _Submission(submission.document, submission.source_note, 0, digest)
        )
    assert info.value.code == "stale_generation"
    assert db.get_active_state()["generation"] == 1
    assert db.get_active_document()["package"]["id"] == "baseline-office"


def test_failed_write_keeps_previous_version(db: Database, monkeypatch) -> None:
    service = PolicyService(db)
    first = parse_submission(json.dumps(payload(BASELINE())).encode())
    first_preview = service.preview(first)
    service.apply(_Submission(first.document, first.source_note, 0, first_preview["digest"]))
    before = db.get_active_state()
    before_document = db.get_active_document()

    def explode(self, **kwargs):
        # 在同一个事务里先写版本行，再模拟写入中断：必须整体回滚。
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO policy_versions (version_no, digest, package_id, "
                "package_name, schema_version, document, source_kind, "
                "source_note, origin_version_id, created_at) "
                "VALUES (999, 'partial', 'p', 'n', '1.0', '{}', 'import', 'x', NULL, 'now')"
            )
            conn.execute(
                "INSERT INTO active_state (singleton, version_id, generation, updated_at) "
                "VALUES (1, 999, 42, 'now') "
                "ON CONFLICT(singleton) DO UPDATE SET version_id = 999, generation = 42"
            )
            raise sqlite3.OperationalError("模拟磁盘写入中断")

    monkeypatch.setattr(Database, "apply_version", explode)

    second = parse_submission(
        json.dumps(payload(CHANGED(), base_generation=1)).encode()
    )
    second_preview = service.preview(second)
    with pytest.raises(sqlite3.OperationalError):
        service.apply(
            _Submission(
                second.document, second.source_note, 1, second_preview["digest"]
            )
        )
    monkeypatch.undo()

    after = db.get_active_state()
    assert after["generation"] == before["generation"]
    assert after["version_id"] == before["version_id"]
    assert db.get_active_document() == before_document
    assert db.count_versions() == 1


def test_transaction_rolls_back_partial_insert(db: Database) -> None:
    """在事务中插入版本后抛错，版本表与激活指针都不应留下痕迹。"""

    with pytest.raises(RuntimeError):
        with db.transaction() as conn:
            conn.execute(
                "INSERT INTO policy_versions (version_no, digest, package_id, "
                "package_name, schema_version, document, source_kind, "
                "source_note, origin_version_id, created_at) "
                "VALUES (99, 'x', 'p', 'n', '1.0', '{}', 'import', 'note', NULL, 'now')"
            )
            conn.execute(
                "INSERT INTO active_state (singleton, version_id, generation, updated_at) "
                "VALUES (1, 99, 9, 'now')"
            )
            raise RuntimeError("boom")

    assert db.count_versions() == 0
    assert db.get_active_state()["generation"] == 0
    assert db.get_active_state()["version_id"] is None


def test_generation_increments_monotonically(client) -> None:
    preview_then_apply(client, BASELINE())
    preview_then_apply(client, CHANGED())
    versions = client.get("/api/history").json()["versions"]
    assert [v["version_no"] for v in versions] == [2, 1]
    assert client.get("/api/state").json()["generation"] == 2


# --------------------------------------------------------------- 恢复


def test_restore_requires_preview_digest_and_creates_new_version(client) -> None:
    preview_then_apply(client, BASELINE())
    preview_then_apply(client, CHANGED())
    versions = client.get("/api/history").json()["versions"]
    v1 = next(v for v in versions if v["version_no"] == 1)

    restore_preview = client.get(f"/api/versions/{v1['id']}/restore-preview")
    assert restore_preview.status_code == 200
    body = restore_preview.json()
    assert body["applied"] is False
    assert [item["id"] for item in body["diff"]["added"]] == ["deny-admin-from-office"]

    bad = client.post(
        f"/api/versions/{v1['id']}/restore",
        content=json.dumps({"source_note": "回滚", "base_generation": 2, "confirm_digest": "bad"}),
        headers={"Content-Type": "application/json"},
    )
    assert bad.status_code == 409
    assert client.get("/api/state").json()["generation"] == 2

    good = client.post(
        f"/api/versions/{v1['id']}/restore",
        content=json.dumps(
            {
                "source_note": "回滚到基线",
                "base_generation": body["base_generation"],
                "confirm_digest": body["digest"],
            }
        ),
        headers={"Content-Type": "application/json"},
    )
    assert good.status_code == 200, good.text
    result = good.json()
    assert result["restored_from"] == v1["id"]
    assert result["version"]["version_no"] == 3
    assert result["version"]["source_kind"] == "restore"

    active = client.get("/api/state").json()
    assert active["active_version"]["version_no"] == 3
    assert active["document"] == client.get(f"/api/versions/{v1['id']}").json()["document"]

    history = client.get("/api/history").json()
    restore_audit = [
        a for a in history["audit"]
        if a["action"] == "restore" and a["outcome"] == "applied"
    ]
    assert len(restore_audit) == 1
    assert restore_audit[0]["source_note"] == "回滚到基线"
    assert restore_audit[0]["version_no"] == 3

    # 之前用错误摘要尝试恢复也应留下拒绝记录。
    rejected_restore = [
        a for a in history["audit"]
        if a["action"] == "restore" and a["outcome"] == "rejected"
    ]
    assert rejected_restore and rejected_restore[0]["code"] == "confirmation_mismatch"


def test_restore_rejects_stale_generation(client) -> None:
    preview_then_apply(client, BASELINE())
    versions = client.get("/api/history").json()["versions"]
    v1 = versions[0]
    body = client.get(f"/api/versions/{v1['id']}/restore-preview").json()
    preview_then_apply(client, CHANGED())
    response = client.post(
        f"/api/versions/{v1['id']}/restore",
        content=json.dumps(
            {
                "source_note": "并发恢复",
                "base_generation": body["base_generation"],
                "confirm_digest": body["digest"],
            }
        ),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 409
    assert response.json()["code"] == "stale_generation"
    assert client.get("/api/state").json()["generation"] == 2


def test_restore_unknown_version_returns_404(client) -> None:
    assert client.get("/api/versions/999/restore-preview").status_code == 404
    response = client.post(
        "/api/versions/999/restore",
        content=json.dumps({"source_note": "x", "base_generation": 0, "confirm_digest": "y"}),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 404


def test_missing_version_document_is_not_partially_applied(client) -> None:
    preview_then_apply(client, BASELINE())
    assert client.get("/api/versions/12345").status_code == 404
    assert client.get("/api/state").json()["generation"] == 1


# --------------------------------------------------------------- 样例


def test_samples_endpoint_lists_valid_and_reject_cases(client) -> None:
    samples = client.get("/api/samples").json()["samples"]
    assert len(samples) >= 8
    kinds = {sample["kind"] for sample in samples}
    assert kinds == {"valid", "reject"}
    assert all(sample["available"] for sample in samples)


def test_sample_detail_and_path_traversal_guard(client) -> None:
    detail = client.get("/api/samples/01-valid-baseline.json").json()
    assert detail["title"] == "基线策略包"
    assert "schema_version" in detail["text"]
    assert client.get("/api/samples/..%2F..%2Fetc%2Fpasswd").status_code in {400, 404}
    assert client.get("/api/samples/missing.json").status_code == 404


def test_every_sample_is_usable(client) -> None:
    for sample in client.get("/api/samples").json()["samples"]:
        detail = client.get(f"/api/samples/{sample['filename']}").json()
        response = post_json(client, "/api/import/preview", payload(detail["text"]))
        if sample["kind"] == "reject":
            assert response.status_code in {400, 413, 422}, sample["filename"]
        else:
            assert response.status_code == 200, sample["filename"]
