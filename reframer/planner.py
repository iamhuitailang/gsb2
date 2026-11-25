"""取景规划器: 关注框轨迹 -> 逐帧裁框 + 策略事件。

设计要点
- 同一镜头内平滑移动: 对目标中心点做"迟滞 + 驻留 + 限速", 避免在两个
  说话人之间快速来回。
- 跨镜头 (transition=cut): 裁框在切点硬跳到新目标, 不做插值。
- 视野装不下两个人时按策略退化为只跟说话人/必留对象; 关注框暂时缺失时
  按 keep 策略原地留边。每帧的选择都写进 events, 界面可提前知道。
- 必留对象和安全区(底线区域)作为硬约束, 无法同时满足时记录 warning。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Optional

from .model import Rect, Shot, even2
from .tracks import TracksDoc, is_speaking, rect_at, shot_at

# 取景策略 (写入时间表, 界面/报告直接展示)
STRATEGY_BOTH = "both"                 # 两人同框
STRATEGY_SPEAKER = "speaker"           # 只跟当前说话人
STRATEGY_REQUIRED = "required"         # 视野不够, 保必留对象
STRATEGY_FALLBACK = "fallback"         # 无关注框数据, 原地留边
STRATEGY_MANUAL = "manual"             # 局部人工取景点
STRATEGY_CUT = "cut"                   # 跨镜头硬切


@dataclass
class MotionConfig:
    max_speed_px_s: float = 360.0      # 裁框中心最大移动速度 (像素/秒)
    hysteresis_px: float = 42.0        # 偏差小于该值不启动移动
    dwell_s: float = 0.45              # 目标持续偏离多久才开始移动
    margin_frac: float = 0.12          # 人物框外侧留白 (占框宽比例)
    no_data: str = "hold"              # hold | edge_hold
    edge_hold_px: int = 24             # edge_hold 时贴边的边距(像素)

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "MotionConfig":
        known = {k: v for k, v in (d or {}).items() if k in MotionConfig.__dataclass_fields__}
        return MotionConfig(**known)


@dataclass
class FramePlan:
    frame: int
    t: float
    crop: Rect                          # 归一化裁框
    strategy: str
    active: list[str]
    note: str = ""


class _Smoother1D:
    """一维限速平滑器 (迟滞 + 驻留 + 最大速度)。"""

    def __init__(self, cfg: MotionConfig):
        self.cfg = cfg
        self.pos: Optional[float] = None
        self._candidate: Optional[float] = None
        self._candidate_since = 0.0

    def reset(self, pos: float) -> None:
        self.pos = pos
        self._candidate = None
        self._candidate_since = 0.0

    def update(self, target: float, t: float, dt: float) -> tuple[float, bool]:
        """返回 (新位置, 是否发生了移动)。"""
        if self.pos is None:
            self.reset(target)
            return self.pos, False
        delta = target - self.pos
        if abs(delta) <= self.cfg.hysteresis_px:
            # 小偏差: 清掉待确认目标, 不移动
            self._candidate = None
            return self.pos, False
        if self._candidate is None or abs(self._candidate - target) > 1.0:
            self._candidate = target
            self._candidate_since = t
        if t - self._candidate_since < self.cfg.dwell_s:
            return self.pos, False
        max_step = self.cfg.max_speed_px_s * dt
        step = max(-max_step, min(max_step, delta))
        moved = abs(step) > 1e-9
        self.pos += step
        return self.pos, moved


def _union(rects: list[Rect]) -> Rect:
    x0 = min(r.x for r in rects)
    y0 = min(r.y for r in rects)
    x1 = max(r.x + r.w for r in rects)
    y1 = max(r.y + r.h for r in rects)
    return Rect(x0, y0, x1 - x0, y1 - y0)


def _clamp_center(cx: float, half_w: float, width: int) -> float:
    lo, hi = half_w, width - half_w
    if lo >= hi:
        return width / 2.0
    return max(lo, min(hi, cx))


def _contains(crop_x: float, crop_w: float, r_px: tuple[float, float, float, float]) -> bool:
    x, _y, w, _h = r_px
    return x >= crop_x - 1e-6 and x + w <= crop_x + crop_w + 1e-6


def _compress_keyframes(frames: list[FramePlan], tol_px: float, width: int) -> list[dict[str, Any]]:
    """对裁框左边缘做 RDP 压缩, 重建误差不超过 tol_px 像素。"""
    pts = [(f.t, f.crop.x * width) for f in frames]

    def keep(i: int, j: int) -> list[int]:
        if j <= i + 1:
            return []
        t0, x0 = pts[i]
        t1, x1 = pts[j]
        worst, worst_k = 0.0, -1
        for k in range(i + 1, j):
            tk, xk = pts[k]
            p = 0.0 if t1 == t0 else (tk - t0) / (t1 - t0)
            line = x0 + (x1 - x0) * p
            err = abs(xk - line)
            if err > worst:
                worst, worst_k = err, k
        if worst > tol_px:
            return keep(i, worst_k) + [worst_k] + keep(worst_k, j)
        return []

    if len(pts) <= 2:
        keep_idx = list(range(len(pts)))
    else:
        keep_idx = [0] + keep(0, len(pts) - 1) + [len(pts) - 1]
        keep_idx = sorted(set(keep_idx))
    out = []
    for i in keep_idx:
        f = frames[i]
        out.append({"t": round(f.t, 6), "crop": f.crop.to_dict()})
    return out


def plan(doc: TracksDoc, overrides: Optional[list[dict[str, Any]]] = None) -> dict[str, Any]:
    """生成完整取景时间表。"""
    cfg = MotionConfig.from_dict(doc.config.get("motion", {}))
    overrides = overrides if overrides is not None else doc.config.get("overrides", [])
    width, height, fps = doc.width, doc.height, doc.fps
    duration = doc.duration
    n_frames = max(1, int(round(duration * fps)))

    # 竖版裁框: 高度取满, 宽度按 9:16 并对齐偶数
    crop_h = even2(height)
    crop_w = min(width, even2(crop_h * 9.0 / 16.0))
    half_w = crop_w / 2.0

    overrides = sorted(overrides, key=lambda o: float(o["start"]))

    def manual_at(t: float) -> Optional[dict[str, Any]]:
        for o in overrides:
            if float(o["start"]) <= t < float(o["end"]):
                return o
        return None

    smoother = _Smoother1D(cfg)
    frames: list[FramePlan] = []
    events: list[dict[str, Any]] = []
    warnings: list[str] = []
    current_strategy = ""

    def log(t: float, kind: str, detail: str) -> None:
        events.append({"frame": int(round(t * fps)), "t": round(t, 4), "type": kind, "detail": detail})

    prev_shot: Optional[Shot] = None
    for fi in range(n_frames):
        t = fi / fps
        dt = 1.0 / fps
        shot = shot_at(doc.shots, t) or Shot(0.0, duration, "smooth")
        # 切点: 当前帧时间落在新镜头的起始帧上, 且两侧镜头都声明为 cut
        hard_cut = (
            prev_shot is not None
            and shot is not prev_shot
            and prev_shot.transition == "cut"
            and shot.transition == "cut"
            and abs(t - shot.start) < 0.5 / fps
        )

        # ---- 1. 收集当前活跃关注框 (像素坐标) ----
        active: list[tuple[Track, Rect, tuple[float, float, float, float]]] = []
        for tr in doc.tracks:
            r = rect_at(tr, t)
            if r is not None:
                active.append((tr, r, r.to_px(width, height)))
        active_ids = [tr.id for tr, _, _ in active]

        # ---- 2. 人工局部取景点优先 ----
        mo = manual_at(t)
        target_cx: float
        strategy: str
        note = ""
        if mo is not None:
            target_cx = float(mo["center_x_norm"]) * width
            strategy = STRATEGY_MANUAL
            note = f"人工取景 @ {mo.get('name', mo['start'])}"
        elif not active:
            # ---- 3. 无数据: 原地留边 / 贴边 ----
            strategy = STRATEGY_FALLBACK
            if cfg.no_data == "edge_hold":
                cur = smoother.pos if smoother.pos is not None else width / 2
                target_cx = min(max(cur, half_w + cfg.edge_hold_px), width - half_w - cfg.edge_hold_px)
                note = "无关注框数据, 贴边留边"
            else:
                target_cx = smoother.pos if smoother.pos is not None else width / 2
                note = "无关注框数据, 原地保留"
        else:
            union_n = _union([r for _, r, _ in active])
            required = [a for a in active if a[0].required]
            speakers = [a for a in active if is_speaking(a[0].id, doc.speakers, t)]

            # 双人同框所需像素宽度 (归一化宽度 * 画面宽, 留白按合并框比例)
            need_w_px = union_n.w * (1.0 + 2 * cfg.margin_frac) * width
            if need_w_px <= crop_w and not required:
                # 装得下所有人: 合框居中
                target_cx = union_n.cx * width
                strategy = STRATEGY_BOTH
                note = f"{len(active)} 人同框"
            elif need_w_px <= crop_w:
                # 必留对象存在但仍装得下: 合框, 后面再做硬约束校验
                target_cx = union_n.cx * width
                strategy = STRATEGY_BOTH
                note = "合框(含必留对象)"
            else:
                # 装不下: 说话人 > 必留对象 > 最近的活跃框
                if speakers:
                    pick = speakers[0]
                    strategy = STRATEGY_SPEAKER
                    note = f"视野不足, 跟说话人 {pick[0].label}"
                elif required:
                    pick = required[0]
                    strategy = STRATEGY_REQUIRED
                    note = f"视野不足, 保必留对象 {pick[0].label}"
                else:
                    pick = active[0]
                    strategy = STRATEGY_SPEAKER
                    note = f"视野不足, 跟 {pick[0].label}"
                r = pick[1]
                target_cx = r.cx * width

        # ---- 4. 硬约束: 必留对象 + 安全区 ----
        center_min, center_max = half_w, width - half_w
        hard_notes: list[str] = []
        for tr, _r_n, (rx, _ry, rw, _rh) in active:
            if tr.required:
                center_min = max(center_min, rx + rw - half_w)
                center_max = min(center_max, rx + half_w)
                hard_notes.append(f"必留 {tr.label}")
        for zone in doc.safe_zones:
            zx, _zy, zw, _zh = zone.rect.to_px(width, height)
            # 安全区要求整段落在裁框内
            center_min = max(center_min, zx + zw - half_w)
            center_max = min(center_max, zx + half_w)
            hard_notes.append(f"安全区 {zone.name}")
        if center_min > center_max + 1e-6:
            warnings.append(f"t={t:.2f}s 硬约束互相冲突, 无法同时满足: {', '.join(hard_notes)}")
            # 冲突时退化为尽量居中, 不强行夹到反向
            target_cx = max(half_w, min(width - half_w, target_cx))
        else:
            target_cx = max(center_min, min(center_max, target_cx))
        target_cx = _clamp_center(target_cx, half_w, width)

        # ---- 5. 硬切 or 平滑 ----
        if hard_cut:
            smoother.reset(target_cx)
            cx_px = target_cx
            log(t, "cut", f"镜头硬切 -> {strategy} ({note})")
        else:
            cx_px, moved = smoother.update(target_cx, t, dt)
            if strategy != current_strategy:
                log(t, "strategy", f"{current_strategy or '起始'} -> {strategy}: {note}")
            elif moved and strategy in (STRATEGY_SPEAKER, STRATEGY_REQUIRED):
                # 跟人移动只在策略切换时记录, 避免刷屏
                pass
        current_strategy = strategy
        prev_shot = shot

        crop_x = _clamp_center(cx_px, half_w, width) - half_w
        crop = Rect(crop_x / width, 0.0, crop_w / width, crop_h / height)
        frames.append(FramePlan(fi, t, crop, strategy, active_ids, note))

    # ---- 6. 关键帧压缩 ----
    keyframes = _compress_keyframes(frames, tol_px=1.0, width=width)

    # ---- 7. 每镜头策略摘要 (界面提前知道每段采取哪种保留/留边) ----
    seg_summary: list[dict[str, Any]] = []
    for shot in doc.shots:
        i0 = max(0, int(math.ceil(shot.start * fps)))
        i1 = min(n_frames, int(math.ceil(shot.end * fps)))
        seg = frames[i0:i1] or frames[:1]
        counts: dict[str, int] = {}
        for f in seg:
            counts[f.strategy] = counts.get(f.strategy, 0) + 1
        dom = max(counts, key=counts.get)
        seg_summary.append({
            "start": shot.start,
            "end": shot.end,
            "transition": shot.transition,
            "dominant_strategy": dom,
            "strategies": sorted(counts),
        })

    schedule = {
        "schema": "reframer.schedule/v1",
        "source": doc.source,
        "tracks_file": None,        # 由 CLI 填入
        "width": width,
        "height": height,
        "fps": fps,
        "duration": duration,
        "frames": n_frames,
        "crop": {"width_px": crop_w, "height_px": crop_h, "aspect": "9:16"},
        "motion": cfg.__dict__.copy(),
        "overrides": overrides,
        "segments": seg_summary,
        "keyframes": keyframes,
        "events": events,
        "warnings": warnings,
    }
    return schedule
