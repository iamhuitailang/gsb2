"""Core, framework-free rules for keyframed masks.

Both the browser editor and the local FFmpeg exporter rely on the same
semantics:

* all geometry is normalized to the source video frame;
* only two ordinary cover keyframes with no gap between them are interpolated;
* a gap (occlusion / leaving the frame) forces no mask;
* an interpolation interval crossing a gap holds the nearest known box on each
  side instead of sweeping through the absent portion.
"""

from __future__ import annotations

import math
import uuid
from typing import Any

EPS = 0.02  # seconds; tolerant of frame rounding


def new_id(prefix: str = "id") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def as_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def box_keys(box: dict[str, Any]) -> tuple[float, float, float, float]:
    return (
        as_float(box.get("x")),
        as_float(box.get("y")),
        as_float(box.get("w")),
        as_float(box.get("h")),
    )


def sorted_keyframes(target: dict[str, Any]) -> list[dict[str, Any]]:
    keys = [k for k in (target.get("keyframes") or []) if isinstance(k, dict)]
    return sorted(keys, key=lambda k: as_float(k.get("t")))


def active_gap(target: dict[str, Any], t: float) -> dict[str, Any] | None:
    for gap in target.get("gaps") or []:
        if not isinstance(gap, dict):
            continue
        start = as_float(gap.get("start"))
        end = as_float(gap.get("end"), start)
        if start - EPS <= t <= end + EPS:
            return gap
    return None


def _lerp_box(a: dict[str, Any], b: dict[str, Any], u: float) -> dict[str, float]:
    ax, ay, aw, ah = box_keys(a)
    bx, by, bw, bh = box_keys(b)
    return {
        "x": ax + (bx - ax) * u,
        "y": ay + (by - ay) * u,
        "w": aw + (bw - aw) * u,
        "h": ah + (bh - ah) * u,
        "mode": "interpolate",
    }


def _copy_box(key: dict[str, Any], mode: str) -> dict[str, Any]:
    x, y, w, h = box_keys(key)
    return {"x": x, "y": y, "w": w, "h": h, "mode": mode}


def box_at(target: dict[str, Any], t: float) -> dict[str, Any] | None:
    """Return the mask box at time *t*, or ``None`` when intentionally absent."""
    if active_gap(target, t) is not None:
        return None

    keys = sorted_keyframes(target)
    if not keys:
        return None

    # Exact / frame-rounded key hit.
    for key in keys:
        if abs(as_float(key.get("t")) - t) <= EPS:
            return _copy_box(key, "key")

    left: dict[str, Any] | None = None
    right: dict[str, Any] | None = None
    for key in keys:
        kt = as_float(key.get("t"))
        if kt < t - EPS:
            left = key
        elif kt > t + EPS and right is None:
            right = key
            break

    if left is None or right is None:
        # Deliberately do not extrapolate: an edge without a key is listed as a
        # missing-key segment instead of masking unrelated scenery.
        return None

    lt = as_float(left.get("t"))
    rt = as_float(right.get("t"))

    crossing_gap: dict[str, Any] | None = None
    for gap in target.get("gaps") or []:
        if not isinstance(gap, dict):
            continue
        gs = as_float(gap.get("start"))
        ge = as_float(gap.get("end"), gs)
        if ge > lt + EPS and gs < rt - EPS:
            crossing_gap = gap
            break

    if crossing_gap is not None:
        gs = as_float(crossing_gap.get("start"))
        ge = as_float(crossing_gap.get("end"), gs)
        if t < gs:
            return _copy_box(left, "hold-before-gap")
        if t > ge:
            return _copy_box(right, "hold-after-gap")
        return None

    if rt <= lt:
        return _copy_box(left, "key")
    u = clamp((t - lt) / (rt - lt), 0.0, 1.0)
    return _lerp_box(left, right, u)


def box_violations(box: dict[str, Any] | None) -> list[str]:
    if not box:
        return []
    x, y, w, h = box_keys(box)
    problems: list[str] = []
    if not math.isfinite(x + y + w + h) or w <= 0 or h <= 0:
        problems.append("invalid")
        return problems
    if x < -EPS or y < -EPS:
        problems.append("outside-top-left")
    if x + w > 1.0 + EPS or y + h > 1.0 + EPS:
        problems.append("outside-bottom-right")
    return problems


def _signature(payload: Any) -> str:
    import json

    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _issue(
    *,
    kind: str,
    severity: str,
    target: dict[str, Any],
    start: float,
    end: float,
    message: str,
    signature_payload: Any,
    time: float | None = None,
) -> dict[str, Any]:
    return {
        "id": kind,
        "reviewId": kind,
        "kind": kind.split(":", 1)[0],
        "severity": severity,
        "targetId": target.get("id"),
        "targetName": target.get("name") or "未命名目标",
        "color": target.get("color") or "#4da3ff",
        "start": max(0.0, float(start)),
        "end": max(0.0, float(end)),
        "time": time,
        "message": message,
        "signature": _signature(signature_payload),
    }


def build_issues(project: dict[str, Any]) -> list[dict[str, Any]]:
    video = project.get("video") or {}
    duration = max(0.1, as_float(video.get("duration"), 10.0))
    settings = project.get("settings") or {}
    max_interval = max(0.2, as_float(settings.get("keyInterval"), 1.0))
    frame_epsilon = 0.09  # about 2-3 frames at common rates

    issues: list[dict[str, Any]] = []

    for target in project.get("targets") or []:
        if not isinstance(target, dict):
            continue
        tid = target.get("id")
        name = target.get("name") or "未命名目标"
        keys = sorted_keyframes(target)

        if not keys:
            issues.append(
                _issue(
                    kind=f"no-keys:{tid}",
                    severity="error",
                    target=target,
                    start=0.0,
                    end=duration,
                    message=f"「{name}」还没有任何遮盖关键点",
                    signature_payload=["no-keys", tid],
                )
            )
            continue

        first = keys[0]
        last = keys[-1]
        ft = as_float(first.get("t"))
        lt = as_float(last.get("t"))

        if ft > frame_epsilon:
            issues.append(
                _issue(
                    kind=f"missing-prefix:{tid}",
                    severity="warning",
                    target=target,
                    start=0.0,
                    end=ft,
                    message=f"首个关键点在 {ft:.2f}s，之前的片段没有遮盖",
                    signature_payload=["prefix", tid, ft, first],
                )
            )

        if duration - lt > frame_epsilon:
            issues.append(
                _issue(
                    kind=f"missing-suffix:{tid}",
                    severity="warning",
                    target=target,
                    start=lt,
                    end=duration,
                    message=f"最后关键点在 {lt:.2f}s，之后到片尾没有遮盖",
                    signature_payload=["suffix", tid, lt, last, duration],
                )
            )

        for key in keys:
            kt = as_float(key.get("t"))
            violations = box_violations(key)
            if violations:
                issues.append(
                    _issue(
                        kind=f"outside-key:{tid}:{key.get('id')}",
                        severity="error",
                        target=target,
                        start=max(0.0, kt - 0.2),
                        end=min(duration, kt + 0.2),
                        time=kt,
                        message=f"{kt:.2f}s 的框超出原画面或尺寸无效，导出前需要修正",
                        signature_payload=["outside", tid, key.get("id"), kt, key],
                    )
                )

        for left, right in zip(keys, keys[1:]):
            lt = as_float(left.get("t"))
            rt = as_float(right.get("t"))
            dt = max(0.0, rt - lt)
            pair_id = f"pair:{tid}:{left.get('id')}:{right.get('id')}"
            payload = [
                "pair",
                tid,
                left.get("id"),
                right.get("id"),
                lt,
                rt,
                left,
                right,
                target.get("gaps") or [],
            ]

            crossing = None
            for gap in target.get("gaps") or []:
                if not isinstance(gap, dict):
                    continue
                gs = as_float(gap.get("start"))
                ge = as_float(gap.get("end"), gs)
                if ge > lt + EPS and gs < rt - EPS:
                    crossing = gap
                    break

            if crossing:
                issues.append(
                    _issue(
                        kind=f"gap-crossing:{tid}:{left.get('id')}:{right.get('id')}",
                        severity="info",
                        target=target,
                        start=lt,
                        end=rt,
                        message="该补间跨过免遮盖段；导出时不会横扫，段外按最近关键点保持，建议两侧补点",
                        signature_payload=payload,
                    )
                )
            elif dt > max_interval:
                lx, ly, lw, lh = box_keys(left)
                rx, ry, rw, rh = box_keys(right)
                move = math.hypot((lx + lw / 2) - (rx + rw / 2), (ly + lh / 2) - (ry + rh / 2))
                severity = "warning" if move > 0.08 else "info"
                issues.append(
                    _issue(
                        kind=f"sparse-pair:{tid}:{left.get('id')}:{right.get('id')}",
                        severity=severity,
                        target=target,
                        start=lt,
                        end=rt,
                        message=(
                            f"关键点间隔 {dt:.2f}s"
                            + ("且位移较大，建议逐帧检查或补点" if move > 0.08 else "，可逐帧确认")
                        ),
                        signature_payload=payload,
                    )
                )

        for gap in target.get("gaps") or []:
            if not isinstance(gap, dict):
                continue
            gid = gap.get("id") or new_id("gap")
            gs = as_float(gap.get("start"))
            ge = as_float(gap.get("end"), gs)
            issues.append(
                _issue(
                    kind=f"gap:{tid}:{gid}",
                    severity="info",
                    target=target,
                    start=gs,
                    end=max(gs, ge),
                    message="免遮盖段：转身 / 遮挡 / 出画时此处不会画框",
                    signature_payload=["gap", tid, gid, gs, ge, gap.get("reason", "")],
                )
            )

            near_start = min(abs(as_float(k.get("t")) - gs) for k in keys) if keys else 999
            near_end = min(abs(as_float(k.get("t")) - ge) for k in keys) if keys else 999
            if keys and (near_start > 0.16 or near_end > 0.16):
                issues.append(
                    _issue(
                        kind=f"gap-boundary:{tid}:{gid}",
                        severity="warning",
                        target=target,
                        start=gs,
                        end=ge,
                        message="免遮盖段两端 0.16s 内缺少贴近的关键框，容易在边界漏遮或多盖",
                        signature_payload=["gap-boundary", tid, gid, gs, ge, keys],
                    )
                )

    order = {"error": 0, "warning": 1, "info": 2}
    issues.sort(key=lambda i: (order.get(i["severity"], 9), i["start"], i["targetName"]))
    return issues


def review_state(project: dict[str, Any], issue: dict[str, Any]) -> dict[str, Any]:
    record = (project.get("reviews") or {}).get(issue["reviewId"])
    if not isinstance(record, dict) or not record.get("checked"):
        return {"checked": False, "stale": False}
    stale = record.get("signature") != issue.get("signature")
    return {
        "checked": True,
        "stale": stale,
        "checkedAt": record.get("checkedAt"),
        "note": record.get("note", ""),
    }


def default_project() -> dict[str, Any]:
    return {
        "version": 1,
        "app": "number-mask-workbench",
        "video": {"name": "", "assetId": "", "width": 1280, "height": 720, "duration": 12, "fps": 30},
        "settings": {"keyInterval": 1.0, "padding": 0, "verifyKeyFrames": True},
        "targets": [],
        "reviews": {},
    }
