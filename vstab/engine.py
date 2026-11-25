"""防抖核心引擎。

设计要点
========

1. 分析: 光流 + 部分仿射(相似变换)估计相邻帧的 ``(dx, dy, da)`` 运动,
   累加得到画面运动轨迹。估计失败 / 内点过少的帧判定为镜头切换,
   大位移高内点的帧判定为快速摇摄。

2. 平滑: 轨迹在每个镜头内部独立做高斯平滑(不跨越剪辑点),
   稳定强度负责混合原始轨迹与平滑轨迹。

3. 逐帧一致: :meth:`Stabilizer.matrix_at` / :meth:`Stabilizer.render_stabilized`
   是预览 JPEG 和视频导出唯一的变换来源, 且只依赖帧序号,
   因此逐帧预览 / 区间预览与导出视频的时间位置严格一致。

4. 不处理区间与镜头切换处使用平滑包络把校正量衰减到 0(原画面),
   避免硬跳变。

5. 裁切画幅: 对最终矩阵反算输出四角在原始画面中的位置,
   即可在原始画面上叠加“最终有效画幅”四边形; 自动裁切倍数通过
   角点覆盖条件二分求出, 保证不出现黑边。
"""

from __future__ import annotations

import copy
import json
import math
import subprocess
import threading
from pathlib import Path
from typing import Any, Callable

import cv2
import numpy as np

# ---------------------------------------------------------------------------
# 常量与默认参数
# ---------------------------------------------------------------------------

SUPPORTED_SUFFIXES = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}

APP_VERSION = 1

DEFAULT_PARAMS: dict[str, Any] = {
    # 稳定强度 0~1: 最终校正 = (平滑轨迹 - 原始轨迹) * strength * 包络
    "strength": 0.85,
    # 平滑范围, 单位秒(高斯窗口全宽约为该时长), 内部换算为半径帧数
    "smooth_sec": 0.8,
    # 裁切 / 缩放倍数。crop_mode == "auto" 时由分析结果自动求解并回填
    "crop_zoom": 1.08,
    "crop_mode": "auto",          # "auto" | "manual"
    # 快速摇摄自适应: 摇摄峰值处暂时减弱校正, 保留正常的大幅度运镜
    "adaptive_pan": True,
    "pan_sensitivity": 1.0,       # 越大越容易判定为摇摄(阈值越低)
    # 在原始画面上叠加最终有效画幅
    "show_overlay": True,
    # 手动标记的不处理区间 [start, end], 闭区间, 帧序号(0 基)
    "exclusions": [],
}


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------

def smoothstep(x: float) -> float:
    x = max(0.0, min(1.0, x))
    return x * x * (3.0 - 2.0 * x)


def gaussian_smooth_1d(values: np.ndarray, radius: int) -> np.ndarray:
    """对一维序列做边缘反射的高斯平滑。radius<=0 时原样返回。"""
    if radius <= 0 or len(values) <= 2:
        return values.astype(np.float64, copy=True)
    sigma = max(radius / 2.0, 0.8)
    k = int(radius)
    xs = np.arange(-k, k + 1, dtype=np.float64)
    kernel = np.exp(-(xs ** 2) / (2.0 * sigma * sigma))
    kernel /= kernel.sum()
    pad = min(k, len(values) - 1)
    padded = np.pad(values.astype(np.float64), (pad, pad), mode="reflect")
    out = np.convolve(padded, kernel, mode="same")
    return out[pad: pad + len(values)]


def probe_has_audio(path: str | Path) -> bool:
    """用 ffprobe 判断是否存在音轨; 任何异常都按无音轨处理。"""
    try:
        proc = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "a",
                "-show_entries", "stream=codec_type",
                "-of", "json", str(path),
            ],
            capture_output=True, text=True, timeout=15,
        )
        info = json.loads(proc.stdout or "{}")
        return bool(info.get("streams"))
    except Exception:
        return False


# ---------------------------------------------------------------------------
# 视频分析
# ---------------------------------------------------------------------------

def analyze_video(
    path: str | Path,
    progress: Callable[[float, str], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    """分析视频, 返回可直接 JSON 序列化的分析结果字典。

    返回字段:
        width/height/fps/frame_count/has_audio
        deltas:    每帧相对上一帧的运动 [dx, dy, da](原始分辨率像素/弧度)
        trajectory: 累加轨迹 [x, y, a]
        motion:    每帧综合运动量(像素, 含旋转折算)
        inliers:   每帧 RANSAC 内点数
        pan_frames / cut_frames: 检测到的快速摇摄帧 / 镜头切换帧
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"视频不存在: {path}")

    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise RuntimeError(f"OpenCV 无法打开视频: {path}")

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 0
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 0
    fps = float(cap.get(cv2.CAP_PROP_FPS)) or 30.0
    if not (1.0 <= fps <= 240.0):
        fps = 30.0
    hint_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0

    # 分析分辨率: 宽度压到 640, 平移量最后按比例还原到原始分辨率
    analysis_w = 640
    scale = analysis_w / width if width > analysis_w else 1.0
    aw = max(8, int(round(width * scale)))
    ah = max(8, int(round(height * scale)))
    translation_scale = 1.0 / scale  # 分析像素 -> 原始像素

    deltas: list[list[float]] = []
    motion: list[float] = []
    inliers: list[int] = []
    pan_frames: list[int] = []
    cut_frames: list[int] = []

    prev_gray: np.ndarray | None = None
    index = 0

    feature_params = dict(
        maxCorners=480,
        qualityLevel=0.012,
        minDistance=max(6.0, aw / 90.0),
        blockSize=7,
    )
    lk_params = dict(
        winSize=(21, 21),
        maxLevel=3,
        criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 24, 0.01),
    )

    while True:
        if should_cancel and should_cancel():
            cap.release()
            raise RuntimeError("已取消分析")

        ok, frame = cap.read()
        if not ok or frame is None:
            break

        if progress and hint_count > 0 and index % 5 == 0:
            progress(min(0.99, index / max(hint_count, 1)), f"分析运动 {index}/{hint_count}")

        if scale < 1.0:
            small = cv2.resize(frame, (aw, ah), interpolation=cv2.INTER_AREA)
        else:
            small = frame
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

        if prev_gray is None:
            deltas.append([0.0, 0.0, 0.0])
            motion.append(0.0)
            inliers.append(0)
        else:
            pts = cv2.goodFeaturesToTrack(prev_gray, **feature_params)
            dx = dy = da = 0.0
            n_in = 0
            is_cut = False

            if pts is not None and len(pts) >= 12:
                nxt, status, _err = cv2.calcOpticalFlowPyrLK(
                    prev_gray, gray, pts, None, **lk_params
                )
                if nxt is not None:
                    st = status.reshape(-1).astype(bool)
                    p0 = pts.reshape(-1, 2)[st]
                    p1 = nxt.reshape(-1, 2)[st]
                    if len(p0) >= 12:
                        matrix, inlier_mask = cv2.estimateAffinePartial2D(
                            p0, p1,
                            method=cv2.RANSAC,
                            ransacReprojThreshold=3.0,
                            maxIters=2000,
                            confidence=0.99,
                            refineIters=10,
                        )
                        if matrix is not None and inlier_mask is not None:
                            n_in = int(inlier_mask.sum())
                            if n_in >= 10:
                                dx = float(matrix[0, 2]) * translation_scale
                                dy = float(matrix[1, 2]) * translation_scale
                                da = math.atan2(float(matrix[1, 0]),
                                                float(matrix[0, 0]))
                            else:
                                is_cut = True
                        else:
                            is_cut = True
                    else:
                        is_cut = True
                else:
                    is_cut = True
            else:
                is_cut = True

            # 内点比例过低也视为切换 / 严重运动模糊
            if not is_cut and pts is not None and len(pts) > 0:
                if n_in < 12 or n_in / max(len(pts), 1) < 0.18:
                    is_cut = True

            if is_cut:
                # 跨剪辑点不累计任何运动, 后续按镜头独立平滑
                dx = dy = da = 0.0
                cut_frames.append(index)

            deltas.append([dx, dy, da])
            rot_px = abs(da) * min(width, height) * 0.5
            mag = math.hypot(dx, dy) + rot_px
            motion.append(float(mag))
            inliers.append(n_in)

            # 快速摇摄: 位移大且估计可信(切换已经单独处理)
            pan_threshold = width * 0.022
            if not is_cut and mag > pan_threshold and n_in >= 20:
                pan_frames.append(index)

        prev_gray = gray
        index += 1

    cap.release()

    frame_count = index
    if frame_count == 0:
        raise RuntimeError("未能从视频中解码出任何帧")

    deltas_arr = np.asarray(deltas, dtype=np.float64)
    trajectory = np.cumsum(deltas_arr, axis=0)

    if progress:
        progress(1.0, "分析完成")

    return {
        "version": APP_VERSION,
        "source_path": str(path.resolve()),
        "width": width,
        "height": height,
        "fps": fps,
        "frame_count": frame_count,
        "has_audio": probe_has_audio(path),
        "deltas": deltas_arr.tolist(),
        "trajectory": trajectory.tolist(),
        "motion": motion,
        "inliers": inliers,
        "pan_frames": pan_frames,
        "cut_frames": cut_frames,
    }


# ---------------------------------------------------------------------------
# 稳定器: 持有分析结果 + 参数, 计算逐帧矩阵并渲染
# ---------------------------------------------------------------------------

class Stabilizer:
    """分析结果与参数的可变容器。

    修改 :attr:`params` 后调用 :meth:`recompute` 重算派生数据。
    预览端点与导出循环都通过 :meth:`matrix_at` /
    :meth:`render_stabilized` 取帧, 保证完全一致。
    """

    def __init__(self, analysis: dict[str, Any], params: dict[str, Any] | None = None):
        self.analysis = analysis
        self.params: dict[str, Any] = copy.deepcopy(DEFAULT_PARAMS)
        if params:
            self.params.update(copy.deepcopy(params))
        # 兼容旧字段 / 非法区间
        self.params["exclusions"] = [
            dict(x) for x in self.params.get("exclusions", [])
            if isinstance(x, dict) and "start" in x and "end" in x
        ]

        self.width: int = int(analysis["width"])
        self.height: int = int(analysis["height"])
        self.fps: float = float(analysis["fps"])
        self.frame_count: int = int(analysis["frame_count"])

        self.deltas = np.asarray(analysis["deltas"], dtype=np.float64)
        self.trajectory = np.asarray(analysis["trajectory"], dtype=np.float64)
        self.motion = np.asarray(analysis.get("motion", [0] * self.frame_count),
                                 dtype=np.float64)
        self.cut_frames: list[int] = list(analysis.get("cut_frames", []))
        self.pan_frames: list[int] = list(analysis.get("pan_frames", []))

        # 派生数组, recompute() 填充
        self.radius = 1
        self.smoothed = self.trajectory.copy()
        self.correction = np.zeros((self.frame_count, 3), dtype=np.float64)
        self.envelope = np.ones(self.frame_count, dtype=np.float64)
        self.zoom_per_frame = np.ones(self.frame_count, dtype=np.float64)
        self.matrices: list[np.ndarray] = []
        self.auto_zoom: float = 1.0
        self.warnings: list[str] = []

        # 原始帧读取(带锁 + 单帧缓存), 供预览端点使用
        self._cap: cv2.VideoCapture | None = None
        self._cap_lock = threading.RLock()
        self._next_index: int | None = None
        self._cache_index: int | None = None
        self._cache_frame: np.ndarray | None = None

        self.recompute()

    # ---- 序列化 ----------------------------------------------------------

    def to_project_dict(self, name: str | None = None) -> dict[str, Any]:
        return {
            "app": "video-stabilizer-local",
            "version": APP_VERSION,
            "name": name or Path(self.analysis["source_path"]).stem,
            "params": copy.deepcopy(self.params),
            "analysis": copy.deepcopy(self.analysis),
        }

    @classmethod
    def from_project_dict(cls, data: dict[str, Any]) -> "Stabilizer":
        st = cls(data["analysis"], data.get("params", {}))
        return st

    # ---- 参数派生计算 -----------------------------------------------------

    def _shot_segments(self) -> list[tuple[int, int]]:
        """按镜头切换帧把 [0, N) 切成 [start, end) 段。"""
        bounds = sorted({0, self.frame_count, *self.cut_frames})
        segs: list[tuple[int, int]] = []
        for a, b in zip(bounds[:-1], bounds[1:]):
            a = max(0, min(self.frame_count, int(a)))
            b = max(0, min(self.frame_count, int(b)))
            if b > a:
                segs.append((a, b))
        return segs or [(0, self.frame_count)]

    def _build_envelope(self) -> np.ndarray:
        n = self.frame_count
        env = np.ones(n, dtype=np.float64)
        if n == 0:
            return env

        # 区间边界淡入淡出长度约 0.3 秒, 至少 4 帧
        ramp = max(4, int(round(0.30 * self.fps)))

        # 1) 手动不处理区间: 区间内严格为 0(原画面)
        for ex in self.params.get("exclusions", []):
            s = int(ex["start"])
            e = int(ex["end"])
            if s > e:
                s, e = e, s
            s = max(0, min(n - 1, s))
            e = max(0, min(n - 1, e))
            env[s:e + 1] = 0.0
            for k in range(1, ramp + 1):
                w = smoothstep(k / ramp)
                if s - k >= 0:
                    env[s - k] = min(env[s - k], w)
                if e + k < n:
                    env[e + k] = min(env[e + k], w)

        # 2) 镜头切换两侧把校正衰减到 0, 平滑不跨剪辑点
        cut_ramp = min(ramp, max(3, int(round(0.25 * self.fps))))
        for c in self.cut_frames:
            c = int(c)
            if 0 <= c < n:
                env[c] = 0.0
            for k in range(0, cut_ramp):
                w = smoothstep(k / cut_ramp)
                before = c - 1 - k
                after = c + k
                if before >= 0:
                    env[before] = min(env[before], w)
                if 0 <= after < n:
                    env[after] = min(env[after], w if k > 0 else 0.0)

        # 3) 快速摇摄自适应衰减(经高斯平滑, 避免包络本身突变)
        if self.params.get("adaptive_pan", True):
            sens = float(self.params.get("pan_sensitivity", 1.0))
            # 归一化到画面宽度的运动量; sens 越大阈值越低
            norm_motion = self.motion / max(self.width, 1)
            low = 0.020 / max(sens, 0.2)
            high = 0.075 / max(sens, 0.2)
            factor = np.ones(n, dtype=np.float64)
            mask = norm_motion > low
            if np.any(mask):
                t = np.clip((norm_motion - low) / max(high - low, 1e-6), 0.0, 1.0)
                factor = 1.0 - 0.75 * t  # 摇摄峰值只保留 25% 校正
            factor = gaussian_smooth_1d(factor, max(2, self.radius // 2))
            env *= factor

        return np.clip(env, 0.0, 1.0)

    def recompute(self) -> None:
        """根据当前 params 重算平滑轨迹、校正量、逐帧矩阵与自动裁切。"""
        n = self.frame_count
        self.warnings = []
        if n == 0:
            return

        smooth_sec = float(self.params.get("smooth_sec", 0.8))
        smooth_sec = max(0.05, min(4.0, smooth_sec))
        # 窗口全宽 ≈ 2*radius+1, 令全宽对应 smooth_sec
        self.radius = max(1, int(round(smooth_sec * self.fps / 2.0)))

        # 每个镜头内部独立平滑, 不跨越切换点
        self.smoothed = self.trajectory.copy()
        for a, b in self._shot_segments():
            for col in range(3):
                self.smoothed[a:b, col] = gaussian_smooth_1d(
                    self.trajectory[a:b, col], self.radius
                )

        self.envelope = self._build_envelope()
        strength = float(np.clip(self.params.get("strength", 0.85), 0.0, 1.0))

        base = self.smoothed - self.trajectory
        k = self.envelope * strength
        self.correction = base * k[:, None]

        # ---- 自动裁切倍数 -------------------------------------------------
        # 每帧实际缩放 z_i = 1 + (Z-1)*env_i。直接对全局 Z 二分,
        # 用“输出四角像素反算回原图后仍落在画面内”作覆盖判据,
        # 比解析近似更可靠(低包络 / 摇摄衰减 / 区间边界也不会漏)。
        self.auto_zoom = self._auto_zoom_global()
        if self.params.get("crop_mode", "auto") == "auto":
            self.params["crop_zoom"] = round(min(self.auto_zoom, 4.0), 3)

        zoom = float(np.clip(self.params.get("crop_zoom", 1.08), 1.0, 4.0))
        self.params["crop_zoom"] = zoom

        self.zoom_per_frame = 1.0 + (zoom - 1.0) * self.envelope

        self.matrices = [
            self.build_matrix(
                float(self.correction[i, 0]),
                float(self.correction[i, 1]),
                float(self.correction[i, 2]),
                float(self.zoom_per_frame[i]),
                self.width, self.height,
            )
            for i in range(n)
        ]

        # 用同一个精确覆盖判据检查手动裁切是否足够
        black_frames = sum(
            0 if self.matrix_covers(self.matrices[i]) else 1
            for i in range(n)
        )
        if black_frames:
            self.warnings.append(
                f"裁切倍数不足, 约 {black_frames} 帧边缘可能出现黑边, "
                f"建议使用自动裁切或加大裁切范围。"
            )

    @staticmethod
    def build_matrix(dx: float, dy: float, da: float, zoom: float,
                     width: int, height: int) -> np.ndarray:
        """构造 src(原始帧) -> dst(输出帧) 的 2x3 仿射矩阵。

        变换为: 绕画面中心缩放 zoom + 旋转 da, 再平移 (dx, dy)。
        OpenCV warpAffine 默认把该矩阵当作 src->dst 并内部求逆采样。
        """
        ca, sa = math.cos(da), math.sin(da)
        a = zoom * ca
        b = -zoom * sa
        c = zoom * sa
        d = zoom * ca
        cx, cy = width / 2.0, height / 2.0
        tx = cx + dx - (a * cx + b * cy)
        ty = cy + dy - (c * cx + d * cy)
        return np.array([[a, b, tx], [c, d, ty]], dtype=np.float64)

    # 输出四角“像素中心”(注意是 w-1 / h-1, 不是 w / h)
    def _output_corners(self) -> np.ndarray:
        w, h = self.width, self.height
        return np.array(
            [[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]],
            dtype=np.float64,
        )

    def matrix_covers(self, matrix: np.ndarray) -> bool:
        """给定 src->dst 矩阵, 判断输出四角像素是否都能在原图内采样。

        仿射把输出矩形映成原图中的平行四边形, 线性函数的极值在顶点,
        且源画面矩形为凸集, 因此四个角点都在 [0,W-1]x[0,H-1] 内即等价于
        整个输出画面都可采样, 不会出现 CONSTANT 填充(黑边)。
        """
        minv = cv2.invertAffineTransform(matrix)
        corners = self._output_corners()
        hom = np.concatenate([corners, np.ones((4, 1))], axis=1)
        src = (minv @ hom.T).T
        eps = 1e-6
        return bool(
            np.all(src[:, 0] >= -eps)
            and np.all(src[:, 0] <= self.width - 1 + eps)
            and np.all(src[:, 1] >= -eps)
            and np.all(src[:, 1] <= self.height - 1 + eps)
        )

    def _frame_covers_at_global_zoom(self, i: int, global_zoom: float) -> bool:
        env_i = float(self.envelope[i])
        z = 1.0 + (global_zoom - 1.0) * env_i
        m = self.build_matrix(
            float(self.correction[i, 0]),
            float(self.correction[i, 1]),
            float(self.correction[i, 2]),
            z, self.width, self.height,
        )
        return self.matrix_covers(m)

    def _auto_zoom_global(self) -> float:
        """二分求让所有帧都无黑边的最小全局裁切倍数 Z, 向上取 0.005 并留余量。"""
        n = self.frame_count

        def all_covers(z: float) -> bool:
            return all(self._frame_covers_at_global_zoom(i, z) for i in range(n))

        if all_covers(1.0):
            return 1.0
        lo, hi = 1.0, 3.0
        if not all_covers(hi):
            return hi  # 运动过大, 超出常规裁切上限
        for _ in range(18):
            mid = (lo + hi) / 2.0
            if all_covers(mid):
                hi = mid
            else:
                lo = mid
        # 向上取整到 0.005, 再叠加约 0.005 的插值安全余量
        return float(max(1.0, math.ceil((hi + 0.004) * 200.0) / 200.0 + 0.005))

    def matrix_at(self, index: int) -> np.ndarray:
        index = max(0, min(self.frame_count - 1, int(index)))
        return self.matrices[index]

    def is_excluded_frame(self, index: int) -> bool:
        for ex in self.params.get("exclusions", []):
            if int(ex["start"]) <= index <= int(ex["end"]):
                return True
        return False

    def render_stabilized(self, frame: np.ndarray, index: int) -> np.ndarray:
        """把原始 BGR 帧按第 index 帧的参数渲染成稳定画面(全分辨率)。

        导出视频必须调用同一个方法。
        """
        m = self.matrix_at(index)
        return cv2.warpAffine(
            frame, m, (self.width, self.height),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=(0, 0, 0),
        )

    def effective_quad(self, index: int) -> np.ndarray:
        """输出四角反算到原始画面中的四边形(最终有效画幅)。"""
        m = self.matrix_at(index)
        minv = cv2.invertAffineTransform(m)
        w, h = self.width, self.height
        corners = np.array([[0, 0], [w, 0], [w, h], [0, h]], dtype=np.float64)
        hom = np.concatenate([corners, np.ones((4, 1))], axis=1)
        return (minv @ hom.T).T.reshape(-1, 2)

    def draw_overlay(self, frame: np.ndarray, index: int) -> np.ndarray:
        """在原始画面上绘制压暗区与“最终有效画幅”四边形。"""
        out = frame.copy()
        quad = self.effective_quad(index).astype(np.int32)

        mask = np.zeros(out.shape[:2], dtype=np.uint8)
        cv2.fillConvexPoly(mask, quad, 255)
        dark = (out * 0.35).astype(np.uint8)
        out = np.where(mask[:, :, None] == 255, out, dark)

        excluded = self.is_excluded_frame(index)
        color = (120, 120, 120) if excluded else (0, 229, 255)  # BGR 琥珀/青
        cv2.polylines(out, [quad], True, color, max(2, self.width // 500), cv2.LINE_AA)

        # 四角手柄
        r = max(5, self.width // 160)
        for x, y in quad:
            cv2.rectangle(out, (x - r, y - r), (x + r, y + r), (255, 255, 255), 2, cv2.LINE_AA)

        # 中心安全十字
        cx, cy = self.width // 2, self.height // 2
        cv2.line(out, (cx - 18, cy), (cx + 18, cy), (255, 255, 255), 1, cv2.LINE_AA)
        cv2.line(out, (cx, cy - 18), (cx, cy + 18), (255, 255, 255), 1, cv2.LINE_AA)

        tag = "BYPASS 不处理" if excluded else "EFFECTIVE FRAME 有效画幅"
        scale = max(0.5, self.width / 1600.0)
        thickness = max(1, int(round(scale * 1.6)))
        (tw, th), _ = cv2.getTextSize(tag, cv2.FONT_HERSHEY_SIMPLEX, scale, thickness)
        # 顶部居中, 避开左上角的 ORIGINAL 角标
        tx = max(12, (self.width - tw) // 2)
        ty = 22 + th
        cv2.rectangle(out, (tx - 10, ty - th - 9), (tx + tw + 10, ty + 9),
                      (20, 20, 20), -1)
        cv2.putText(out, tag, (tx, ty), cv2.FONT_HERSHEY_SIMPLEX,
                    scale, color, thickness, cv2.LINE_AA)
        return out

    # ---- 原始帧随机读取(预览用) ------------------------------------------

    def _ensure_capture(self) -> cv2.VideoCapture:
        if self._cap is None:
            source = self.analysis["source_path"]
            self._cap = cv2.VideoCapture(source)
            if not self._cap.isOpened():
                self._cap = None
                raise RuntimeError(f"无法打开原片: {source}")
        return self._cap

    def read_frame(self, index: int) -> np.ndarray:
        """按帧号精确读取原始帧。顺序读取走快路径, 否则 seek。

        带单帧缓存: 同一帧被“原图叠加”和“稳定渲染”两个请求使用时
        不会重复解码。
        """
        index = max(0, min(self.frame_count - 1, int(index)))
        with self._cap_lock:
            if self._cache_index == index and self._cache_frame is not None:
                return self._cache_frame
            cap = self._ensure_capture()
            if self._next_index != index:
                cap.set(cv2.CAP_PROP_POS_FRAMES, index)
            ok, frame = cap.read()
            if not ok or frame is None:
                # 少数封装 seek 后需要回退重开
                cap.release()
                self._cap = cv2.VideoCapture(self.analysis["source_path"])
                cap = self._cap
                cap.set(cv2.CAP_PROP_POS_FRAMES, index)
                ok, frame = cap.read()
            if not ok or frame is None:
                raise RuntimeError(f"读取第 {index} 帧失败")
            self._next_index = index + 1
            self._cache_index = index
            self._cache_frame = frame
            return frame

    def close(self) -> None:
        with self._cap_lock:
            if self._cap is not None:
                self._cap.release()
            self._cap = None
            self._cache_frame = None

    # ---- 导出处理参数 -----------------------------------------------------

    def export_params_dict(self) -> dict[str, Any]:
        """生成可独立留存 / 供外部管线使用的逐帧处理参数。"""
        frames = []
        for i in range(self.frame_count):
            m = self.matrices[i]
            frames.append({
                "index": i,
                "time_sec": round(i / self.fps, 6),
                "delta": [round(float(v), 6) for v in self.deltas[i]],
                "trajectory": [round(float(v), 6) for v in self.trajectory[i]],
                "smoothed": [round(float(v), 6) for v in self.smoothed[i]],
                "correction": [round(float(v), 6) for v in self.correction[i]],
                "envelope": round(float(self.envelope[i]), 4),
                "zoom": round(float(self.zoom_per_frame[i]), 5),
                "matrix_src_to_dst": [[round(float(m[r, c]), 8) for c in range(3)]
                                      for r in range(2)],
                "excluded": self.is_excluded_frame(i),
                "cut": i in set(self.cut_frames),
                "fast_pan": i in set(self.pan_frames),
            })
        return {
            "app": "video-stabilizer-local",
            "version": APP_VERSION,
            "source_path": self.analysis["source_path"],
            "width": self.width,
            "height": self.height,
            "fps": self.fps,
            "frame_count": self.frame_count,
            "params": self.params,
            "radius_frames": self.radius,
            "auto_zoom": self.auto_zoom,
            "frames": frames,
        }


def encode_jpeg(frame: np.ndarray, max_width: int = 1280, quality: int = 82) -> bytes:
    """编码预览 JPEG; max_width 仅限制预览尺寸, 不影响导出分辨率。"""
    h, w = frame.shape[:2]
    if max_width and w > max_width:
        nh = int(round(h * max_width / w))
        frame = cv2.resize(frame, (max_width, nh), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise RuntimeError("JPEG 编码失败")
    return buf.tobytes()
