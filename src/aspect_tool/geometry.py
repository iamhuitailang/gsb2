"""纯几何: 旋转 / 非方形像素方形化 / fit / crop 的坐标映射。

本模块不调用 ffmpeg, 只用有理数与 3x3 仿射矩阵, 保证标记点映射可单测、
与实际转码滤镜链 (ffmpeg.py 中构造) 语义一致。

坐标约定
--------
所有坐标都是帧平面上的 **像素中心** 坐标, 原点在左上角, x 向右、y 向下,
单位为对应平面的像素 (存储平面 / 显示平面 / 输出平面各自独立)。

三个平面:
  S  存储帧平面 (stored), 尺寸 sw x sh, 像素可能非方形 (sar != 1)
  D  显示平面 (display), 即播放器在屏幕上呈现的方形像素画面,
     先对 S 做显示矩阵 (旋转/翻转) 再做像素宽高比修正得到
  O  输出平面 (output), 转码后的真实帧, 方形像素 (sar=1), 尺寸 ow x oh

标记点映射链: S -> D -> O (另提供 O -> S 反查, 用于核对)。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from fractions import Fraction

# ---------------------------------------------------------------------------
# 3x3 仿射矩阵 (行主序), 作用于列向量 [x, y, 1]^T
# 仅使用仿射 (最后一行固定 0,0,1), 用 Fraction 保持精确。
# ---------------------------------------------------------------------------

Matrix = tuple[Fraction, Fraction, Fraction,
               Fraction, Fraction, Fraction,
               Fraction, Fraction, Fraction]

IDENTITY: Matrix = (Fraction(1), Fraction(0), Fraction(0),
                    Fraction(0), Fraction(1), Fraction(0),
                    Fraction(0), Fraction(0), Fraction(1))


def mat_mul(a: Matrix, b: Matrix) -> Matrix:
    """矩阵乘法 a*b (先施加 b 再施加 a)。"""
    out = []
    for r in range(3):
        for c in range(3):
            out.append(sum(a[r * 3 + k] * b[k * 3 + c] for k in range(3)))
    return tuple(out)  # type: ignore[return-value]


def mat_apply(m: Matrix, x: float, y: float) -> tuple[float, float]:
    """把仿射矩阵作用到一个点。"""
    xf, yf = Fraction(x), Fraction(y)
    nx = m[0] * xf + m[1] * yf + m[2]
    ny = m[3] * xf + m[4] * yf + m[5]
    return float(nx), float(ny)


def mat_invert(m: Matrix) -> Matrix:
    """仿射矩阵求逆 (左上 2x2 必须可逆)。"""
    a, b, c, d, e, f = m[0], m[1], m[2], m[3], m[4], m[5]
    det = a * e - b * d
    if det == 0:
        raise ValueError("singular affine matrix")
    inv = (e / det, -b / det, (b * f - c * e) / det,
           -d / det, a / det, (c * d - a * f) / det,
           Fraction(0), Fraction(0), Fraction(1))
    return inv


def _rot90_cw() -> Matrix:
    # (x,y) -> (-y, x), 之后配合平移归位
    return (Fraction(0), Fraction(-1), Fraction(0),
            Fraction(1), Fraction(0), Fraction(0),
            Fraction(0), Fraction(0), Fraction(1))


def _rot180() -> Matrix:
    return (Fraction(-1), Fraction(0), Fraction(0),
            Fraction(0), Fraction(-1), Fraction(0),
            Fraction(0), Fraction(0), Fraction(1))


def _rot270_cw() -> Matrix:
    return (Fraction(0), Fraction(1), Fraction(0),
            Fraction(-1), Fraction(0), Fraction(0),
            Fraction(0), Fraction(0), Fraction(1))


def _flip_h() -> Matrix:
    """水平翻转 (左右镜像)。"""
    return (Fraction(-1), Fraction(0), Fraction(0),
            Fraction(0), Fraction(1), Fraction(0),
            Fraction(0), Fraction(0), Fraction(1))


# ---------------------------------------------------------------------------
# 显示矩阵解析
# ---------------------------------------------------------------------------

@dataclass
class DisplayTransform:
    """从存储平面 S 到显示平面 D 的几何描述。

    cw_deg: 显示时对存储帧施加的 **顺时针** 角度 (0/90/180/270)。
            注意 ffprobe 的 rotation 字段是逆时针, 入口处已换算。
    flip:   是否同时做水平镜像 (显示矩阵行列式为负)。
    sw/sh:  存储宽高; dw/dh: 显示宽高 (方形像素, 已含旋转换轴与 SAR)。
    sar:    存储像素的 sample aspect ratio (像素宽/高)。
    """

    sw: int
    sh: int
    cw_deg: int
    flip: bool
    sar: Fraction
    exact_orthogonal: bool = True
    raw_rotation_ccw: float | None = None
    notes: list[str] = field(default_factory=list)

    @property
    def swapped(self) -> bool:
        return self.cw_deg in (90, 270)

    @property
    def dw(self) -> int:
        """显示平面宽 (整数, 偶数对齐, 与 ffmpeg scale 行为一致)。"""
        if self.swapped:
            # 旋转 90/270 后换轴: 显示宽来自存储高, 像素高度方向对应 sar
            return _round_even(Fraction(self.sh) / self.sar)
        return _round_even(Fraction(self.sw) * self.sar)

    @property
    def dh(self) -> int:
        if self.swapped:
            # 换轴后显示高来自存储宽 * sar
            return _round_even(Fraction(self.sw) * self.sar)
        # 不换轴: 高度方向像素 1:1, 显示高就是存储高
        return self.sh

    def matrix_s_to_d(self) -> Matrix:
        """返回 S(像素中心坐标) -> D(像素中心坐标) 的完整仿射矩阵。

        步骤: 旋转(含归位平移) -> 镜像 -> 非方形像素缩放。
        镜像在旋转之后, 与 ffmpeg 滤镜链 (transpose 后 hflip) 顺序一致,
        已经过 autorotate 像素级核对。
        """
        m = IDENTITY
        # 1) 90 度倍数旋转, 并把结果平移回非负坐标
        if self.cw_deg == 90:
            m = mat_mul(_translate(self.sh - 1, 0), mat_mul(_rot90_cw(), m))
        elif self.cw_deg == 180:
            m = mat_mul(_translate(self.sw - 1, self.sh - 1), mat_mul(_rot180(), m))
        elif self.cw_deg == 270:
            m = mat_mul(_translate(0, self.sw - 1), mat_mul(_rot270_cw(), m))
        # 2) 水平镜像 (旋转之后), 在旋转后的帧宽内做 x 翻转
        if self.flip:
            rot_w = self.sh if self.swapped else self.sw
            m = mat_mul(_translate(rot_w - 1, 0), mat_mul(_flip_h(), m))
        # 3) 非方形像素 -> 方形像素。旋转换轴后, SAR 作用轴随之交换。
        sx, sy = self._square_scale()
        m = mat_mul(_scale(sx, sy), m)
        return m

    def _square_scale(self) -> tuple[Fraction, Fraction]:
        """旋转之后、在中间帧平面上做方形化的 x/y 缩放。

        不换轴: 中间帧 sw x sh, 像素宽高比 sar -> 显示宽 sw*sar, 高不变,
                缩放 (sar, 1)。
        换轴(90/270): 中间帧 sh x sw, 其 x 轴来自原像素的 y 方向、
                y 轴来自原像素的 x 方向 -> 缩放 (1/sar, sar)。
        """
        if self.swapped:
            return Fraction(1) / self.sar, self.sar
        return self.sar, Fraction(1)


def _round_even(value: Fraction) -> int:
    """四舍五入到最近的偶数 (与 ffmpeg scale 默认取偶宽高对齐)。"""
    n = round(value)
    return n if n % 2 == 0 else n + 1


def _translate(tx: Fraction | int, ty: Fraction | int) -> Matrix:
    return (Fraction(1), Fraction(0), Fraction(tx),
            Fraction(0), Fraction(1), Fraction(ty),
            Fraction(0), Fraction(0), Fraction(1))


def _scale(sx: Fraction, sy: Fraction) -> Matrix:
    return (sx, Fraction(0), Fraction(0),
            Fraction(0), sy, Fraction(0),
            Fraction(0), Fraction(0), Fraction(1))


# ---------------------------------------------------------------------------
# 从 ffprobe 的原始字段构造 DisplayTransform
# ---------------------------------------------------------------------------

def build_display_transform(
    sw: int,
    sh: int,
    sar: Fraction,
    rotation_ccw: float | None,
    matrix: tuple[float, ...] | None = None,
) -> DisplayTransform:
    """把 ffprobe 原始信息转成 DisplayTransform。

    rotation_ccw: ffprobe side_data 的 rotation (逆时针度数, 如 -90)。
                  这是角度的主依据; matrix 仅用于检测翻转与非正交。
    matrix: 可选的完整 3x3 显示矩阵 (9 个数, BMFF 16.16 定点已转 float)。
    """
    notes: list[str] = []
    flip = False
    exact = True
    cw_deg = 0
    have_matrix = matrix is not None and any(abs(v) > 1e-9 for v in matrix)

    if have_matrix:
        # BMFF 矩阵: [a b u; c d v; x y w], 取左上 2x2
        a, b, c, d = matrix[0], matrix[1], matrix[3], matrix[4]
        det = a * d - b * c
        flip = det < -1e-6

    if have_matrix and flip:
        # 镜像矩阵 (det<0): ffprobe 的 rotation 标量不能完整表达,
        # 直接按矩阵主轴分量推断旋转角度
        a, b, c, d = matrix[0], matrix[1], matrix[3], matrix[4]
        if abs(a) > 0.5 or abs(d) > 0.5:
            cw_deg = 0 if a > 0 else 180
        else:
            # 结合 ffprobe 标量旋转方向辅助定 90/270
            cw = -(rotation_ccw or 0)
            cw_deg = (int(round(cw / 90.0)) * 90) % 360
    elif rotation_ccw is not None and abs(rotation_ccw) > 1e-6:
        # 纯旋转: ffprobe 逆时针 r -> 显示顺时针 -r, 归一到 90 度倍数
        cw = -rotation_ccw
        nearest = round(cw / 90.0) * 90
        if abs(cw - nearest) > 1e-3:
            exact = False
            notes.append(f"旋转角 {rotation_ccw:g}° 不是 90° 的整数倍, 需要用户确认")
        elif have_matrix:
            # 角度声称正交, 但矩阵主轴分量离 0/1 都很远 -> 矩阵与角度矛盾
            if any(0.15 < abs(v) < 0.85 for v in matrix[:4]):
                exact = False
                notes.append("显示矩阵与旋转角度不符 (疑似任意角度), 需要用户确认")
        cw_deg = int(nearest) % 360
    elif have_matrix:
        # 没有 rotation 字段, 仅靠矩阵推断
        a, b, c, d = matrix[0], matrix[1], matrix[3], matrix[4]
        if any(1e-6 < abs(v) < 1.0 - 1e-3 for v in (a, b, c, d)):
            exact = False
            notes.append("显示矩阵为任意角度旋转 (非 0/90/180/270), 需要用户确认")
        elif abs(a) > 0.5 and abs(d) > 0.5:
            cw_deg = 180 if (a < 0 and d < 0) else 0
        elif abs(b) > 0.5 or abs(c) > 0.5:
            cw_deg = 270 if b > 0 else 90

    return DisplayTransform(
        sw=sw, sh=sh, cw_deg=cw_deg, flip=flip, sar=Fraction(sar),
        exact_orthogonal=exact, raw_rotation_ccw=rotation_ccw, notes=notes,
    )


# ---------------------------------------------------------------------------
# 输出平面规划: fit (保留全画面, 补黑边) / crop (裁到目标画幅)
# ---------------------------------------------------------------------------

@dataclass
class OutputPlan:
    """从显示平面 D 到输出平面 O 的规划。"""

    mode: str               # "fit" | "crop"
    ow: int
    oh: int
    # 有效画面 (来自 D 的内容) 在 O 中的像素中心包围盒 [x0,y0,x1,y1]
    active_box: tuple[float, float, float, float]
    # 裁切模式下, D 中实际进入 O 的区域 (D 坐标包围盒); fit 模式为整幅 D
    crop_box_in_d: tuple[float, float, float, float]
    matrix_d_to_o: Matrix
    matrix_o_to_d: Matrix

    @property
    def letterbox(self) -> bool:
        x0, y0, x1, y1 = self.active_box
        return x0 > 0.5 or y0 > 0.5 or x1 < self.ow - 1.5 or y1 < self.oh - 1.5


def plan_output(dt: DisplayTransform, ow: int, oh: int, mode: str) -> OutputPlan:
    """根据目标输出宽高与模式规划 D -> O。

    fit:  等比缩放整幅 D 使其完整落入 ow x oh, 不足部分补黑边。
    crop: 等比缩放使 D 铺满 ow x oh, 溢出部分裁掉 (active_box 即整幅 O)。
    所有缩放都在方形像素平面之间进行, 因此圆形保持圆形。
    """
    dw, dh = dt.dw, dt.dh
    target_ar = Fraction(ow, oh)
    d_ar = Fraction(dw, dh)

    if mode == "fit":
        if d_ar > target_ar:
            # D 更宽 -> 上下补黑边, 宽铺满
            scaled_w = ow
            scaled_h = _round_even(Fraction(ow) * dh / dw)
        else:
            # D 更高 -> 左右补黑边, 高铺满
            scaled_w = _round_even(Fraction(oh) * dw / dh)
            scaled_h = oh
        off_x = (ow - scaled_w) / 2.0
        off_y = (oh - scaled_h) / 2.0
        sx = Fraction(scaled_w, dw)
        sy = Fraction(scaled_h, dh)
        m = mat_mul(_translate(Fraction(off_x), Fraction(off_y)), _scale(sx, sy))
        active = (off_x, off_y, off_x + scaled_w - 1, off_y + scaled_h - 1)
        crop_in_d = (0.0, 0.0, float(dw - 1), float(dh - 1))
    elif mode == "crop":
        if d_ar > target_ar:
            # D 更宽 -> 左右裁切
            kept_w = _round_even(dh * target_ar)
            cut = (dw - kept_w) / 2.0
            crop_in_d = (cut, 0.0, cut + kept_w - 1, float(dh - 1))
        else:
            kept_h = _round_even(dw / target_ar)
            cut = (dh - kept_h) / 2.0
            crop_in_d = (0.0, cut, float(dw - 1), cut + kept_h - 1)
        x0, y0, x1, y1 = crop_in_d
        cw, ch = x1 - x0 + 1, y1 - y0 + 1
        sx = Fraction(ow, Fraction(cw))
        sy = Fraction(oh, Fraction(ch))
        # 先平移让裁剪区左上角到原点, 再缩放铺满 O
        m = mat_mul(_scale(sx, sy), _translate(Fraction(-x0), Fraction(-y0)))
        active = (0.0, 0.0, float(ow - 1), float(oh - 1))
    else:
        raise ValueError(f"unknown mode {mode!r}, expect 'fit' or 'crop'")

    return OutputPlan(
        mode=mode, ow=ow, oh=oh, active_box=active,
        crop_box_in_d=crop_in_d,
        matrix_d_to_o=m, matrix_o_to_d=mat_invert(m),
    )


# ---------------------------------------------------------------------------
# 端到端标记点映射
# ---------------------------------------------------------------------------

@dataclass
class MappedPoint:
    sx: float
    sy: float
    dx: float
    dy: float
    ox: float | None = None
    oy: float | None = None
    visible: bool = True          # 在输出画面中是否可见 (fit 总为 True)
    in_black_border: bool = False  # 是否落在黑边区
    note: str = ""


@dataclass
class GeometryPipeline:
    """串起 S -> D -> O 的完整管线, 负责标记点映射与区域查询。"""

    dt: DisplayTransform
    plan: OutputPlan

    @property
    def m_s_to_d(self) -> Matrix:
        return self.dt.matrix_s_to_d()

    @property
    def m_d_to_o(self) -> Matrix:
        return self.plan.matrix_d_to_o

    @property
    def m_s_to_o(self) -> Matrix:
        return mat_mul(self.m_d_to_o, self.m_s_to_d)

    @property
    def m_o_to_s(self) -> Matrix:
        return mat_invert(self.m_s_to_o)

    def map_point_s_to_o(self, x: float, y: float) -> MappedPoint:
        dx, dy = mat_apply(self.m_s_to_d, x, y)
        ox, oy = mat_apply(self.m_d_to_o, dx, dy)
        visible = True
        in_black = False
        note = ""
        if self.plan.mode == "fit":
            ax0, ay0, ax1, ay1 = self.plan.active_box
            if not (ax0 - 0.5 <= ox <= ax1 + 0.5 and ay0 - 0.5 <= oy <= ay1 + 0.5):
                in_black = True
        else:  # crop
            if not (-0.5 <= ox < self.plan.ow - 0.5 and -0.5 <= oy < self.plan.oh - 0.5):
                visible = False
                note = "该点在裁切区外, 不会出现在输出中"
        return MappedPoint(x, y, dx, dy, ox, oy, visible, in_black, note)

    def map_point_o_to_s(self, ox: float, oy: float) -> tuple[float, float]:
        """反查输出平面上的点对应存储平面的位置。"""
        return mat_apply(self.m_o_to_s, ox, oy)

    def active_box_output(self) -> tuple[float, float, float, float]:
        return self.plan.active_box

    def cropped_region_in_d(self) -> tuple[float, float, float, float] | None:
        return self.plan.crop_box_in_d if self.plan.mode == "crop" else None


def default_target(dt: DisplayTransform, max_side: int = 720) -> tuple[int, int]:
    """不显式给目标画幅时, 取显示平面的等比缩小尺寸 (长边 max_side, 偶数对齐)。"""
    dw, dh = dt.dw, dt.dh
    if dw >= dh:
        ow = min(max_side, dw)
        oh = _round_even(Fraction(ow) * dh / dw)
    else:
        oh = min(max_side, dh)
        ow = _round_even(Fraction(oh) * dw / dh)
    return max(2, ow), max(2, oh)
