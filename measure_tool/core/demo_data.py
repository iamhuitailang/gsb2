"""生成“程序画的零件 + 标尺”演示扫描图。

三张图覆盖需求 6 的验证场景，全部带已知真值（单位 mm，scale = 10 px/mm）：

- demo_a_aligned.png：零件正放、标尺与图边平行 —— 基础精度验证；
- demo_b_rotated.png：同一组零件旋转摆放、横纵标尺整体倾斜 —— 斜标尺验证；
- demo_c_edge.png：零件贴着图边被截断、另有一个孔开口与外部连通 —— 不可靠场景。

每张图配套 ground_truth.json，记录标尺端点、零件形状真值与预期测量值，
供 tests 与界面里的“演示标定/验证误差”使用。
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field, asdict
from pathlib import Path

import cv2
import numpy as np

SCALE_PX_PER_MM = 10.0
PAPER = 245
INK = 25


# ---------------------------------------------------------------------- #
# 形状描述（局部坐标，单位 mm，原点在零件中心，x 向右 y 向上）
# ---------------------------------------------------------------------- #
@dataclass
class CircleShape:
    r: float
    kind: str = "circle"


@dataclass
class RectShape:
    w: float
    h: float
    kind: str = "rect"


@dataclass
class Hole:
    shape: dict           # {"kind": "circle", "r": 4} 或 rect
    center: tuple[float, float]
    open_to_exterior: bool = False   # True 时孔与零件外轮廓相交


@dataclass
class PartSpec:
    name: str
    shape: dict
    center_mm: tuple[float, float]   # 相对标尺原点 O 的 (u, v)
    rotation_deg: float = 0.0
    holes: list[Hole] = field(default_factory=list)
    expect_border: bool = False


@dataclass
class RulerSpec:
    name: str
    a: tuple[float, float]
    b: tuple[float, float]
    length_mm: float
    angle_deg: float = 0.0


def _shape_points(shape: dict, n: int = 80) -> np.ndarray:
    """局部毫米坐标下的形状顶点（Nx2，x 右 y 上）。"""
    if shape["kind"] == "circle":
        r = shape["r"]
        t = np.linspace(0, 2 * math.pi, n, endpoint=False)
        return np.column_stack([r * np.cos(t), r * np.sin(t)])
    if shape["kind"] == "rect":
        w, h = shape["w"], shape["h"]
        return np.array([
            [-w / 2, -h / 2], [w / 2, -h / 2],
            [w / 2, h / 2], [-w / 2, h / 2],
        ], dtype=float)
    raise ValueError(shape)


def _rot_matrix(angle_deg: float) -> np.ndarray:
    """局部毫米坐标 -> 标尺 (u, v) 毫米坐标的旋转。

    局部形状按 y 向上定义，而标尺坐标 v 向下。先做 y 轴反射
    (u=x, v=-y) 再做标准旋转 θ，复合后得到本矩阵；
    这样局部 +y 方向的孔在屏幕上确实落在零件的上侧。
    """
    a = math.radians(angle_deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s], [s, c]], dtype=float)


def _world_to_pixel(uv_mm: np.ndarray, origin_px: np.ndarray,
                    u_dir: np.ndarray, v_dir: np.ndarray) -> np.ndarray:
    """标尺毫米坐标 (u,v) -> 像素 (x,y)。输入形状 Nx2。"""
    uv_mm = np.asarray(uv_mm, dtype=float)
    basis = np.column_stack([u_dir, v_dir])  # 每 1 mm 的像素位移
    return origin_px + uv_mm @ basis.T


def _polygon_px(spec: PartSpec, shape: dict, center_mm: tuple[float, float],
                origin_px, u_dir, v_dir) -> np.ndarray:
    local = _shape_points(shape)
    # 局部 y 向上 -> 世界 v 向下
    local = local * np.array([1.0, -1.0])
    r = _rot_matrix(spec.rotation_deg)
    world = local @ r.T + np.array(center_mm)
    return _world_to_pixel(world, origin_px, u_dir, v_dir)


# ---------------------------------------------------------------------- #
# 标尺渲染
# ---------------------------------------------------------------------- #
def _ruler_dirs(rulers: list[RulerSpec]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    h, v = rulers[0], rulers[1]
    origin = np.array(h.a, dtype=float)  # 横尺起点即两尺交点
    u_dir = (np.array(h.b) - np.array(h.a)) / h.length_mm
    v_dir = (np.array(v.b) - np.array(v.a)) / v.length_mm
    return origin, u_dir, v_dir


def _draw_rulers(canvas: np.ndarray, rulers: list[RulerSpec]) -> None:
    for ruler in rulers:
        a = np.array(ruler.a, dtype=float)
        b = np.array(ruler.b, dtype=float)
        direction = b - a
        d = direction / np.linalg.norm(direction)
        normal = np.array([-d[1], d[0]])
        cv2.line(canvas, _i(a), _i(b), INK, 3, cv2.LINE_AA)
        ticks = int(ruler.length_mm)
        for mm in range(ticks + 1):
            p = a + d * (mm * SCALE_PX_PER_MM)
            major = mm % 10 == 0
            tick_len = 14 if major else 8
            p1 = p - normal * tick_len / 2
            p2 = p + normal * tick_len / 2
            cv2.line(canvas, _i(p1), _i(p2), INK, 2 if major else 1)
            if major and 0 < mm < ticks:
                tp = p + normal * 22
                cv2.putText(canvas, str(mm),
                            (int(tp[0]) - 10, int(tp[1]) + 5),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, INK, 1,
                            cv2.LINE_AA)


# ---------------------------------------------------------------------- #
# 主生成函数
# ---------------------------------------------------------------------- #
def generate_scan(path: str | Path, size_px: tuple[int, int],
                  rulers: list[RulerSpec], parts: list[PartSpec],
                  specks: list[tuple[float, float, float]] | None = None,
                  noise_sigma: float = 6.0, seed: int = 0) -> dict:
    """渲染一张演示图并返回 ground truth 字典。

    specks: [(u_mm, v_mm, radius_px), ...] 小黑点噪声。
    """
    rng = np.random.default_rng(seed)
    h, w = size_px
    paper = np.full((h, w), PAPER, dtype=np.uint8)
    _draw_rulers(paper, rulers)

    origin_px, u_dir, v_dir = _ruler_dirs(rulers)

    part_mask = np.zeros((h, w), dtype=np.uint8)   # 1 = 零件墨
    for spec in parts:
        outer_px = _polygon_px(spec, spec.shape, spec.center_mm,
                               origin_px, u_dir, v_dir).astype(np.int32)
        cv2.fillPoly(part_mask, [outer_px], 1)
        for hole in spec.holes:
            # 孔中心局部 y 向上，世界 v 向下
            hole_center = (
                spec.center_mm[0] + hole.center[0],
                spec.center_mm[1] - hole.center[1],
            )
            hole_px = _polygon_px(spec, hole.shape, hole_center,
                                  origin_px, u_dir, v_dir).astype(np.int32)
            cv2.fillPoly(part_mask, [hole_px], 0)  # 挖掉孔（开口孔自然连到外部）

    # 小黑点噪声（独立小墨块）
    for u_mm, v_mm, radius_px in specks or []:
        c = _world_to_pixel(np.array([[u_mm, v_mm]]), origin_px, u_dir, v_dir)[0]
        cv2.circle(part_mask, _i(c), int(radius_px), 1, -1)

    canvas = paper.copy()
    canvas[part_mask > 0] = INK

    # 扫描质感：轻微模糊 + 高斯噪声 + 不均匀底色
    canvas = cv2.GaussianBlur(canvas, (3, 3), 0.8)
    noise = rng.normal(0, noise_sigma, (h, w))
    shade = 8 * np.sin(np.linspace(0, math.pi, w))[None, :]
    canvas = np.clip(canvas.astype(float) + noise + shade, 0, 255).astype(np.uint8)

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), canvas)

    return _ground_truth(path, size_px, rulers, parts, specks or [])


def _ground_truth(path: Path, size_px, rulers: list[RulerSpec],
                  parts: list[PartSpec], specks) -> dict:
    gt = {
        "image": path.name,
        "size_px": list(size_px),
        "scale_px_per_mm": SCALE_PX_PER_MM,
        "rulers": [asdict(r) for r in rulers],
        "parts": [],
        "specks": [list(s) for s in specks],
    }
    for spec in parts:
        entry = {
            "name": spec.name,
            "shape": spec.shape,
            "center_mm": list(spec.center_mm),
            "rotation_deg": spec.rotation_deg,
            "expect_border": spec.expect_border,
            "holes": [],
        }
        # 真值：零件自身坐标系下的宽高与面积
        if spec.shape["kind"] == "rect":
            rw, rh = spec.shape["w"], spec.shape["h"]
            entry["local_width_mm"] = rw
            entry["local_height_mm"] = rh
            entry["outer_area_mm2"] = rw * rh
        else:
            r = spec.shape["r"]
            entry["local_diameter_mm"] = 2 * r
            entry["outer_area_mm2"] = math.pi * r * r
        hole_area = 0.0
        for hole in spec.holes:
            if hole.shape["kind"] == "circle":
                a = math.pi * hole.shape["r"] ** 2
            else:
                a = hole.shape["w"] * hole.shape["h"]
            hole_area += a
            entry["holes"].append({
                "shape": hole.shape,
                "center": list(hole.center),
                "area_mm2": a,
                "open_to_exterior": hole.open_to_exterior,
            })
        entry["hole_area_mm2_enclosed"] = 0.0 if any(
            hh.open_to_exterior for hh in spec.holes) else hole_area
        entry["filled_area_mm2"] = entry["outer_area_mm2"] - hole_area
        gt["parts"].append(entry)
    return gt


# ---------------------------------------------------------------------- #
# 三张标准演示图
# ---------------------------------------------------------------------- #
def _standard_rulers(angle_deg: float = 0.0,
                     size_px: tuple[int, int] = (1000, 1300)
                     ) -> list[RulerSpec]:
    """横 100mm、纵 70mm 的标尺，可整体倾斜。

    约定 v 向上为正，零件布置在 u>0、v>0 的测量区域内。
    """
    a = math.radians(angle_deg)
    c, s = math.cos(a), math.sin(a)
    # 横尺主干探出图片底边、纵尺探出顶边：
    # 标尺整体成为“断到图边的区域”，被单独标记、不会冒充普通零件
    origin = np.array([180.0, size_px[0] + 20.0])
    h_end = origin + np.array([c, s]) * 100 * SCALE_PX_PER_MM
    v_end = origin + np.array([-s, c]) * -(70 * SCALE_PX_PER_MM + 40.0)
    return [
        RulerSpec("横尺", tuple(origin), tuple(h_end), 100.0, angle_deg),
        RulerSpec("纵尺", tuple(origin), tuple(v_end), 70.0, angle_deg),
    ]


def _demo_parts() -> list[PartSpec]:
    """两件零件，全部落在 u∈[0,100]、v∈[0,70] 的有效区域内且互不接触。"""
    return [
        PartSpec(
            name="矩形板",
            shape={"kind": "rect", "w": 50, "h": 25},
            center_mm=(30, 50),
            holes=[
                Hole({"kind": "circle", "r": 3.5}, (-10, 0)),
                Hole({"kind": "circle", "r": 3.5}, (10, 0)),
            ],
        ),
        PartSpec(
            name="圆盘",
            shape={"kind": "circle", "r": 14},
            center_mm=(82, 45),
            holes=[Hole({"kind": "circle", "r": 5}, (0, 0))],
        ),
    ]


def generate_all(demo_dir: str | Path) -> dict:
    demo_dir = Path(demo_dir)
    summary = {"scale_px_per_mm": SCALE_PX_PER_MM, "images": []}

    # A：正放、标尺平行图边
    rulers_a = _standard_rulers(0, (1000, 1300))
    gt_a = generate_scan(
        demo_dir / "demo_a_aligned.png", (1000, 1300), rulers_a,
        _demo_parts(),
        specks=[(8, 8, 2), (90, 10, 2), (50, 60, 2)],
        seed=1,
    )
    summary["images"].append(gt_a)

    # B：零件旋转 25°、标尺整体倾斜 12°
    rulers_b = _standard_rulers(12, (1300, 1500))
    parts_b = []
    for p in _demo_parts():
        parts_b.append(PartSpec(
            name=p.name, shape=p.shape, center_mm=p.center_mm,
            rotation_deg=p.rotation_deg + 25, holes=p.holes,
        ))
    gt_b = generate_scan(
        demo_dir / "demo_b_rotated.png", (1300, 1500), rulers_b,
        parts_b, specks=[(10, 10, 2)], seed=2,
    )
    summary["images"].append(gt_b)

    # C：贴边截断 + 开口孔（不可靠场景）
    rulers_c = _standard_rulers(0, (1000, 1300))
    parts_c = [
        PartSpec(
            name="贴边矩形板",
            shape={"kind": "rect", "w": 60, "h": 40},
            center_mm=(-15, 25),      # 中心在图外左侧，左半被图边裁掉
            holes=[Hole({"kind": "circle", "r": 5}, (12, 0))],
            expect_border=True,
        ),
        PartSpec(
            name="开口孔板",
            shape={"kind": "rect", "w": 50, "h": 40},
            center_mm=(60, 25),
            holes=[
                # 孔圆与零件右边相交 => 与外部连通，不能算封闭孔
                Hole({"kind": "circle", "r": 6}, (22, 0),
                     open_to_exterior=True),
                Hole({"kind": "circle", "r": 4}, (-12, 8)),
            ],
        ),
    ]
    gt_c = generate_scan(
        demo_dir / "demo_c_edge.png", (1000, 1300), rulers_c,
        parts_c, seed=3,
    )
    summary["images"].append(gt_c)

    (demo_dir / "ground_truth.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return summary


def _i(p: np.ndarray) -> tuple[int, int]:
    return int(round(float(p[0]))), int(round(float(p[1])))


if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent / "demo"
    s = generate_all(out)
    print(f"已生成 {len(s['images'])} 张演示图 -> {out}")
