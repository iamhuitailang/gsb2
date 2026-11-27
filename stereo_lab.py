#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
stereo_lab.py — 本机双图(双目)距离估计试验

功能:
  1. 生成同高度、横向错开的左右相机图:场景含带纹理的近/远方板、纯色区、重复花纹区,
     并保留真实视差/距离作参考。
  2. 块匹配估计每点"左右错开多少像素"(视差),显示视差图与误差图;
     点击左图任意位置,可在右图看到它实际使用了哪一块(匹配窗口)。
  3. 对遮挡、重复花纹、缺纹理的点分别给出提示;可切换让不可靠点留空。
  4. 滑条调节允许查找范围(最大视差)和比较区域大小(窗口半径),观察深度边缘附近失误变化。
  5. 导出原始数值(npz)与可信区(mask),并和自带参考对比近处、远处及接边区域的误差(csv)。
  6. 载入外部图像对时,若宽高不一致或左右顺序疑似反了,给出清楚提示;载入失败不影响之前结果。

用法:
  python3 stereo_lab.py            # 打开交互界面
  python3 stereo_lab.py --selftest # 无界面自检(生成场景、估计、导出、打印误差)
"""

import os
import sys
import csv
import time
import argparse
import numpy as np

import matplotlib
if "--selftest" in sys.argv:
    matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
from matplotlib.widgets import Slider, Button

plt.rcParams["font.sans-serif"] = ["PingFang SC", "Hiragino Sans GB", "Arial Unicode MS"]
plt.rcParams["axes.unicode_minus"] = False

# 视差图标志位(bit)
FLAG_OK        = 0
FLAG_BORDER    = 1 << 0   # 太靠近图像边缘,窗口放不下
FLAG_TEXTURELESS = 1 << 1 # 缺纹理(纯色)
FLAG_AMBIGUOUS = 1 << 2   # 重复花纹/匹配不唯一
FLAG_OCCLUDED  = 1 << 3   # 左右互相矛盾,多半被挡住

FLAG_NAMES = [
    (FLAG_BORDER, "边缘"),
    (FLAG_TEXTURELESS, "缺纹理"),
    (FLAG_AMBIGUOUS, "重复花纹"),
    (FLAG_OCCLUDED, "疑似遮挡"),
]


# ---------------------------------------------------------------- 场景生成

def _noise(rng, shape, lo=0.2, hi=0.9):
    return rng.uniform(lo, hi, shape).astype(np.float32)


def make_scene(W=640, H=360, f=600.0, B=0.12, seed=7):
    """生成左右图与参考真值。返回 dict。

    场景(左图坐标):
      背景 Z=6m:缓变噪声;其中一块纯色矩形、一块竖条纹(重复花纹)矩形
      远方板 Z=3m:随机纹理
      近方板 Z=1.5m:随机纹理,与远方板部分重叠(产生遮挡与深度边缘)
    视差 d = B*f/Z,取整数像素,保证块匹配有精确解。
    """
    rng = np.random.default_rng(seed)

    d_bg   = int(round(B * f / 6.0))    # 12
    d_far  = int(round(B * f / 3.0))    # 24
    d_near = int(round(B * f / 1.5))    # 48

    yy, xx = np.mgrid[0:H, 0:W]

    # --- 各层完整纹理(整幅定义,由 mask 决定可见处) ---
    bg = 0.55 + 0.10 * np.sin(xx / 37.0) * np.cos(yy / 53.0) \
           + 0.08 * _noise(rng, (H, W), -1, 1)
    bg = np.clip(bg, 0, 1).astype(np.float32)
    bg_rgb = np.stack([bg, bg * 0.95 + 0.03, bg * 0.9 + 0.05], -1)

    flat_mask = np.zeros((H, W), bool)
    flat_mask[60:180, 470:600] = True            # 纯色区(在背景深度上)
    bg_rgb[flat_mask] = (0.62, 0.60, 0.66)

    rep_mask = np.zeros((H, W), bool)
    rep_mask[210:330, 470:600] = True            # 重复花纹区(背景深度)
    stripe = ((xx // 8) % 2).astype(np.float32)  # 竖条纹,周期16px
    bg_rgb[rep_mask] = np.stack([stripe, stripe, stripe], -1)[rep_mask] * 0.7 + 0.15

    far_img = np.stack([_noise(rng, (H, W)), _noise(rng, (H, W)),
                        _noise(rng, (H, W))], -1) * 0.6 + 0.2
    far_mask = np.zeros((H, W), bool)
    far_mask[60:260, 80:300] = True              # 远方板

    near_img = np.stack([_noise(rng, (H, W)), _noise(rng, (H, W)),
                         _noise(rng, (H, W))], -1) * 0.7 + 0.15
    near_img[..., 0] = np.clip(near_img[..., 0] + 0.15, 0, 1)  # 偏暖色
    near_mask = np.zeros((H, W), bool)
    near_mask[120:330, 240:420] = True           # 近方板(压住远板右缘)

    # 从远到近的层:(整幅纹理, 可见mask, 视差, 深度)
    layers = [
        (bg_rgb.astype(np.float32),   np.ones((H, W), bool), d_bg,   6.0),
        (far_img.astype(np.float32),  far_mask,              d_far,  3.0),
        (near_img.astype(np.float32), near_mask,             d_near, 1.5),
    ]

    def compose(shift):
        """shift=False 合成左图;shift=True 各层按自身视差左移合成右图。"""
        img = np.zeros((H, W, 3), np.float32)
        disp = np.zeros((H, W), np.int16)
        depth = np.full((H, W), np.inf, np.float32)
        for tex, mask, d, z in layers:
            s = d if shift else 0
            m = np.zeros((H, W), bool)
            t = np.zeros_like(tex)
            if s == 0:
                m, t = mask, tex
            else:
                m[:, :W - s] = mask[:, s:]
                t[:, :W - s] = tex[:, s:]
            img[m] = t[m]
            disp[m] = d
            depth[m] = z
        return img, disp, depth

    left, gt_disp, gt_depth = compose(False)
    right, _, _ = compose(True)
    # 统计用区域(左图可见区域)
    near_vis = near_mask
    far_vis = far_mask & ~near_mask
    flat_vis = flat_mask & ~far_mask & ~near_mask
    rep_vis = rep_mask & ~far_mask & ~near_mask

    # 深度接边:视差突变处膨胀几像素
    edge = np.zeros((H, W), bool)
    edge[:, 1:] |= gt_disp[:, 1:] != gt_disp[:, :-1]
    edge[1:, :] |= gt_disp[1:, :] != gt_disp[:-1, :]
    boundary = edge.copy()
    for _ in range(3):  # 简单膨胀
        grown = boundary.copy()
        grown[:, 1:] |= boundary[:, :-1]
        grown[:, :-1] |= boundary[:, 1:]
        grown[1:, :] |= boundary[:-1, :]
        grown[:-1, :] |= boundary[1:, :]
        boundary = grown

    return dict(
        left=left, right=right, gt_disp=gt_disp.astype(np.float32),
        gt_depth=gt_depth, f=f, B=B,
        regions=dict(near=near_vis, far=far_vis, flat=flat_vis,
                     repeat=rep_vis, boundary=boundary),
    )


# ---------------------------------------------------------------- 匹配核心

def box_filter(img, r):
    """(2r+1) 窗口求和,边缘用最近值填充。img: HxW float"""
    k = 2 * r + 1
    p = np.pad(img.astype(np.float32), r, mode="edge")
    c = np.pad(p.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    return c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]


def match_pair(A, B, r, max_d):
    """对 A 中每点,在 B 的同一行向左找 [0,max_d] 范围内 SAD 最小的视差。
    返回 best_d, best_cost, second_cost(排除 best±1 后的次小)。"""
    H, W = A.shape
    vol = np.full((max_d + 1, H, W), np.inf, np.float32)
    for d in range(max_d + 1):
        diff = np.abs(A[:, d:] - B[:, :W - d]).astype(np.float32)
        vol[d, :, d:] = box_filter(diff, r)
    best_d = vol.argmin(0).astype(np.int16)
    best_cost = np.take_along_axis(vol, best_d[None], 0)[0]
    idx = np.arange(max_d + 1)[:, None, None]
    far_from_best = np.abs(idx - best_d[None]) > 1
    second_cost = np.where(far_from_best, vol, np.inf).min(0)
    return best_d, best_cost, second_cost


def compute_disparity(left, right, r, max_d,
                      tex_thresh=0.015, uniq_thresh=1.10):
    """完整估计:视差 + 标志位。left/right: HxWx3 float(0..1)。"""
    L = left.mean(-1).astype(np.float32)
    R = right.mean(-1).astype(np.float32)
    H, W = L.shape

    best_d, best_cost, second = match_pair(L, R, r, max_d)

    # 左右一致性:水平翻转后对调角色匹配(右图点 → 左图)
    d_r, _, _ = match_pair(R[:, ::-1], L[:, ::-1], r, max_d)
    d_r = d_r[:, ::-1]

    flags = np.zeros((H, W), np.uint8)

    # 边缘:窗口或搜索范围越界
    border = np.zeros((H, W), bool)
    border[:r, :] = border[-r:, :] = True
    border[:, :r] = border[:, -r:] = True
    border[:, :max_d + r] = True     # 左起 max_d+r 内搜索不到完整窗口
    flags[border] |= FLAG_BORDER

    # 缺纹理:窗口灰度标准差过低
    k2 = float((2 * r + 1) ** 2)
    mean = box_filter(L, r) / k2
    mean2 = box_filter(L * L, r) / k2
    std = np.sqrt(np.maximum(mean2 - mean * mean, 0))
    flags[std < tex_thresh] |= FLAG_TEXTURELESS

    # 重复花纹/不唯一:次小代价与最小代价太接近
    ratio = second / (best_cost + 1e-6)
    flags[ratio < uniq_thresh] |= FLAG_AMBIGUOUS

    # 疑似遮挡:左右视差互相矛盾
    xs = np.arange(W)[None, :].repeat(H, 0)
    xr = xs - best_d
    valid = xr >= 0
    d_back = np.zeros_like(best_d)
    d_back[valid] = d_r[np.nonzero(valid)[0], xr[valid]]
    inconsistent = valid & (np.abs(d_back - best_d) > 1)
    flags[inconsistent] |= FLAG_OCCLUDED

    confident = flags == FLAG_OK
    disp = best_d.astype(np.float32)
    return disp, flags, confident


def disp_to_depth(disp, f, B):
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(disp > 0, f * B / np.maximum(disp, 1e-6), np.inf)


# ---------------------------------------------------------------- 误差统计

def region_stats(disp, confident, gt_disp, regions):
    """对整体/近板/远板/接边/纯色/花纹分别统计视差误差。返回行列表。"""
    rows = []
    sel_all = {"整体": np.ones_like(confident)}
    sel_all.update(regions)
    for name, mask in sel_all.items():
        sel = mask & confident
        n = int(sel.sum())
        if n == 0:
            rows.append((name, 0, np.nan, np.nan, np.nan))
            continue
        err = np.abs(disp[sel] - gt_disp[sel])
        rows.append((name, n, float(np.median(err)), float(err.mean()),
                     float((err > 1.0).mean() * 100)))
    return rows


def print_stats(rows):
    print(f"{'区域':<8}{'有效点数':>8}{'中位误差px':>12}{'平均误差px':>12}{'失误率>1px%':>12}")
    for name, n, med, mean, bad in rows:
        print(f"{name:<8}{n:>8}{med:>12.2f}{mean:>12.2f}{bad:>12.1f}")


def export_results(path_dir, disp, flags, confident, gt_disp, gt_depth,
                   regions, params, rows):
    os.makedirs(path_dir, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    npz = os.path.join(path_dir, f"stereo_{stamp}.npz")
    np.savez_compressed(
        npz,
        disp_est=np.where(confident, disp, np.nan).astype(np.float32),
        disp_raw=disp.astype(np.float32),
        confident=confident, flags=flags,
        gt_disp=gt_disp if gt_disp is not None else np.array([]),
        gt_depth=gt_depth if gt_depth is not None else np.array([]),
        **{f"region_{k}": v for k, v in regions.items()},
        params=np.array([str(params)]),
    )
    csv_path = os.path.join(path_dir, f"stereo_{stamp}_summary.csv")
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["区域", "有效点数", "中位误差px", "平均误差px", "失误率>1px%"])
        for row in rows:
            w.writerow(row)
    return npz, csv_path


# ---------------------------------------------------------------- 载入校验

def load_pair(path_l, path_r):
    """读入外部图像对。返回 (left, right, message, ok)。
    宽高不一致 -> ok=False;左右疑似反了 -> ok=True 但 message 含警告。"""
    try:
        L = plt.imread(path_l)
        R = plt.imread(path_r)
    except Exception as e:  # noqa: BLE001
        return None, None, f"读图失败:{e}", False
    if L.shape[:2] != R.shape[:2]:
        return None, None, (f"宽高不一致:左图 {L.shape[1]}x{L.shape[0]},"
                            f"右图 {R.shape[1]}x{R.shape[0]},已保留之前的结果"), False
    L = L[..., :3].astype(np.float32)
    R = R[..., :3].astype(np.float32)
    if L.max() > 1.5:
        L, R = L / 255.0, R / 255.0

    # 左右顺序检测:正序与反序各跑一次快速匹配,置信点占比明显更高的一方更可能正确
    def quick_conf(A, B):
        a = A[::4, ::4].mean(-1).astype(np.float32)
        b = B[::4, ::4].mean(-1).astype(np.float32)
        max_d = min(48, a.shape[1] // 4)
        d, c, s = match_pair(a, b, 2, max_d)
        good = (s / (c + 1e-6) > 1.1)
        return good.mean()

    conf_lr = quick_conf(L, R)
    conf_rl = quick_conf(R, L)
    msg = "载入成功"
    if conf_rl > conf_lr * 1.5 and conf_rl > 0.05:
        msg = (f"警告:左右顺序可能反了(正序可匹配 {conf_lr*100:.0f}%,"
               f"反序 {conf_rl*100:.0f}%),已按给定顺序计算,可用「交换左右」纠正")
    return L, R, msg, True


# ---------------------------------------------------------------- 交互界面

class StereoApp:
    def __init__(self):
        self.scene = make_scene()
        self.left = self.scene["left"]
        self.right = self.scene["right"]
        self.gt_disp = self.scene["gt_disp"]
        self.gt_depth = self.scene["gt_depth"]
        self.regions = self.scene["regions"]
        self.f, self.B = self.scene["f"], self.scene["B"]
        self.has_gt = True
        self.r = 4
        self.max_d = 64
        self.hide_unreliable = True
        self.status = "点击左图任意位置查看对应块;拖动滑条后按「重新计算」"
        self._recompute()

    # -- 计算 --
    def _recompute(self):
        self.disp, self.flags, self.confident = compute_disparity(
            self.left, self.right, self.r, self.max_d)
        if self.has_gt:
            self.rows = region_stats(self.disp, self.confident,
                                     self.gt_disp, self.regions)
        else:
            self.rows = []

    # -- 界面 --
    def run(self):
        fig = plt.figure(figsize=(13, 8))
        fig.canvas.manager.set_window_title("双图距离试验")
        gs = fig.add_gridspec(2, 2, left=0.04, right=0.98,
                              top=0.93, bottom=0.22, hspace=0.25, wspace=0.12)
        self.ax_l = fig.add_subplot(gs[0, 0])
        self.ax_r = fig.add_subplot(gs[0, 1])
        self.ax_d = fig.add_subplot(gs[1, 0])
        self.ax_e = fig.add_subplot(gs[1, 1])
        self.fig = fig

        self.ax_l.set_title("左图(点击选点)")
        self.ax_r.set_title("右图(显示对应块)")
        self.im_l = self.ax_l.imshow(self.left)
        self.im_r = self.ax_r.imshow(self.right)

        self.ax_d.set_title("视差图(左右错开的像素数)")
        self.im_d = self.ax_d.imshow(self._disp_for_show(), cmap="viridis",
                                     vmin=0, vmax=self.max_d)
        fig.colorbar(self.im_d, ax=self.ax_d, fraction=0.046)

        self.ax_e.set_title("与参考的误差(像素)")
        self.im_e = self.ax_e.imshow(self._err_for_show(), cmap="hot",
                                     vmin=0, vmax=5)
        fig.colorbar(self.im_e, ax=self.ax_e, fraction=0.046)

        # 点击标记
        self.mark_l = Rectangle((0, 0), 1, 1, fill=False, ec="red", lw=1.5)
        self.mark_r = Rectangle((0, 0), 1, 1, fill=False, ec="lime", lw=1.5)
        self.mark_l.set_visible(False)
        self.mark_r.set_visible(False)
        self.ax_l.add_patch(self.mark_l)
        self.ax_r.add_patch(self.mark_r)
        self.search_line, = self.ax_r.plot([], [], "y-", lw=0.8, alpha=0.7)

        # 状态与点读数
        self.txt_status = fig.text(0.04, 0.155, "", fontsize=9, color="#333")
        self.txt_pick = fig.text(0.04, 0.12, "", fontsize=10, color="#005")
        self._set_status(self.status)

        # 滑条
        ax_win = fig.add_axes([0.06, 0.055, 0.28, 0.03])
        ax_rng = fig.add_axes([0.42, 0.055, 0.28, 0.03])
        self.sl_win = Slider(ax_win, "比较区域半径", 1, 12,
                             valinit=self.r, valstep=1)
        self.sl_rng = Slider(ax_rng, "最大查找范围", 16, 96,
                             valinit=self.max_d, valstep=8)
        self.sl_win.on_changed(lambda v: setattr(self, "r", int(v)))
        self.sl_rng.on_changed(lambda v: setattr(self, "max_d", int(v)))

        # 按钮
        self._buttons = []
        for i, (label, fn) in enumerate([
            ("重新计算", self._on_recompute),
            ("留空开/关", self._on_toggle),
            ("导出数据", self._on_export),
            ("载入图像对", self._on_load),
            ("交换左右", self._on_swap),
        ]):
            ax = fig.add_axes([0.75, 0.13 - i * 0.028, 0.2, 0.024])
            b = Button(ax, label)
            b.on_clicked(fn)
            self._buttons.append(b)

        fig.canvas.mpl_connect("button_press_event", self._on_click)
        self._refresh_maps()
        plt.show()

    def _set_status(self, msg):
        self.status = msg
        self.txt_status.set_text("状态:" + msg)

    def _disp_for_show(self):
        d = self.disp.copy()
        if self.hide_unreliable:
            d = np.where(self.confident, d, np.nan)
        return np.ma.masked_invalid(d)

    def _err_for_show(self):
        if not self.has_gt:
            return np.zeros_like(self.disp)
        err = np.abs(self.disp - self.gt_disp)
        return np.ma.masked_where(~self.confident, err)

    def _refresh_maps(self):
        self.im_l.set_data(self.left)
        self.im_r.set_data(self.right)
        self.im_d.set_data(self._disp_for_show())
        self.im_d.set_clim(0, self.max_d)
        self.im_e.set_data(self._err_for_show())
        ttl = "与参考的误差(像素)" if self.has_gt else "外部图像:无参考真值"
        self.ax_e.set_title(ttl)
        self.fig.canvas.draw_idle()

    # -- 事件 --
    def _on_recompute(self, _=None):
        self._recompute()
        self._refresh_maps()
        if self.has_gt:
            bad = self.rows[0]
            self._set_status(f"已重算(窗口半径 {self.r},范围 {self.max_d});"
                             f"整体中位误差 {bad[2]:.2f}px")
        else:
            self._set_status(f"已重算(窗口半径 {self.r},范围 {self.max_d})")

    def _on_toggle(self, _=None):
        self.hide_unreliable = not self.hide_unreliable
        self._refresh_maps()
        self._set_status("不可靠点已" + ("留空" if self.hide_unreliable else "显示"))

    def _on_export(self, _=None):
        params = dict(win_r=self.r, max_d=self.max_d, f=self.f, B=self.B,
                      has_gt=self.has_gt)
        npz, csv_path = export_results(
            "exports", self.disp, self.flags, self.confident,
            self.gt_disp if self.has_gt else None,
            self.gt_depth if self.has_gt else None,
            self.regions, params, self.rows)
        self._set_status(f"已导出:{npz} 和 {csv_path}")

    def _on_load(self, _=None):
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk(); root.withdraw()
            p1 = filedialog.askopenfilename(title="选择左图")
            if not p1:
                return
            p2 = filedialog.askopenfilename(title="选择右图")
            root.destroy()
            if not p2:
                return
        except Exception:  # noqa: BLE001
            p1 = input("左图路径: ").strip()
            p2 = input("右图路径: ").strip()
        L, R, msg, ok = load_pair(p1, p2)
        if not ok:
            self._set_status(msg + "(之前的结果仍可查看)")
            return
        # 校验通过才替换状态
        self.left, self.right = L, R
        self.has_gt = False
        self._recompute()
        self._refresh_maps()
        self._set_status(msg)

    def _on_swap(self, _=None):
        self.left, self.right = self.right, self.left
        self._recompute()
        self._refresh_maps()
        self._set_status("已交换左右图并重算")

    def _on_click(self, ev):
        if ev.inaxes is not self.ax_l or ev.xdata is None:
            return
        x, y = int(ev.xdata), int(ev.ydata)
        H, W = self.disp.shape
        if not (0 <= x < W and 0 <= y < H):
            return
        d = self.disp[y, x]
        fl = int(self.flags[y, x])
        names = [n for bit, n in FLAG_NAMES if fl & bit]
        state = "可信" if fl == 0 else "不可靠:" + "/".join(names)
        depth = disp_to_depth(d, self.f, self.B)
        depth_s = f"{depth:.2f}m(标称)" if np.isfinite(depth) else "∞"
        gt_s = (f",参考视差 {self.gt_disp[y, x]:.0f}px/"
                f"{self.gt_depth[y, x]:.1f}m" if self.has_gt else ",无参考")
        self.txt_pick.set_text(
            f"选中 ({x},{y}):视差 {d:.0f}px → 距离 {depth_s}{gt_s},{state}")

        r = self.r
        self.mark_l.set_bounds(x - r, y - r, 2 * r + 1, 2 * r + 1)
        self.mark_l.set_visible(True)
        xr = x - d
        if 0 <= xr < W:
            self.mark_r.set_bounds(xr - r, y - r, 2 * r + 1, 2 * r + 1)
            self.mark_r.set_visible(True)
        else:
            self.mark_r.set_visible(False)
        self.search_line.set_data([max(0, x - self.max_d), x], [y, y])
        self.fig.canvas.draw_idle()


# ---------------------------------------------------------------- 自检

def selftest():
    print("== 生成场景 ==")
    sc = make_scene()
    print(f"图像 {sc['left'].shape[1]}x{sc['left'].shape[0]},"
          f"参考视差 近/远/背景 = 48/24/12 px")

    print("\n== 估计(窗口半径4,范围64)==")
    disp, flags, confident = compute_disparity(sc["left"], sc["right"], 4, 64)
    rows = region_stats(disp, confident, sc["gt_disp"], sc["regions"])
    print_stats(rows)

    print("\n== 标志覆盖情况 ==")
    for bit, name in FLAG_NAMES:
        print(f"  {name:<6}{int((flags & bit > 0).sum()):>8} 像素")

    # 基本断言:近板应很准,纯色区应大多被标记缺纹理
    near = sc["regions"]["near"] & confident
    assert np.median(np.abs(disp[near] - sc["gt_disp"][near])) <= 1.0, "近板误差过大"
    flat = sc["regions"]["flat"]
    assert (flags[flat] & FLAG_TEXTURELESS > 0).mean() > 0.8, "纯色区未被识别为缺纹理"
    rep = sc["regions"]["repeat"]
    assert (flags[rep] & FLAG_AMBIGUOUS > 0).mean() > 0.5, "重复花纹区未被识别"

    print("\n== 导出 ==")
    npz, csv_path = export_results(
        "exports", disp, flags, confident, sc["gt_disp"], sc["gt_depth"],
        sc["regions"], dict(win_r=4, max_d=64), rows)
    print(f"  {npz}\n  {csv_path}")

    print("\n== 载入校验 ==")
    os.makedirs("exports/_selftest", exist_ok=True)
    plt.imsave("exports/_selftest/L.png", sc["left"])
    plt.imsave("exports/_selftest/R.png", sc["right"])
    plt.imsave("exports/_selftest/R_small.png", sc["right"][::2, ::2])

    _, _, msg, ok = load_pair("exports/_selftest/L.png", "exports/_selftest/R_small.png")
    print(f"  宽高不一致 -> ok={ok}, 提示:{msg}")
    assert not ok

    _, _, msg, ok = load_pair("exports/_selftest/R.png", "exports/_selftest/L.png")
    print(f"  左右反序   -> ok={ok}, 提示:{msg}")
    assert ok and "反" in msg

    _, _, msg, ok = load_pair("exports/_selftest/L.png", "exports/_selftest/R.png")
    print(f"  正常顺序   -> ok={ok}, 提示:{msg}")
    assert ok and "警告" not in msg

    print("\n自检通过 ✔")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        selftest()
    else:
        StereoApp().run()
