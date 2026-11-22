#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sdf_tool.py — 黑白遮罩 → 有符号距离场(SDF) 的本机转换/核对工具

功能：
  1. 从灰度图或透明(Alpha)通道取遮罩，阈值可调，界面高亮实际被视为"内部"的像素
  2. 精确欧氏有符号距离变换（内正外负），显示可编码距离上下限；
     孔洞与互不相连的多块形状都按各自最近边界计算，不是只按最外圈
  3. 点击任意像素：同时显示 距离值 / 归一化灰度 / 最近边界位置，
     配合内置示例可分别核对直边、内角、交界处
  4. 从距离图预览不同轮廓粗细、不同缩放下的重建效果，
     并量化说明哪些细节因尺寸或量化丢失
  5. 导出 16 位距离图 PNG + 参数 JSON；读回时按参数重建轮廓，不覆盖原遮罩
  6. 内置示例：圆环(带孔)、细缝、斜边、两块分离、全空、全满

用法：
  python3 sdf_tool.py            启动图形界面
  python3 sdf_tool.py --selftest 无界面自检（距离变换正确性/编解码往返/退化输入）
"""

import json
import math
import os
import sys

import numpy as np
from PIL import Image

# ----------------------------------------------------------------------
# 精确欧氏距离变换（Felzenszwalb & Huttenlocher），纯 numpy 实现
# 同时返回最近特征点(边界像素)坐标 —— 点击核对"最近边界位置"靠它
# ----------------------------------------------------------------------

_INF = 1e18


def _edt_1d(f):
    """一维平方距离变换。f[i]=0 表示特征点，否则为 inf。
    返回 (d, idx)：d[i] 为到最近特征点的平方距离，idx[i] 为该特征点下标。"""
    n = f.shape[0]
    d = np.empty(n, dtype=np.float64)
    idx = np.empty(n, dtype=np.int64)
    v = np.zeros(n, dtype=np.int64)   # 抛物线下包络中的特征点
    z = np.zeros(n + 1, dtype=np.float64)  # 相邻抛物线交点
    k = 0
    v[0] = 0
    z[0] = -_INF
    z[1] = _INF
    for q in range(1, n):
        p = v[k]
        s = ((f[q] + q * q) - (f[p] + p * p)) / (2.0 * (q - p))
        while s <= z[k]:
            k -= 1
            p = v[k]
            s = ((f[q] + q * q) - (f[p] + p * p)) / (2.0 * (q - p))
        k += 1
        v[k] = q
        z[k] = s
        z[k + 1] = _INF
    k = 0
    for q in range(n):
        while z[k + 1] < q:
            k += 1
        p = v[k]
        d[q] = (q - p) * (q - p) + f[p]
        idx[q] = p
    return d, idx


def edt2d(feature):
    """二维欧氏距离变换。
    feature: 布尔数组，True 处为零距离特征点（边界像素）。
    返回 (dist, sy, sx)：欧氏距离与最近特征点的 (行,列) 坐标。
    若 feature 全 False，dist 全为 inf。"""
    h, w = feature.shape
    f = np.where(feature, 0.0, _INF)
    d1 = np.empty((h, w), dtype=np.float64)
    r1 = np.empty((h, w), dtype=np.int64)
    for x in range(w):  # 先沿列方向（每列内找最近特征行）
        d1[:, x], r1[:, x] = _edt_1d(f[:, x])
    d2 = np.empty((h, w), dtype=np.float64)
    c2 = np.empty((h, w), dtype=np.int64)
    for y in range(h):  # 再沿行方向
        d2[y, :], c2[y, :] = _edt_1d(d1[y, :])
    rows = np.arange(h)[:, None]
    sy = r1[rows, c2]
    sx = c2
    with np.errstate(invalid="ignore"):
        dist = np.sqrt(d2)
    return dist, sy, sx


# ----------------------------------------------------------------------
# 遮罩 → 有符号距离场
# ----------------------------------------------------------------------

def boundary_pixels(mask):
    """内部像素中，四邻域（图像外视为外部）含有外部像素的，视为边界像素。"""
    p = np.pad(mask, 1, constant_values=False)
    center = p[1:-1, 1:-1]
    inner = p[1:-1, :-2] & p[1:-1, 2:] & p[:-2, 1:-1] & p[2:, 1:-1]
    return center & ~inner


def mask_to_sdf(mask):
    """mask: 布尔数组。返回 (sdf, by, bx, has_boundary)。
    sdf 内正外负，单位像素；by/bx 为最近边界像素坐标。"""
    bnd = boundary_pixels(mask)
    if not bnd.any():
        h, w = mask.shape
        sdf = np.full((h, w), -_INF if not mask.any() else _INF)
        # 全满时 padding 保证边缘一圈是边界，所以只会遇到全空
        return sdf, np.zeros((h, w), int), np.zeros((h, w), int), False
    dist, sy, sx = edt2d(bnd)
    sdf = np.where(mask, dist, -dist)
    return sdf, sy, sx, True


# ----------------------------------------------------------------------
# 编码 / 解码（距离 ↔ 归一化灰度）
#   gray = clip(0.5 + sdf / (2R), 0, 1)，R 为编码半径（像素）
# ----------------------------------------------------------------------

def sdf_to_gray(sdf, radius, bits):
    """返回 (灰度浮点[0,1], 量化后整数值, 是否被截断)"""
    g = np.clip(0.5 + sdf / (2.0 * radius), 0.0, 1.0)
    levels = (1 << bits) - 1
    q = np.rint(g * levels).astype(np.int64)
    clipped = np.abs(sdf) > radius
    return q / levels, q, clipped


def gray_to_sdf(gray01, radius):
    return (np.asarray(gray01, dtype=np.float64) * 2.0 - 1.0) * radius


def quant_step(radius, bits):
    """一个灰度级对应的距离（像素）"""
    return 2.0 * radius / ((1 << bits) - 1)


# ----------------------------------------------------------------------
# 内置示例（128×128，程序绘制）
# ----------------------------------------------------------------------

EX_SIZE = 128


def ex_ring():
    """圆环：外 r=44 内 r=24 —— 带孔，检验"不能只按最外圈算"。"""
    y, x = np.mgrid[0:EX_SIZE, 0:EX_SIZE]
    r = np.hypot(y - 63.5, x - 63.5)
    return (r <= 44.0) & (r >= 24.0)


def ex_slit():
    """粗矩形中开一条 2px 宽竖细缝 —— 检验窄细节与量化丢失。"""
    m = np.zeros((EX_SIZE, EX_SIZE), bool)
    m[24:104, 24:104] = True
    m[30:98, 63:65] = False  # 2px 细缝
    return m


def ex_diagonal():
    """斜边：y > 0.75x + 12 的半平面 —— 检验斜边距离与最近边界。"""
    y, x = np.mgrid[0:EX_SIZE, 0:EX_SIZE]
    return y > 0.75 * x + 12


def ex_two_blocks():
    """两块互不相连的矩形 —— 检验多块各自按最近边界计算。"""
    m = np.zeros((EX_SIZE, EX_SIZE), bool)
    m[30:70, 20:55] = True
    m[60:100, 75:110] = True
    return m


def ex_empty():
    return np.zeros((EX_SIZE, EX_SIZE), bool)


def ex_full():
    return np.ones((EX_SIZE, EX_SIZE), bool)


EXAMPLES = {
    "圆环(带孔)": ex_ring,
    "细缝(2px)": ex_slit,
    "斜边": ex_diagonal,
    "两块分离": ex_two_blocks,
    "全空": ex_empty,
    "全满": ex_full,
}


# ----------------------------------------------------------------------
# 缩放重采样（双线性，用于轮廓预览）
# ----------------------------------------------------------------------

def resample_float(arr, scale):
    h, w = arr.shape
    nh, nw = max(1, int(round(h * scale))), max(1, int(round(w * scale)))
    img = Image.fromarray(arr.astype(np.float32), mode="F")
    img = img.resize((nw, nh), Image.BILINEAR)
    return np.asarray(img, dtype=np.float64)


# ----------------------------------------------------------------------
# 自检（无界面）：python3 sdf_tool.py --selftest
# ----------------------------------------------------------------------

def _brute_edt(feature):
    """暴力 O(n^4) 距离变换，作为精确算法的对照。"""
    h, w = feature.shape
    pts = np.argwhere(feature)
    dist = np.full((h, w), np.inf)
    by = np.zeros((h, w), int)
    bx = np.zeros((h, w), int)
    for y in range(h):
        for x in range(w):
            d2 = (pts[:, 0] - y) ** 2 + (pts[:, 1] - x) ** 2
            i = int(np.argmin(d2))
            dist[y, x] = math.sqrt(d2[i])
            by[y, x], bx[y, x] = pts[i]
    return dist, by, bx


def selftest():
    ok = True

    def check(name, cond, extra=""):
        nonlocal ok
        print(("PASS" if cond else "FAIL"), name, extra)
        ok = ok and bool(cond)

    # 1) 精确 EDT 对照暴力法（含最近边界坐标）
    rng = np.random.default_rng(7)
    feat = rng.random((24, 30)) < 0.08
    feat[5, 5] = True
    d1, y1, x1 = edt2d(feat)
    d2, y2, x2 = _brute_edt(feat)
    check("EDT距离与暴力法一致", np.allclose(d1, d2, atol=1e-9))
    same = (y1 == y2) & (x1 == x2)
    # 最近点不唯一时坐标可能不同，但距离必相等；距离相等即通过
    check("EDT最近边界坐标自洽",
          np.allclose(np.hypot(y1 - np.arange(24)[:, None], x1 - np.arange(30)[None, :]), d1, atol=1e-9))

    # 2) 圆环：孔内像素距离必须为负，且最近边界在内圈而非外圈
    sdf, by, bx, hb = mask_to_sdf(ex_ring())
    cy, cx = 64, 64
    check("圆环孔内为负距离", sdf[cy, cx] < 0, f"sdf={sdf[cy, cx]:.2f}")
    rb = math.hypot(by[cy, cx] - 63.5, bx[cy, cx] - 63.5)
    check("圆环孔内最近边界在内圈", abs(rb - 24.0) < 2.0, f"边界半径={rb:.1f}")
    check("圆环壁中点距离≈10", abs(sdf[64, 64 + 34] - 10.0) < 1.5,
          f"sdf={sdf[64, 98]:.2f}")

    # 3) 两块分离：两块之间中点的距离应对应到较近块边界，而非整体外包络
    sdf2, _, _, _ = mask_to_sdf(ex_two_blocks())
    check("两块之间为负距离", sdf2[50, 65] < 0, f"sdf={sdf2[50, 65]:.2f}")

    # 4) 斜边：斜边上像素到边界距离≈0，远离处符号正确
    sdf3, by3, bx3, _ = mask_to_sdf(ex_diagonal())
    check("斜边上方为正", sdf3[90, 80] > 0)
    check("斜边下方为负", sdf3[10, 100] < 0)
    # 点(x=80,y=90)到直线 y=0.75x+12 的解析距离（离图像边缘足够远）
    analytic = abs(0.75 * 80 - 90 + 12) / math.hypot(1, 0.75)
    check("斜边距离≈解析值(±1px)", abs(sdf3[90, 80] - analytic) < 1.0,
          f"sdf={sdf3[90, 80]:.2f} 解析={analytic:.2f}")

    # 5) 编解码往返误差 ≤ 半个量化步
    R, bits = 16.0, 16
    g, q, clip = sdf_to_gray(sdf, R, bits)
    rt = gray_to_sdf(g, R)
    half = quant_step(R, bits) / 2
    err = np.abs(rt - sdf)[~clip]
    check("16位编解码往返误差≤半步", err.size == 0 or err.max() <= half + 1e-9,
          f"max_err={err.max() if err.size else 0:.2e} 半步={half:.2e}")

    # 6) 全空 / 全满
    sdf_e, _, _, hb_e = mask_to_sdf(ex_empty())
    check("全空：无边界且全部饱和为负", (not hb_e) and np.all(sdf_e < -1e17))
    sdf_f, _, _, hb_f = mask_to_sdf(ex_full())
    check("全满：边缘为边界，中心距离≈63.5",
          hb_f and abs(sdf_f[64, 64] - 63.5) < 1.0, f"sdf={sdf_f[64, 64]:.2f}")

    # 7) 导出→读回 往返（写临时目录，不动工作区文件）
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        png = os.path.join(td, "sdf.png")
        meta = export_sdf(png, sdf, R, 16, 128, "灰度")
        sdf_back, meta_back = import_sdf(png)
        check("导出读回参数一致",
              meta_back["radius_px"] == R and meta_back["bits"] == 16)
        err2 = np.abs(sdf_back - sdf)[~clip]
        check("导出读回距离误差≤半步",
              err2.size == 0 or err2.max() <= half + 1e-9,
              f"max_err={err2.max() if err2.size else 0:.2e}")

    # 8) 细缝在缩小+量化下的丢失可复现：0.5x 后 2px 缝 → 1px，重建对比有差异
    small = resample_float(sdf_to_gray(mask_to_sdf(ex_slit())[0], R, bits)[0], 0.5)
    rec = gray_to_sdf(small, R) > 0
    orig_small = resample_float(ex_slit().astype(np.float64), 0.5) > 0.5
    diff = int(np.count_nonzero(rec != orig_small))
    print(f"INFO 细缝示例 0.5x 重建差异像素 = {diff}（量化+缩放导致的细节丢失演示）")

    print("\n自检", "全部通过" if ok else "存在失败项")
    return 0 if ok else 1


# ----------------------------------------------------------------------
# 导出 / 导入
# ----------------------------------------------------------------------

def export_sdf(png_path, sdf, radius, bits, threshold, channel):
    """写 8/16 位灰度 PNG + 同名 .json 参数文件。返回参数 dict。"""
    g01, q, _ = sdf_to_gray(sdf, radius, bits)
    if bits == 16:
        Image.fromarray(q.astype(np.uint16)).save(png_path)  # uint16 → I;16
    else:
        Image.fromarray(q.astype(np.uint8), mode="L").save(png_path)
    meta = {
        "format": "sdf-gray",
        "version": 1,
        "radius_px": radius,          # 编码半径：灰度 0↔-R，0.5↔0，1↔+R
        "bits": bits,
        "width": int(sdf.shape[1]),
        "height": int(sdf.shape[0]),
        "source_threshold": threshold,
        "source_channel": channel,
        "sign_convention": "inside=positive",
    }
    with open(png_path + ".json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    return meta


def import_sdf(png_path):
    """读回距离图。参数来自同名 .json；缺省时按 16 位、R=16 处理并提示。"""
    img = Image.open(png_path)
    arr = np.asarray(img)
    json_path = png_path + ".json"
    if os.path.exists(json_path):
        with open(json_path, encoding="utf-8") as f:
            meta = json.load(f)
    else:
        meta = {"radius_px": 16.0, "bits": 16 if arr.dtype == np.uint16 else 8}
    levels = float((1 << meta["bits"]) - 1)
    sdf = gray_to_sdf(arr.astype(np.float64) / levels, meta["radius_px"])
    return sdf, meta


# ----------------------------------------------------------------------
# 图形界面
# ----------------------------------------------------------------------

def run_gui():
    import tkinter as tk
    from tkinter import filedialog, ttk

    DSP = 300  # 每个面板的显示边长（像素）

    class App(tk.Tk):
        def __init__(self):
            super().__init__()
            self.title("遮罩 → 距离图 转换/核对工具")
            self.mask = None          # 原始遮罩（导出/导入不会改它）
            self.source_gray = None   # 源图灰度（用于显示阈值来源）
            self.sdf = None
            self.bn_y = None
            self.bn_x = None
            self.has_boundary = False
            self.click_xy = None
            self._photos = {}

            bar = ttk.Frame(self)
            bar.pack(fill="x", padx=4, pady=2)
            ttk.Button(bar, text="打开图片…", command=self.load_image).pack(side="left")
            ttk.Label(bar, text="通道:").pack(side="left", padx=(8, 0))
            self.channel = tk.StringVar(value="灰度")
            self.ch_menu = ttk.Combobox(bar, textvariable=self.channel, width=6,
                                        values=["灰度", "Alpha"], state="readonly")
            self.ch_menu.pack(side="left")
            self.ch_menu.bind("<<ComboboxSelected>>", lambda e: self.rethreshold())
            ttk.Label(bar, text="阈值:").pack(side="left", padx=(8, 0))
            self.thr = tk.IntVar(value=128)
            tk.Scale(bar, from_=0, to=255, orient="horizontal", variable=self.thr,
                     length=140, command=lambda v: self.rethreshold()).pack(side="left")
            ttk.Label(bar, text="示例:").pack(side="left", padx=(8, 0))
            self.ex_name = tk.StringVar(value="圆环(带孔)")
            ex = ttk.Combobox(bar, textvariable=self.ex_name, width=10,
                              values=list(EXAMPLES), state="readonly")
            ex.pack(side="left")
            ttk.Button(bar, text="生成示例", command=self.load_example).pack(side="left", padx=4)

            bar2 = ttk.Frame(self)
            bar2.pack(fill="x", padx=4, pady=2)
            ttk.Label(bar2, text="编码半径R(px):").pack(side="left")
            self.radius = tk.DoubleVar(value=16.0)
            tk.Spinbox(bar2, from_=1, to=128, increment=1, width=5,
                       textvariable=self.radius,
                       command=self.refresh_sdf_view).pack(side="left")
            ttk.Label(bar2, text="位深:").pack(side="left", padx=(8, 0))
            self.bits = tk.IntVar(value=16)
            ttk.Radiobutton(bar2, text="8位", variable=self.bits, value=8,
                            command=self.refresh_sdf_view).pack(side="left")
            ttk.Radiobutton(bar2, text="16位", variable=self.bits, value=16,
                            command=self.refresh_sdf_view).pack(side="left")
            ttk.Label(bar2, text="轮廓粗细(px):").pack(side="left", padx=(8, 0))
            self.thick = tk.DoubleVar(value=2.0)
            tk.Scale(bar2, from_=0.5, to=20, resolution=0.5, orient="horizontal",
                     variable=self.thick, length=120,
                     command=lambda v: self.refresh_preview()).pack(side="left")
            ttk.Label(bar2, text="缩放:").pack(side="left", padx=(8, 0))
            self.scale = tk.DoubleVar(value=1.0)
            tk.Scale(bar2, from_=0.25, to=4.0, resolution=0.25, orient="horizontal",
                     variable=self.scale, length=120,
                     command=lambda v: self.refresh_preview()).pack(side="left")
            ttk.Button(bar2, text="导出距离图…", command=self.do_export).pack(side="left", padx=8)
            ttk.Button(bar2, text="导入距离图…", command=self.do_import).pack(side="left")

            mid = ttk.Frame(self)
            mid.pack(padx=4, pady=4)
            self.canvases = {}
            for i, key in enumerate(("mask", "sdf", "prev")):
                f = ttk.Frame(mid)
                f.grid(row=0, column=i, padx=4)
                ttk.Label(f, text={"mask": "① 遮罩（白=内部）",
                                   "sdf": "② 距离图（红内蓝外）",
                                   "prev": "③ 轮廓预览（绿=轮廓 品红=丢失）"}[key]).pack()
                c = tk.Canvas(f, width=DSP, height=DSP, bg="#222222",
                              highlightthickness=1, highlightbackground="#666")
                c.pack()
                c.bind("<Button-1>", self.on_click)
                c.bind("<B1-Motion>", self.on_click)
                self.canvases[key] = c

            self.info = tk.Text(self, height=8, width=110, font=("Menlo", 11))
            self.info.pack(padx=6, pady=4)
            self.loss = ttk.Label(self, text="", foreground="#a60")
            self.loss.pack(padx=6, pady=(0, 6), anchor="w")

            self.load_example()

        # ---------- 数据装载 ----------

        def load_example(self):
            self.mask = EXAMPLES[self.ex_name.get()]()
            self.source_gray = (self.mask * 255).astype(np.uint8)
            self.recompute()

        def load_image(self):
            path = filedialog.askopenfilename(
                filetypes=[("图片", "*.png *.jpg *.jpeg *.bmp *.gif *.tif *.tiff")])
            if not path:
                return
            img = Image.open(path)
            has_alpha = "A" in img.getbands()
            self.ch_menu["values"] = ["灰度", "Alpha"] if has_alpha else ["灰度"]
            if not has_alpha:
                self.channel.set("灰度")
            self._src_img = img.convert("RGBA")
            self.rethreshold()

        def rethreshold(self):
            img = getattr(self, "_src_img", None)
            if img is None:
                return
            arr = np.asarray(img)
            if self.channel.get() == "Alpha":
                v = arr[:, :, 3]
            else:
                v = np.asarray(img.convert("L"))
            self.source_gray = v
            self.mask = v >= self.thr.get()
            self.recompute()

        def recompute(self):
            self.sdf, self.bn_y, self.bn_x, self.has_boundary = mask_to_sdf(self.mask)
            self.click_xy = None
            self.refresh_all()

        # ---------- 绘制 ----------

        def _show(self, key, rgb):
            h, w = rgb.shape[:2]
            zoom = max(1, DSP // max(h, w))
            img = Image.fromarray(rgb).resize((w * zoom, h * zoom), Image.NEAREST)
            ph = self._photo(img)
            c = self.canvases[key]
            c.delete("all")
            c.create_image(DSP // 2, DSP // 2, image=ph)
            c._zoom = zoom
            c._off = (DSP - w * zoom) // 2, (DSP - h * zoom) // 2
            if self.click_xy is not None and key != "prev":
                x, y = self.click_xy
                ox, oy = c._off
                cx, cy = ox + x * zoom + zoom // 2, oy + y * zoom + zoom // 2
                c.create_line(cx - 8, cy, cx + 8, cy, fill="#0f0")
                c.create_line(cx, cy - 8, cx, cy + 8, fill="#0f0")

        def _photo(self, img):
            from PIL import ImageTk
            ph = ImageTk.PhotoImage(img)
            self._photos[id(ph)] = ph
            if len(self._photos) > 12:
                self._photos.clear()
                self._photos[id(ph)] = ph
            return ph

        def refresh_all(self):
            self.refresh_mask_view()
            self.refresh_sdf_view()

        def refresh_mask_view(self):
            m = self.mask
            rgb = np.zeros((*m.shape, 3), np.uint8)
            rgb[:, :] = (40, 40, 40)
            rgb[m] = (235, 235, 235)
            if self.has_boundary:
                rgb[boundary_pixels(m)] = (255, 170, 0)  # 边界像素橙色
            self._show("mask", rgb)

        def refresh_sdf_view(self):
            R = max(1e-9, float(self.radius.get()))
            t = np.clip(0.5 + self.sdf / (2 * R), 0, 1)
            t = np.nan_to_num(t, nan=0.0, posinf=1.0, neginf=0.0)
            r = np.clip(2 * t - 1, 0, 1)
            b = np.clip(1 - 2 * t, 0, 1)
            rgb = np.stack([r * 255, np.minimum(r, b) * 90, b * 255], -1).astype(np.uint8)
            self._show("sdf", rgb)
            self.refresh_preview()
            self.update_loss_label()

        def refresh_preview(self):
            if self.sdf is None:
                return
            R = max(1e-9, float(self.radius.get()))
            bits = self.bits.get()
            s = float(self.scale.get())
            t = float(self.thick.get())
            g01, _, _ = sdf_to_gray(self.sdf, R, bits)  # 先量化再缩放，模拟真实管线
            small = resample_float(g01, s)
            d = gray_to_sdf(small, R)
            inside = d > 0
            outline = np.abs(d) <= t / 2
            rgb = np.zeros((*d.shape, 3), np.uint8)
            rgb[inside] = (120, 120, 120)
            rgb[outline] = (0, 220, 0)
            # 与缩放后的原遮罩对比，差异=丢失/多余细节
            if self.mask is not None:
                om = resample_float(self.mask.astype(np.float64), s) > 0.5
                rgb[(inside != om) & ~outline] = (220, 0, 220)
            self._show("prev", rgb)
            self.update_loss_label()

        # ---------- 信息 ----------

        def on_click(self, ev):
            c = ev.widget
            if not hasattr(c, "_zoom") or self.sdf is None:
                return
            ox, oy = c._off
            x = (ev.x - ox) // c._zoom
            y = (ev.y - oy) // c._zoom
            h, w = self.sdf.shape
            if not (0 <= x < w and 0 <= y < h):
                return
            self.click_xy = (int(x), int(y))
            self.refresh_all()
            self.show_pixel_info(int(x), int(y))

        def show_pixel_info(self, x, y):
            R = max(1e-9, float(self.radius.get()))
            bits = self.bits.get()
            d = float(self.sdf[y, x])
            g01, q, clip = sdf_to_gray(self.sdf, R, bits)
            by, bx = int(self.bn_y[y, x]), int(self.bn_x[y, x])
            src = int(self.source_gray[y, x]) if self.source_gray is not None else "-"
            lines = [
                f"像素 ({x},{y})   源灰度={src}  阈值={self.thr.get()}  "
                f"→ {'内部' if self.mask is not None and self.mask[y, x] else '外部'}",
                f"距离值 sdf = {d:+.3f} px   （内正外负，编码半径 R={R:g}px）",
                f"归一化灰度 = {g01[y, x]:.4f}   量化({bits}位) = {q[y, x]} / {(1 << bits) - 1}"
                + ("   ⚠ 超出±R，已截断" if clip[y, x] else ""),
                f"最近边界 = ({bx},{by})   距离 = {math.hypot(x - bx, y - by):.3f} px",
            ]
            if not self.has_boundary:
                lines.append("该输入无任何边界（全空）：距离场饱和，无法取轮廓。")
            self.info.delete("1.0", "end")
            self.info.insert("1.0", "\n".join(lines))

        def update_loss_label(self):
            if self.sdf is None:
                return
            R = max(1e-9, float(self.radius.get()))
            bits = self.bits.get()
            s = float(self.scale.get())
            qs = quant_step(R, bits)
            msgs = [f"量化步长 {qs:.4f} px/级（{bits}位，±R={R:g}px）",
                    f"当前缩放 {s:g}x：1 输出像素 = {1 / s:.2f} 源像素，"
                    f"宽度 < {1 / s:.2f}px 的细节不可分辨"]
            if self.has_boundary:
                nclip = int(np.count_nonzero(np.abs(self.sdf) > R))
                if nclip:
                    msgs.append(f"{nclip} 像素距离超出±R被截断（灰度饱和）")
                g01, _, _ = sdf_to_gray(self.sdf, R, bits)
                rec = gray_to_sdf(g01, R) > 0
                ndiff = int(np.count_nonzero(rec != self.mask))
                msgs.append(f"量化重建与原遮罩差异 {ndiff} 像素")
            else:
                msgs.append("无边界输入（全空），距离场饱和")
            self.loss.config(text="细节丢失分析： " + "；".join(msgs))

        # ---------- 导出 / 导入 ----------

        def do_export(self):
            if self.sdf is None:
                return
            path = filedialog.asksaveasfilename(defaultextension=".png",
                                                filetypes=[("PNG", "*.png")])
            if not path:
                return
            meta = export_sdf(path, self.sdf, float(self.radius.get()),
                              self.bits.get(), self.thr.get(), self.channel.get())
            self.info.delete("1.0", "end")
            self.info.insert("1.0", f"已导出：{path}\n参数：{json.dumps(meta, ensure_ascii=False)}\n"
                                    f"（原遮罩未改动）")

        def do_import(self):
            path = filedialog.askopenfilename(filetypes=[("PNG", "*.png")])
            if not path:
                return
            sdf, meta = import_sdf(path)
            # 只替换距离图与预览，原遮罩保持不动
            self.sdf = sdf
            rec = sdf > 0
            self.bn_y, self.bn_x = 0, 0
            if boundary_pixels(rec).any():
                _, self.bn_y, self.bn_x = edt2d(boundary_pixels(rec))
                self.has_boundary = True
            else:
                self.has_boundary = False
            self.radius.set(meta.get("radius_px", 16.0))
            self.bits.set(meta.get("bits", 16))
            self.refresh_sdf_view()
            self.info.delete("1.0", "end")
            self.info.insert("1.0",
                             f"已按参数重建轮廓：{json.dumps(meta, ensure_ascii=False)}\n"
                             f"左侧面板仍是原遮罩（未被覆盖），右侧为导入距离图的重建预览。")

    App().mainloop()


# ----------------------------------------------------------------------

if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    run_gui()
