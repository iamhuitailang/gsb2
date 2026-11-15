"""采集侧 HTTP 客户端：真实记录请求/响应时间，处理 429 等待时间。"""
import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass


@dataclass
class FetchResult:
    ok: bool
    status_code: int | None
    request_at: float
    response_at: float
    data: dict | None = None
    retry_after: float | None = None
    error: str | None = None


def fetch_page(base_url, source_id, venue_id, date, page_no, timeout=10):
    url = (
        f"{base_url}/reservations?"
        + urllib.parse.urlencode({"venue_id": venue_id, "date": date, "page": page_no})
    )
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    request_at = _now()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode()
            response_at = _now()
            return FetchResult(
                ok=True,
                status_code=resp.status,
                request_at=request_at,
                response_at=response_at,
                data=json.loads(body),
            )
    except urllib.error.HTTPError as e:
        response_at = _now()
        body = e.read().decode()
        retry_after = None
        try:
            payload = json.loads(body)
            retry_after = payload.get("retry_after_seconds")
        except (json.JSONDecodeError, ValueError):
            payload = None
        # 优先采用响应头里的 Retry-After，其次用响应体
        header_val = e.headers.get("Retry-After") if e.headers else None
        if header_val:
            try:
                retry_after = float(header_val)
            except ValueError:
                pass
        if e.code == 429:
            return FetchResult(
                ok=False, status_code=429, request_at=request_at,
                response_at=response_at, retry_after=retry_after or 5,
                error=(payload or {}).get("message", "rate limited"),
            )
        return FetchResult(
            ok=False, status_code=e.code, request_at=request_at,
            response_at=response_at, error=f"HTTP {e.code}: {body[:200]}",
        )
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return FetchResult(
            ok=False, status_code=None, request_at=request_at,
            response_at=_now(), error=f"request failed: {e}",
        )


def admin_post(base_url, path, timeout=5):
    req = urllib.request.Request(f"{base_url}{path}", method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def admin_get(base_url, path, timeout=5):
    with urllib.request.urlopen(f"{base_url}{path}", timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _now():
    import time
    return time.time()
