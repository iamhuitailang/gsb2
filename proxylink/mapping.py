"""标定与时间换算。

标定模型
--------
用户给出一组对应时间点（同一画面在原片和代理上的时间）：

- 单点标定：假设双方走时一致（rate=1），只修正起点偏移。
- 双点标定：用两点同时求偏置和走时比 ``rate``，可处理代理帧率
  与原片不一致的情况；rate 明显偏离两个 fps 之比会被拒绝。

换算公式（o = 原片时间，p = 代理时间）::

    o = o1 + rate * (p - p1)
    p = p1 + (o - o1) / rate

代理如果是从原片中间截取的（起点偏了）或被砍掉尾巴，双端时间线
都会出现"无法可靠定位"的区间，由 :meth:`Mapping.coverage` 显式给出。
"""

from dataclasses import dataclass, field

from .errors import CalibrationError, OutOfRangeError
from .timecode import snap_to_frame

# 双点标定时走时比的合理区间（相对 fps 之比再放宽）
_RATE_TOL = 0.02
# 单点/边界判定的最小时间差
_EPS = 1e-6


@dataclass
class Anchor:
    """一对对应时间点（秒，均已吸附帧边界）。"""

    original: float
    proxy: float

    def to_dict(self):
        return {"original": self.original, "proxy": self.proxy}

    @classmethod
    def from_dict(cls, d):
        return cls(float(d["original"]), float(d["proxy"]))


@dataclass
class Mapping:
    """一条原片-代理挂接的时间映射关系。"""

    original_duration: float
    proxy_duration: float
    original_fps: float
    proxy_fps: float
    anchors: list = field(default_factory=list)
    rate: float = 1.0

    # ---- 构造 -------------------------------------------------------

    @classmethod
    def build(cls, original_media, proxy_media, anchors):
        """根据锚点构建映射，会做完整合法性校验。"""
        anchors = [a if isinstance(a, Anchor) else Anchor(a[0], a[1]) for a in anchors]
        if not anchors:
            raise CalibrationError("至少需要一个标定锚点")
        if len(anchors) > 2:
            raise CalibrationError("最多支持两个标定锚点")

        o_fps = original_media.fps or 0
        p_fps = proxy_media.fps or 0
        snapped = []
        for a in anchors:
            o = snap_to_frame(a.original, o_fps) if o_fps else a.original
            p = snap_to_frame(a.proxy, p_fps) if p_fps else a.proxy
            if o < 0 or o > original_media.duration + 0.5 / max(o_fps, 1):
                raise CalibrationError(
                    f"原片锚点 {o:.3f}s 超出素材时长 {original_media.duration:.3f}s"
                )
            if p < 0 or p > proxy_media.duration + 0.5 / max(p_fps, 1):
                raise CalibrationError(
                    f"代理锚点 {p:.3f}s 超出素材时长 {proxy_media.duration:.3f}s"
                )
            snapped.append(Anchor(o, p))

        rate = 1.0
        if len(snapped) == 2:
            a1, a2 = snapped
            do = a2.original - a1.original
            dp = a2.proxy - a1.proxy
            if abs(do) < _EPS or abs(dp) < _EPS:
                raise CalibrationError("两个锚点必须指向不同的画面（时间差为 0）")
            rate = do / dp
            expected = (o_fps / p_fps) if o_fps and p_fps else 1.0
            if expected and abs(rate - expected) > _RATE_TOL * max(expected, 1e-9):
                raise CalibrationError(
                    f"走时比 {rate:.6f} 与帧率之比 {expected:.6f} 偏差过大，"
                    "锚点可能标错了画面"
                )
            if not (0.1 < rate < 10):
                raise CalibrationError(f"走时比 {rate:.6f} 超出合理范围 (0.1, 10)")

        return cls(
            original_duration=original_media.duration,
            proxy_duration=proxy_media.duration,
            original_fps=o_fps,
            proxy_fps=p_fps,
            anchors=snapped,
            rate=rate,
        )

    @property
    def anchor1(self):
        return self.anchors[0]

    # ---- 换算 -------------------------------------------------------

    def proxy_to_original(self, proxy_t, clamp=False):
        """代理时间 -> 原片时间。默认越界抛错，clamp 时夹到边界。"""
        # 先校验输入是否在代理自身时长内（代理缺尾时，超出其末尾的时间点无效）
        proxy_t = self._guard_source(proxy_t, self.proxy_duration, "代理", clamp)
        o = self.anchor1.original + self.rate * (proxy_t - self.anchor1.proxy)
        # 再校验换算结果是否落在原片范围内
        o = self._guard(o, proxy_t, "original", self.original_duration, clamp)
        if self.original_fps:
            o = snap_to_frame(o, self.original_fps)
        return o

    def original_to_proxy(self, original_t, clamp=False):
        """原片时间 -> 代理时间。默认越界抛错，clamp 时夹到边界。"""
        original_t = self._guard_source(original_t, self.original_duration, "原片", clamp)
        p = self.anchor1.proxy + (original_t - self.anchor1.original) / self.rate
        p = self._guard(p, original_t, "proxy", self.proxy_duration, clamp)
        if self.proxy_fps:
            p = snap_to_frame(p, self.proxy_fps)
        return p

    def _guard_source(self, t, duration, side_name, clamp):
        """输入时间必须在素材自身时长内；clamp 时夹到边界。"""
        if t < -self._quarter(side_name):
            if clamp:
                return 0.0
            raise OutOfRangeError(
                f"{side_name}时间 {t:.3f}s 早于素材起点，该画面不存在，必须停止"
            )
        if t > duration + self._quarter(side_name):
            if clamp:
                return duration
            raise OutOfRangeError(
                f"{side_name}时间 {t:.3f}s 超出素材时长 {duration:.3f}s，必须停止"
            )
        return max(0.0, min(t, duration))

    def _quarter(self, side_name):
        fps = self.original_fps if side_name == "原片" else self.proxy_fps
        return 0.25 / (fps or 1)

    def _guard(self, mapped, source_t, target, target_duration, clamp):
        # 仅允许 1/4 帧的边界舍入容差，明显早于起点/超出末尾的值必须拦截
        quarter_frame = 0.25 / (self.original_fps if target == "original" else self.proxy_fps or 1)
        low = -quarter_frame
        high = target_duration + quarter_frame
        if mapped < low:
            if clamp:
                return 0.0
            raise OutOfRangeError(
                self._out_message(target, mapped, target_duration, "head", source_t)
            )
        if mapped > high:
            if clamp:
                return target_duration
            raise OutOfRangeError(
                self._out_message(target, mapped, target_duration, "tail", source_t)
            )
        return max(0.0, min(mapped, target_duration))

    @staticmethod
    def _out_message(target, mapped, duration, side, source_t):
        names = {"original": "原片", "proxy": "代理"}
        if side == "head":
            return (
                f"源时间 {source_t:.3f}s 对应{names[target]}时间 {mapped:.3f}s 早于素材起点，"
                f"该画面在{names[target]}中不存在，必须停止"
            )
        return (
            f"源时间 {source_t:.3f}s 对应{names[target]}时间 {mapped:.3f}s 超出"
            f"{names[target]}时长 {duration:.3f}s（缺尾），该画面无法定位，必须停止"
        )

    def locate(self, side, t):
        """不抛错的定位检查，返回详细状态，供界面/报告使用。"""
        if side == "proxy":
            try:
                mapped = self.proxy_to_original(t)
                target_dur, target_fps = self.original_duration, self.original_fps
            except OutOfRangeError as exc:
                return {"ok": False, "reason": str(exc)}
        else:
            try:
                mapped = self.original_to_proxy(t)
                target_dur, target_fps = self.proxy_duration, self.proxy_fps
            except OutOfRangeError as exc:
                return {"ok": False, "reason": str(exc)}
        return {
            "ok": True,
            "mapped": mapped,
            "target_duration": target_dur,
            "target_frame": round(mapped * target_fps) if target_fps else None,
        }

    # ---- 可靠区间 ---------------------------------------------------

    def coverage(self):
        """计算双端时间线上的可靠/不可靠区间与首尾匹配情况。"""
        # 代理两端映射到原片时间线（夹取，仅用于报告）
        o_head = self.anchor1.original + self.rate * (0.0 - self.anchor1.proxy)
        o_tail = self.anchor1.original + self.rate * (self.proxy_duration - self.anchor1.proxy)

        orig_head_unreachable = max(0.0, o_head)
        orig_tail_start = min(self.original_duration, max(o_head, o_tail))
        orig_tail_unreachable = max(0.0, self.original_duration - o_tail)

        # 代理时间线本身通常整段可靠；越界只发生在映射到原片时
        proxy_cover_head = 0.0
        proxy_cover_tail = self.proxy_duration

        def frames(seconds, fps):
            return round(seconds * fps) if fps else None

        return {
            "rate": self.rate,
            "original": {
                "duration": self.original_duration,
                "reliable_range": [orig_head_unreachable, orig_tail_start],
                "unreachable": [
                    {"side": "head", "range": [0.0, orig_head_unreachable],
                     "seconds": orig_head_unreachable,
                     "frames": frames(orig_head_unreachable, self.original_fps)},
                    {"side": "tail", "range": [orig_tail_start, self.original_duration],
                     "seconds": orig_tail_unreachable,
                     "frames": frames(orig_tail_unreachable, self.original_fps)},
                ],
            },
            "proxy": {
                "duration": self.proxy_duration,
                "reliable_range": [proxy_cover_head, proxy_cover_tail],
                "maps_to_original": [max(0.0, o_head), min(self.original_duration, o_tail)],
                "unreachable": [],
            },
            "head_match": {
                "aligned": abs(o_head) <= 0.5 / max(self.original_fps, 1),
                "proxy_first_frame_original_t": max(0.0, o_head),
                "original_missing_head_seconds": max(0.0, o_head),
                "original_missing_head_frames": frames(max(0.0, o_head), self.original_fps),
            },
            "tail_match": {
                "aligned": abs(o_tail - self.original_duration)
                <= 0.5 / max(self.original_fps, 1),
                "proxy_last_frame_original_t": min(self.original_duration, o_tail),
                "original_missing_tail_seconds": max(0.0, self.original_duration - o_tail),
                "original_missing_tail_frames": frames(
                    max(0.0, self.original_duration - o_tail), self.original_fps),
            },
        }

    def to_dict(self):
        return {
            "anchors": [a.to_dict() for a in self.anchors],
            "rate": self.rate,
        }

    @classmethod
    def from_dict(cls, d, original_media, proxy_media):
        anchors = [Anchor.from_dict(a) for a in d.get("anchors", [])]
        m = cls.build(original_media, proxy_media, anchors)
        # 重建结果与持久化 rate 应一致；以重建为准并保留锚点
        return m
