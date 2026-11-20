"""导入编排：严格解析 → 校验 → 差异 → 原子应用/回滚/审计。

关键不变量
----------
* 预览和正式应用走同一条校验流水线，浏览器校验不参与信任决策。
* 正式应用必须携带预览时返回的 ``confirm_digest``，否则视为“用户尚未
  确认当前内容”，直接拒绝。这样确认过的内容与写入的内容逐字节一致。
* 任何失败都不会触碰激活指针；被拒绝的导入会写一条 ``rejected`` 审计。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .config import MAX_DOCUMENT_BYTES, MAX_REQUEST_BYTES, MAX_SOURCE_NOTE_LEN
from .db import Database, VersionConflict
from .models import (
    ValidationResult,
    diff_documents,
    digest_of,
    pretty_dumps,
    validate_document,
)
from .strict_json import JsonInputError, loads_strict


class ServiceError(Exception):
    """带 HTTP 状态和结构化原因的业务错误。"""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        details: Any = None,
        issues: list[dict[str, Any]] | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details
        self.issues = issues or []
        self.extra = extra or {}

    def payload(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "ok": False,
            "code": self.code,
            "message": self.message,
        }
        if self.issues:
            data["issues"] = self.issues
        if self.details is not None:
            data["details"] = self.details
        data.update(self.extra)
        return data


@dataclass
class ParsedSubmission:
    document: Any
    source_note: str
    base_generation: int | None
    confirm_digest: str | None


def _normalize_source_note(value: Any) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ServiceError(
            400, "invalid_source_note", "来源说明必须是字符串"
        )
    note = value.strip()
    if len(note) > MAX_SOURCE_NOTE_LEN:
        raise ServiceError(
            400,
            "source_note_too_long",
            f"来源说明不能超过 {MAX_SOURCE_NOTE_LEN} 个字符",
        )
    return note


def _optional_int(value: Any, field: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ServiceError(400, "invalid_field", f"{field} 必须是非负整数")
    return value


def parse_document_bytes(raw: bytes) -> Any:
    """直接严格解析一份策略文档（CLI 等场景），不做请求封装。"""

    try:
        return loads_strict(raw, max_bytes=MAX_DOCUMENT_BYTES)
    except JsonInputError as exc:
        raise ServiceError(
            400,
            "invalid_json",
            "策略包不是合法的 JSON",
            details=exc.as_detail(),
        ) from exc


def parse_submission(raw_body: bytes) -> ParsedSubmission:
    """严格解析请求封装；重复键、未知字段、类型错误都不会被接受。"""

    try:
        # 外层封装里的 document_text 可以接近文档体积上限，因此单独放宽
        # 字符串长度限制；真正的文档限制在二次解析时按字节强制。
        envelope = loads_strict(
            raw_body,
            max_bytes=MAX_REQUEST_BYTES,
            max_string_bytes=MAX_REQUEST_BYTES,
        )
    except JsonInputError as exc:
        raise ServiceError(
            400,
            "invalid_json",
            "请求不是合法的 JSON",
            details=exc.as_detail(),
        ) from exc

    if not isinstance(envelope, dict):
        raise ServiceError(400, "invalid_envelope", "请求体必须是 JSON 对象")
    allowed = {
        "document_text",
        "source_note",
        "base_generation",
        "confirm_digest",
    }
    unknown = sorted(set(envelope) - allowed)
    if unknown:
        raise ServiceError(
            400,
            "unknown_envelope_field",
            f"请求包含未知字段：{', '.join(unknown)}",
        )

    if "document_text" not in envelope:
        raise ServiceError(
            400, "missing_document", "缺少 document_text 字段（策略包 JSON 文本）"
        )
    text = envelope["document_text"]
    if not isinstance(text, str):
        raise ServiceError(
            400, "invalid_document_text", "document_text 必须是字符串"
        )
    try:
        document = loads_strict(text, max_bytes=MAX_DOCUMENT_BYTES)
    except JsonInputError as exc:
        raise ServiceError(
            400,
            "invalid_json",
            "策略包不是合法的 JSON",
            details=exc.as_detail(),
        ) from exc

    source_note = _normalize_source_note(envelope.get("source_note"))
    base_generation = _optional_int(
        envelope.get("base_generation"), "base_generation"
    )
    confirm_digest = envelope.get("confirm_digest")
    if confirm_digest is not None and not isinstance(confirm_digest, str):
        raise ServiceError(400, "invalid_field", "confirm_digest 必须是字符串")

    return ParsedSubmission(
        document=document,
        source_note=source_note,
        base_generation=base_generation,
        confirm_digest=confirm_digest,
    )


class PolicyService:
    def __init__(self, db: Database) -> None:
        self.db = db

    # ------------------------------------------------------------ state

    def state(self) -> dict[str, Any]:
        active_state = self.db.get_active_state()
        active_meta = (
            self.db.get_version_meta(active_state["version_id"])
            if active_state["version_id"] is not None
            else None
        )
        document = self.db.get_active_document()
        return {
            "generation": active_state["generation"],
            "updated_at": active_state["updated_at"],
            "active_version": active_meta,
            "document": document,
            "rule_count": len(document["rules"]) if document else 0,
            "version_count": self.db.count_versions(),
            "audit_count": self.db.audit_count(),
        }

    # ---------------------------------------------------------- preview

    def preview(self, submission: ParsedSubmission) -> dict[str, Any]:
        """纯只读预览：不写库、不改变生效版本。

        预览失败同样不写审计——预览不是一次导入，只有正式应用/恢复的
        成功与失败才进入审计历史，避免历史被试错噪音淹没。
        """

        result = validate_document(submission.document)
        active_document = self.db.get_active_document()
        payload = self._validation_payload(result, active_document)

        if not result.ok:
            raise ServiceError(
                422,
                "validation_failed",
                f"策略包校验未通过，共 {result.error_total} 个错误",
                issues=[issue.as_dict() for issue in result.issues],
                extra={k: v for k, v in payload.items() if k not in {"ok", "issues"}},
            )

        payload["ok"] = True
        payload["stage"] = "preview"
        payload["applied"] = False
        payload["warnings"] = [issue.as_dict() for issue in result.warnings]
        payload["base_generation"] = self.db.get_active_state()["generation"]
        return payload

    # ------------------------------------------------------------ apply

    def apply(self, submission: ParsedSubmission) -> dict[str, Any]:
        if submission.base_generation is None:
            self._reject_apply(
                submission,
                "missing_base_generation",
                "缺少 base_generation：正式应用必须声明所基于的版本，用于并发保护",
                {},
                status=400,
            )
        if len(submission.source_note) < 2:
            self._reject_apply(
                submission,
                "missing_source_note",
                "请填写来源说明（至少 2 个字符），用于审计追溯",
                {},
                status=400,
            )

        result = validate_document(submission.document)
        if not result.ok:
            self._reject_apply(
                submission,
                "validation_failed",
                f"策略包校验未通过，共 {result.error_total} 个错误",
                {"issues": [issue.as_dict() for issue in result.issues]},
            )
        normalized = result.normalized
        digest = result.digest
        if normalized is None or digest is None:
            self._reject_apply(
                submission,
                "validation_failed",
                "策略包未能生成规范化结果",
                {},
            )

        if not submission.confirm_digest:
            self._reject_apply(
                submission,
                "confirmation_required",
                "缺少确认摘要：请先预览，再使用预览返回的 digest 正式应用",
                {},
            )
        if submission.confirm_digest != digest:
            self._reject_apply(
                submission,
                "confirmation_mismatch",
                "确认摘要与当前内容不一致：内容可能在预览后被修改，请重新预览",
                {
                    "expected": submission.confirm_digest,
                    "actual": digest,
                },
            )

        active_document = self.db.get_active_document()
        diff = diff_documents(active_document, normalized)

        try:
            applied = self.db.apply_version(
                document=normalized,
                digest=digest,
                source_kind="import",
                source_note=submission.source_note,
                origin_version_id=None,
                base_generation=submission.base_generation,
                operation="apply",
                details={
                    "diff_summary": diff["summary"],
                    "warnings": [issue.as_dict() for issue in result.warnings],
                    "rule_count": len(normalized["rules"]),
                },
            )
        except VersionConflict as exc:
            self.db.record_rejection(
                action="apply",
                source_note=submission.source_note,
                code="stale_generation",
                message=str(exc),
                details={
                    "expected_generation": exc.expected,
                    "actual_generation": exc.actual,
                },
                base_generation=submission.base_generation,
            )
            raise ServiceError(
                409,
                "stale_generation",
                "策略已被其他操作修改，当前生效版本未改变；请刷新后重新预览",
                details={
                    "expected_generation": exc.expected,
                    "actual_generation": exc.actual,
                },
            ) from exc

        return {
            "ok": True,
            "stage": "applied",
            "applied": True,
            "digest": digest,
            "generation": applied["generation"],
            "version": self.db.get_version_meta(applied["version_id"]),
            "diff": diff,
            "warnings": [issue.as_dict() for issue in result.warnings],
            "rule_count": len(normalized["rules"]),
        }

    def _reject_apply(
        self,
        submission: ParsedSubmission,
        code: str,
        message: str,
        details: dict[str, Any],
        *,
        status: int | None = None,
    ) -> None:
        self.db.record_rejection(
            action="apply",
            source_note=submission.source_note,
            code=code,
            message=message,
            details=details or None,
            base_generation=submission.base_generation,
        )
        issues = details.get("issues") if isinstance(details, dict) else None
        if status is None:
            status = 422 if code == "validation_failed" else 409
        raise ServiceError(
            status,
            code,
            message,
            issues=issues if isinstance(issues, list) else None,
            details={k: v for k, v in details.items() if k != "issues"} or None,
        )

    # ---------------------------------------------------------- versions

    def history(self, *, audit_limit: int = 100, version_limit: int = 100) -> dict[str, Any]:
        return {
            "versions": self.db.list_versions(version_limit),
            "audit": self.db.list_audit(audit_limit),
            "active": self.db.get_active_state(),
        }

    def version_detail(self, version_id: int) -> dict[str, Any]:
        version = self.db.get_version(version_id)
        if version is None:
            raise ServiceError(404, "version_not_found", "找不到该策略版本")
        active_document = self.db.get_active_document()
        current_meta = (
            self.db.get_version_meta(self.db.get_active_state()["version_id"])
            if self.db.get_active_state()["version_id"] is not None
            else None
        )
        version["diff_to_active"] = diff_documents(
            active_document, version["document"]
        )
        version["is_active"] = (
            current_meta is not None and current_meta["id"] == version_id
        )
        return version

    def preview_restore(self, version_id: int) -> dict[str, Any]:
        version = self.db.get_version(version_id)
        if version is None:
            raise ServiceError(404, "version_not_found", "找不到该策略版本")
        active_document = self.db.get_active_document()
        document = version["document"]
        result = validate_document(document)
        if not result.ok or result.normalized is None:
            # 已存版本理论上不会失效，但版本切换前仍重新校验，避免旧数据带病回流。
            raise ServiceError(
                422,
                "stored_version_invalid",
                "该历史版本未能通过当前校验，不能恢复",
                issues=[issue.as_dict() for issue in result.issues],
            )
        return {
            "ok": True,
            "stage": "restore_preview",
            "applied": False,
            "version": {
                key: version[key]
                for key in (
                    "id",
                    "version_no",
                    "digest",
                    "package_id",
                    "package_name",
                    "created_at",
                    "source_kind",
                    "source_note",
                )
            }
            | {"rule_count": len(version["document"].get("rules", []))},
            "digest": result.digest,
            "rule_count": len(result.normalized["rules"]),
            "base_generation": self.db.get_active_state()["generation"],
            "diff": diff_documents(active_document, result.normalized),
            "warnings": [issue.as_dict() for issue in result.warnings],
            "document": result.normalized,
            "document_text": pretty_dumps(result.normalized),
        }

    def restore(
        self,
        version_id: int,
        *,
        source_note: str,
        base_generation: int | None,
        confirm_digest: str | None,
    ) -> dict[str, Any]:
        version = self.db.get_version(version_id)
        if version is None:
            raise ServiceError(404, "version_not_found", "找不到该策略版本")
        active_document = self.db.get_active_document()
        result = validate_document(version["document"])
        if not result.ok or result.normalized is None or result.digest is None:
            raise ServiceError(
                422,
                "stored_version_invalid",
                "该历史版本未能通过当前校验，不能恢复",
                issues=[issue.as_dict() for issue in result.issues],
            )
        normalized = result.normalized
        digest = result.digest
        if base_generation is None or len(source_note.strip()) < 2:
            code = (
                "missing_base_generation"
                if base_generation is None
                else "missing_source_note"
            )
            message = (
                "缺少 base_generation：恢复操作必须声明所基于的版本，用于并发保护"
                if base_generation is None
                else "请填写恢复来源说明（至少 2 个字符），用于审计追溯"
            )
            self.db.record_rejection(
                action="restore",
                source_note=source_note,
                code=code,
                message=message,
                details={"version_id": version_id},
                base_generation=base_generation,
                version_id=version_id,
                version_no=version["version_no"],
            )
            raise ServiceError(400, code, message)
        if not confirm_digest or confirm_digest != digest:
            self.db.record_rejection(
                action="restore",
                source_note=source_note,
                code="confirmation_mismatch",
                message="恢复操作缺少或使用了不匹配的确认摘要",
                details={
                    "version_id": version_id,
                    "expected": confirm_digest,
                    "actual": digest,
                },
                base_generation=base_generation,
                version_id=version_id,
                version_no=version["version_no"],
            )
            raise ServiceError(
                409,
                "confirmation_mismatch",
                "恢复确认摘要不匹配：请重新预览该版本后再确认",
                details={"actual": digest},
            )

        diff = diff_documents(active_document, normalized)
        try:
            applied = self.db.apply_version(
                document=normalized,
                digest=digest,
                source_kind="restore",
                source_note=source_note,
                origin_version_id=version_id,
                base_generation=base_generation,
                operation="restore",
                details={
                    "restored_from_version_id": version_id,
                    "restored_from_version_no": version["version_no"],
                    "diff_summary": diff["summary"],
                },
            )
        except VersionConflict as exc:
            self.db.record_rejection(
                action="restore",
                source_note=source_note,
                code="stale_generation",
                message=str(exc),
                details={
                    "expected_generation": exc.expected,
                    "actual_generation": exc.actual,
                    "version_id": version_id,
                },
                base_generation=base_generation,
                version_id=version_id,
                version_no=version["version_no"],
            )
            raise ServiceError(
                409,
                "stale_generation",
                "策略已被其他操作修改，当前生效版本未改变；请刷新后重试",
                details={
                    "expected_generation": exc.expected,
                    "actual_generation": exc.actual,
                },
            ) from exc

        return {
            "ok": True,
            "stage": "restored",
            "applied": True,
            "restored_from": version_id,
            "restored_from_version_no": version["version_no"],
            "digest": digest,
            "generation": applied["generation"],
            "version": self.db.get_version_meta(applied["version_id"]),
            "diff": diff,
            "warnings": [issue.as_dict() for issue in result.warnings],
            "rule_count": len(normalized["rules"]),
        }

    # ------------------------------------------------------------ utils

    def _validation_payload(
        self,
        result: ValidationResult,
        active_document: dict[str, Any] | None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "ok": result.ok,
            "issues": [issue.as_dict() for issue in result.issues],
            "summary": result.summary(),
            "digest": result.digest,
            "normalized": result.normalized,
            "active_digest": digest_of(active_document) if active_document else None,
            "diff": None,
            "document_text": None,
        }
        if result.normalized is not None:
            payload["diff"] = diff_documents(active_document, result.normalized)
            payload["document_text"] = pretty_dumps(result.normalized)
        return payload


def summarize_document(document: dict[str, Any] | None) -> dict[str, Any]:
    if document is None:
        return {"rule_count": 0, "package": None}
    return {
        "rule_count": len(document.get("rules", [])),
        "package": document.get("package"),
        "digest": digest_of(document),
    }
