"""二值形态学与连通域, 纯 numpy 实现。

连通性约定(全局统一, 前景和背景孔洞都用同一个):

* 4-连通: 只认上下左右; 对角相接的两个块是不同连通块,
  对角夹住的两个背景点也互不相通。
* 8-连通: 含对角; 对角相接即合并, 背景孔洞同样按对角连通。

mask: bool ndarray, True=墨迹(前景/黑), False=纸张(背景/白)。
"""

from __future__ import annotations

import numpy as np


# --------------------------------------------------------------------------
# 结构元与形态学
# --------------------------------------------------------------------------
def _kernel(connectivity: int) -> np.ndarray:
    """返回与连通性匹配的 3x3 结构元(中心必为 True)。"""
    if connectivity == 4:
        return np.array(
            [[False, True, False], [True, True, True], [False, True, False]],
            dtype=bool,
        )
    if connectivity == 8:
        return np.ones((3, 3), dtype=bool)
    raise ValueError(f"connectivity 只能是 4 或 8, 收到 {connectivity!r}")


def _neighbor_or(padded: np.ndarray, kernel: np.ndarray,
                 out_shape: tuple[int, int]) -> np.ndarray:
    acc = np.zeros(out_shape, dtype=bool)
    for dy in range(3):
        for dx in range(3):
            if kernel[dy, dx]:
                acc |= padded[dy:dy + out_shape[0], dx:dx + out_shape[1]]
    return acc


def dilate(mask: np.ndarray, radius: int, connectivity: int = 8,
           pad_value: bool = False) -> np.ndarray:
    """膨胀。radius 为迭代次数(像素半径), 0 时原样返回。

    每一步都用一圈恒定边界 pad_value 包住当前结果, 保证大半径下
    边界条件不漂移: 前景膨胀时外部算背景(pad_value=False)。
    """
    if radius <= 0:
        return mask.copy()
    k = _kernel(connectivity)
    out = mask.astype(bool).copy()
    for _ in range(int(radius)):
        padded = np.pad(out, 1, mode="constant", constant_values=pad_value)
        out = _neighbor_or(padded, k, out.shape)
    return out


def erode(mask: np.ndarray, radius: int, connectivity: int = 8) -> np.ndarray:
    """腐蚀 = 对背景做膨胀再取反。

    统一边界约定"图像外部=背景": 背景膨胀时外部也按背景(pad=False),
    于是靠近边界的前景会逐层被蚀掉, 全前景图在足够大半径下蚀没,
    与标准形态学语义一致; 结构元与 dilate 相同。
    """
    if radius <= 0:
        return mask.copy()
    return ~dilate(~mask.astype(bool), radius, connectivity, pad_value=False)


def opening(mask: np.ndarray, radius: int, connectivity: int = 8) -> np.ndarray:
    """开运算 = 先腐蚀后膨胀: 去毛刺、去小孤岛, 主体形状基本不动。"""
    if radius <= 0:
        return mask.copy()
    return dilate(erode(mask, radius, connectivity), radius, connectivity)


def closing(mask: np.ndarray, radius: int, connectivity: int = 8) -> np.ndarray:
    """闭运算 = 先膨胀后腐蚀: 补短缝、补小洞, 把窄缺口接上。

    统一边界约定: 图像外部算背景。膨胀 dilate 用 pad=False,
    腐蚀 erode(背景膨胀取反) 用 pad=True, 内部窄缝可被正确填补,
    全白图不会被凭空填上前景。
    """
    if radius <= 0:
        return mask.copy()
    return erode(dilate(mask, radius, connectivity), radius, connectivity)


def remove_small_components(
    mask: np.ndarray, min_size: int, connectivity: int = 8
) -> tuple[np.ndarray, np.ndarray]:
    """移除像素数 < min_size 的前景连通块(小孤岛)。

    返回 (新 mask, 被移除的 label 数组, 0 表示未被移除)。
    min_size <= 1 时不移除任何块。
    """
    labels, n = label_components(mask, connectivity)
    if n == 0:
        return mask.copy(), np.zeros_like(labels)
    sizes = np.bincount(labels.ravel())
    removed_labels = np.zeros(n + 1, dtype=bool)
    for lab in range(1, n + 1):
        if sizes[lab] < min_size:
            removed_labels[lab] = True
    removed_mask = removed_labels[labels]
    out = mask & ~removed_mask
    removed = labels * removed_mask
    return out, removed


# --------------------------------------------------------------------------
# 连通域标记 (两遍扫描 + 并查集, 纯 numpy/python)
# --------------------------------------------------------------------------
class _UnionFind:
    __slots__ = ("parent",)

    def __init__(self) -> None:
        self.parent: list[int] = []

    def add(self) -> int:
        self.parent.append(len(self.parent))
        return len(self.parent) - 1

    def find(self, x: int) -> int:
        root = x
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[x] != x:
            self.parent[x], x = root, self.parent[x]
        return root

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            # 让编号小的当根, 配合扫描顺序可稳定得到从小到大的标签
            if ra < rb:
                self.parent[rb] = ra
            else:
                self.parent[ra] = rb


def label_components(
    mask: np.ndarray, connectivity: int = 8
) -> tuple[np.ndarray, int]:
    """标记连通块。

    返回 (labels, n): labels 为 int32, 背景为 0, 连通块为 1..n;
    n 为连通块数量。标签按"最上再最左"的扫描顺序分配, 同一张图
    重复调用结果完全确定, 这是导出/回读编号一致的基础。
    """
    mask = np.ascontiguousarray(mask.astype(bool))
    h, w = mask.shape
    labels = np.zeros((h, w), dtype=np.int32)
    uf = _UnionFind()
    background = uf.add()  # id 0 固定给背景

    for y in range(h):
        row = mask[y]
        lab_row = labels[y]
        prev_lab_row = labels[y - 1] if y > 0 else None
        x = 0
        while x < w:
            if not row[x]:
                x += 1
                continue
            # 当前前景游程 [x, x_end)
            x_end = x + 1
            while x_end < w and row[x_end]:
                x_end += 1

            neighbor_roots: list[int] = []
            # 同一行左侧游程: 游程起点紧邻前一个像素, 必为 4-邻接
            if x > 0 and lab_row[x - 1] != 0:
                neighbor_roots.append(uf.find(int(lab_row[x - 1])))
            if prev_lab_row is not None:
                lo = x - (1 if connectivity == 8 else 0)
                hi = x_end + (1 if connectivity == 8 else 0)
                lo = max(lo, 0)
                hi = min(hi, w)
                above = prev_lab_row[lo:hi]
                for lab in np.unique(above):
                    if lab != 0:
                        neighbor_roots.append(uf.find(int(lab)))

            if neighbor_roots:
                root = neighbor_roots[0]
                for other in neighbor_roots[1:]:
                    uf.union(root, other)
                    root = uf.find(root)
                run_id = root
            else:
                run_id = uf.add()
            lab_row[x:x_end] = run_id
            x = x_end

    # 解析根 -> 紧凑标签(按根首次出现的顺序, 即扫描顺序)
    root_to_label: dict[int, int] = {background: 0}
    next_label = 1
    flat = labels.ravel()
    for i in range(flat.size):
        rid = flat[i]
        if rid == 0:
            continue
        root = uf.find(int(rid))
        lab = root_to_label.get(root)
        if lab is None:
            lab = next_label
            root_to_label[root] = lab
            next_label += 1
        flat[i] = lab
    return labels, next_label - 1


def component_stats(labels: np.ndarray, n: int) -> list[dict]:
    """每个连通块的统计: 面积(像素数)、质心、外接框。

    列表下标即标签号(第 0 项是占位, 第 i 项对应标签 i),
    方便界面编号和清单互相对上。
    """
    if n == 0:
        return []
    h, w = labels.shape
    flat_lab = labels.ravel()
    counts = np.bincount(flat_lab, minlength=n + 1)

    grid_y, grid_x = np.mgrid[0:h, 0:w]
    sum_y = np.bincount(flat_lab, weights=grid_y.ravel(), minlength=n + 1)
    sum_x = np.bincount(flat_lab, weights=grid_x.ravel(), minlength=n + 1)
    min_y = np.full(n + 1, h, dtype=np.int64)
    max_y = np.full(n + 1, -1, dtype=np.int64)
    min_x = np.full(n + 1, w, dtype=np.int64)
    max_x = np.full(n + 1, -1, dtype=np.int64)
    np.minimum.at(min_y, flat_lab, grid_y.ravel())
    np.maximum.at(max_y, flat_lab, grid_y.ravel())
    np.minimum.at(min_x, flat_lab, grid_x.ravel())
    np.maximum.at(max_x, flat_lab, grid_x.ravel())

    stats: list[dict] = [None]  # type: ignore[list-item]
    for lab in range(1, n + 1):
        area = int(counts[lab])
        stats.append(
            {
                "label": lab,
                "area": area,
                "centroid": (float(sum_y[lab] / area), float(sum_x[lab] / area)),
                "bbox": (
                    int(min_y[lab]),
                    int(min_x[lab]),
                    int(max_y[lab]),
                    int(max_x[lab]),
                ),
            }
        )
    return stats


def find_holes(
    mask: np.ndarray, connectivity: int = 8
) -> tuple[np.ndarray, int, list[dict]]:
    """找背景孔洞: 被墨迹包围、与图像边缘不连通的背景区域。

    返回 (hole_labels, hole_count, stats)。hole_labels 与 mask 同形,
    非孔洞背景和前景都是 0, 第 i 个孔洞标签为 i(从 1 开始, 同样按
    扫描顺序)。背景使用与前景相同的连通性, 保证"对角算连上还是
    分开"这一选项在孔洞上口径一致。
    """
    background = ~mask
    bg_labels, bg_n = label_components(background, connectivity)
    if bg_n == 0:
        return np.zeros_like(bg_labels), 0, []

    h, w = mask.shape
    border_labels = np.unique(
        np.concatenate(
            [
                bg_labels[0, :].ravel(),
                bg_labels[h - 1, :].ravel(),
                bg_labels[:, 0].ravel(),
                bg_labels[:, w - 1].ravel(),
            ]
        )
    )
    exterior = set(int(v) for v in border_labels if v != 0)

    # 重映射成紧凑的孔洞标签
    remap = np.zeros(bg_n + 1, dtype=np.int32)
    hole_no = 0
    stats: list[dict] = [None]  # type: ignore[list-item]
    for bg_lab in range(1, bg_n + 1):
        if bg_lab in exterior:
            continue
        hole_no += 1
        remap[bg_lab] = hole_no
    hole_labels = remap[bg_labels]

    if hole_no:
        counts = np.bincount(hole_labels.ravel())
        ys, xs = np.nonzero(hole_labels > 0)
        flat = hole_labels.ravel()
        sum_y = np.bincount(flat[flat > 0], weights=ys, minlength=hole_no + 1)
        sum_x = np.bincount(flat[flat > 0], weights=xs, minlength=hole_no + 1)
        for lab in range(1, hole_no + 1):
            area = int(counts[lab])
            stats.append(
                {
                    "hole": lab,
                    "area": area,
                    "centroid": (
                        float(sum_y[lab] / area),
                        float(sum_x[lab] / area),
                    ),
                }
            )
    return hole_labels, hole_no, stats
