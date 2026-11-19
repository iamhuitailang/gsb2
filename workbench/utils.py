"""Small shared helpers: time handling, path guards, redaction and hashing."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
from datetime import datetime, timezone
from typing import Any, Iterable, List, Sequence, Tuple

UTC = timezone.utc

REDACTION = "[REDACTED]"
_MAX_PREVIEW_CHARS = 240
_MAX_CONTEXT_CHARS = 1000
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def utc_now() -> datetime:
    return datetime.now(UTC).replace(microsecond=0)


def to_iso(value: datetime) -> str:
    return value.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def from_iso(text: str) -> datetime:
    if not text:
        raise ValueError("empty timestamp")
    cleaned = text.strip()
    if cleaned.endswith("Z"):
        cleaned = cleaned[:-1] + "+00:00"
    parsed = datetime.fromisoformat(cleaned)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC).replace(microsecond=0)


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", "surrogatepass")).hexdigest()


def hmac_hex(key: bytes, value: str) -> str:
    return hmac.new(key, value.encode("utf-8", "surrogatepass"), hashlib.sha256).hexdigest()


def merge_spans(spans: Iterable[Tuple[int, int]], length: int) -> List[Tuple[int, int]]:
    """Clamp and merge overlapping/adjacent match spans so nested rules redact once."""
    cleaned = []
    for start, end in spans:
        start = max(0, min(int(start), length))
        end = max(0, min(int(end), length))
        if end > start:
            cleaned.append((start, end))
    cleaned.sort()
    merged: List[Tuple[int, int]] = []
    for start, end in cleaned:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def redact_spans(line: str, spans: Sequence[Tuple[int, int]], placeholder: str = REDACTION) -> str:
    """Replace every sensitive span in a line. Unknown spans are ignored."""
    merged = merge_spans(spans, len(line))
    if not merged:
        return line
    parts: List[str] = []
    cursor = 0
    for start, end in merged:
        parts.append(line[cursor:start])
        parts.append(placeholder)
        cursor = end
    parts.append(line[cursor:])
    return "".join(parts)


def clean_preview(redacted_line: str, limit: int = _MAX_PREVIEW_CHARS) -> str:
    """Turn a redacted line into a short, single-line, control-character-free preview."""
    text = _CONTROL_RE.sub(" ", redacted_line.replace("\t", " ")).strip()
    if len(text) > limit:
        text = text[:limit].rstrip() + "…"
    return text


def context_digest(redacted_line: str) -> str:
    """A whitespace-normalised digest of the redacted line.

    It deliberately excludes file paths and line numbers: moving a file or
    inserting lines above it must not change the identity of a finding.
    """
    normalised = re.sub(r"\s+", " ", redacted_line).strip()[:_MAX_CONTEXT_CHARS]
    return hashlib.sha256(normalised.encode("utf-8", "surrogatepass")).hexdigest()[:32]


def is_within(root_real: str, candidate_real: str) -> bool:
    try:
        return os.path.commonpath([os.path.abspath(root_real), os.path.abspath(candidate_real)]) == os.path.abspath(root_real)
    except ValueError:
        return False


def safe_message(exc: BaseException) -> str:
    """Error text for logs/UI. Callers must not include file contents in exceptions."""
    message = str(exc).strip().replace("\n", " ")
    if len(message) > 300:
        message = message[:300] + "…"
    return "%s: %s" % (exc.__class__.__name__, message) if message else exc.__class__.__name__


def clamp_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(parsed, maximum))
