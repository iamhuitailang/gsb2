"""Built-in request samples used by the console and for manual smoke tests.

Samples are generated live so their timestamps are fresh.  Each sample carries
everything a caller needs: method, path, query, body, the four signing headers,
the canonical string and a ready-to-run curl command.  None of them include
secret material.
"""

from __future__ import annotations

import secrets
from typing import Any

from .canonical import build_canonical
from .config import Settings, utc_now
from .verifier import compute_signature

JSON_BODIES = {
    "demo-json": '{"note":"local interface smoke test","tags":["signature","nonce"]}',
    "unicode": '{"msg":"空格与中文字段","empty":""}',
}


def new_nonce() -> str:
    return secrets.token_hex(16)


def _sign(
    settings: Settings,
    *,
    method: str,
    path: str,
    query: str,
    body: str,
    nonce: str,
    key_id: str | None = None,
) -> dict[str, Any] | None:
    key = settings.key_by_id(key_id) if key_id else settings.active_key()
    if key is None:
        return None
    canonical = build_canonical(
        method=method,
        path=path,
        query=query,
        timestamp=int(utc_now().timestamp()),
        nonce=nonce,
        key_id=key.key_id,
        body=body.encode("utf-8"),
    )
    signature = compute_signature(key.secret, canonical.canonical_string)
    return {
        "key_id": key.key_id,
        "key_status": key.effective_status(utc_now()),
        "timestamp": canonical.timestamp,
        "nonce": canonical.nonce,
        "signature": signature,
        "canonical_string": canonical.canonical_string,
        "headers": {
            "X-Key-Id": key.key_id,
            "X-Timestamp": str(canonical.timestamp),
            "X-Nonce": canonical.nonce,
            "X-Signature": signature,
        },
    }


def sample_curl(method: str, path: str, query: str, body: str, headers: dict[str, str]) -> str:
    """A copy-pasteable command against the local demo server."""
    url = f"http://127.0.0.1:8000{path}"
    if query:
        url += f"?{query}"
    lines = [f"curl -X {method} '{url}'"]
    for name, value in headers.items():
        lines.append(f"-H '{name}: {value}'")
    if body:
        lines.append("-H 'Content-Type: application/json'")
        lines.append("--data-raw '" + body.replace("'", "'\\''") + "'")
    return " \\\n  ".join(lines)


def build_samples(settings: Settings) -> list[dict[str, Any]]:
    raw = [
        {
            "id": "ping-get",
            "title": "GET 空请求体",
            "description": "最精简的校验请求：无 query、空请求体，body hash 使用空字节的 SHA-256。",
            "method": "GET",
            "path": "/api/demo/ping",
            "query": "",
            "body": "",
        },
        {
            "id": "echo-get",
            "title": "GET 带 query（乱序与重复参数）",
            "description": "query 会按规范化顺序排序；本样例故意打乱顺序并包含重复参数与空值。",
            "method": "GET",
            "path": "/api/demo/echo",
            "query": "z=last&a=1&a=2&empty=&spaced=hello%20world",
            "body": "",
        },
        {
            "id": "echo-post-json",
            "title": "POST JSON 请求体",
            "description": "请求体按原始 UTF-8 字节计算 SHA-256，不解析 JSON、不重排字段。",
            "method": "POST",
            "path": "/api/demo/echo",
            "query": "source=console",
            "body": JSON_BODIES["demo-json"],
        },
        {
            "id": "echo-post-empty",
            "title": "POST 空请求体",
            "description": "空请求体仍然计算哈希并参与签名，避免空 body 被当作无字段处理。",
            "method": "POST",
            "path": "/api/demo/echo",
            "query": "",
            "body": "",
        },
        {
            "id": "echo-post-unicode",
            "title": "POST 含中文与空串字段",
            "description": "字段顺序保持请求体原样；中文按 UTF-8 编码参与 body hash。",
            "method": "POST",
            "path": "/api/demo/echo",
            "query": "",
            "body": JSON_BODIES["unicode"],
        },
    ]

    active = settings.active_key()
    grace = next(
        (k for k in settings.keys if k.effective_status(utc_now()) == "grace"), None
    )

    samples: list[dict[str, Any]] = []
    for item in raw:
        payload = _sign(
            settings,
            method=item["method"],
            path=item["path"],
            query=item["query"],
            body=item["body"],
            nonce=new_nonce(),
        )
        if payload is None:
            continue
        samples.append({**item, "signing": payload})

    # A rotation sample: show the grace key still verifying while it is valid.
    if grace is not None and active is not None and grace.key_id != active.key_id:
        payload = _sign(
            settings,
            method="GET",
            path="/api/demo/ping",
            query="",
            body="",
            nonce=new_nonce(),
            key_id=grace.key_id,
        )
        if payload is not None:
            samples.append(
                {
                    "id": "grace-key",
                    "title": "轮换宽限期使用旧密钥",
                    "description": "旧密钥在 grace_until 之前仍可验签；超过时间点后自动按退役处理。",
                    "method": "GET",
                    "path": "/api/demo/ping",
                    "query": "",
                    "body": "",
                    "signing": payload,
                }
            )

    for sample in samples:
        sample["curl"] = sample_curl(
            sample["method"],
            sample["path"],
            sample["query"],
            sample["body"],
            sample["signing"]["headers"],
        )
    return samples


__all__ = ["build_samples", "new_nonce", "sample_curl"]
