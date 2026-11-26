"""tkinter UI: pick a region, click a reference edge, preview at one scale.

Layout::

    +--------------------------------------------------------------+
    | toolbar: open / pick reference / estimate / manual fields     |
    +--------------------------------------------------------------+
    |  canvas: INPUT | RESULT | RESIDUAL  (same scale, synced)      |
    |          with a zoomed edge strip below the canvas            |
    +--------------------------------------------------------------+
    |  side panel: region list, estimate readout, noise/gain knobs   |
    +--------------------------------------------------------------+

The GUI keeps all arithmetic in :mod:`deblur_lab`, so the same session can be
replayed from the CLI and exported as files.
"""

from __future__ import annotations

import json
import math
import sys
import threading
from pathlib import Path
from typing import Sequence

import numpy as np

from . import estimate, metrics, ops, report, restore, synth

try:  # tkinter is optional; the CLI works without it.
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
    from PIL import Image, ImageTk
except Exception as exc:  # pragma: no cover - environment dependent
    tk = None  # type: ignore[assignment]
    _TK_IMPORT_ERROR = exc
else:
    _TK_IMPORT_ERROR = None


PANEL_GAP = 10
ZOOM_W, ZOOM_H = 320, 150


class LabApp:
    def __init__(self, root, initial: str | None = None):
        self.root = root
        self.root.title("拖影修复试验台 / Motion deblur lab")
        self.root.geometry("1280x900")

        self.input_set: report.InputSet | None = None
        self.rgb_u8: np.ndarray | None = None
        self.gray: np.ndarray | None = None
        self.regions: list[restore.Region] = []
        self.params = restore.RestoreParams()
        self.result: restore.RestoreResult | None = None
        self.estimates: dict[str, estimate.BlurEstimate] = {}

        self.selected = 0
        self.ref_point: tuple[float, float] | None = None
        self.ref_normal: float | None = None
        self.mode = "idle"  # idle | select_rect | select_ref
        self.drag_start: tuple[float, float] | None = None
        self.view_scale = 1.0
        self.canvas_origin = (PANEL_GAP, 40)
        self._tk_images: list = []
        self._residual_gain = 4.0
        self._restoring = False
        self._restore_job = None

        self._build_ui()
        if initial:
            self.open_image(initial)

    # ------------------------------------------------------------------ UI
    def _build_ui(self) -> None:
        top = ttk.Frame(self.root, padding=(8, 6))
        top.pack(side=tk.TOP, fill=tk.X)
        ttk.Button(top, text="打开图片…", command=self.on_open).pack(side=tk.LEFT)
        ttk.Button(top, text="生成样例", command=self.on_generate).pack(side=tk.LEFT, padx=(6, 0))
        ttk.Separator(top, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=8)
        ttk.Button(top, text="框选区域", command=lambda: self.set_mode("select_rect")).pack(side=tk.LEFT)
        ttk.Button(top, text="点参考边", command=lambda: self.set_mode("select_ref")).pack(side=tk.LEFT, padx=4)
        ttk.Button(top, text="估计所选区域", command=self.on_estimate).pack(side=tk.LEFT)
        ttk.Button(top, text="应用修复", command=self.on_restore).pack(side=tk.LEFT, padx=4)
        ttk.Button(top, text="导出…", command=self.on_export).pack(side=tk.LEFT)
        self.mode_label = ttk.Label(top, text="就绪")
        self.mode_label.pack(side=tk.RIGHT)

        body = ttk.Frame(self.root)
        body.pack(side=tk.BOTH, expand=True, fill=tk.BOTH)

        left = ttk.Frame(body)
        left.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self.canvas = tk.Canvas(left, bg="#202020", highlightthickness=0)
        self.canvas.pack(side=tk.TOP, fill=tk.BOTH, expand=True)
        self.canvas.bind("<ButtonPress-1>", self.on_press)
        self.canvas.bind("<B1-Motion>", self.on_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)
        self.canvas.bind("<Motion>", self.on_hover)
        self.canvas.bind("<Configure>", lambda e: self.redraw())

        zoom_frame = ttk.Frame(left)
        zoom_frame.pack(side=tk.TOP, fill=tk.X)
        ttk.Label(zoom_frame, text="边沿预览").pack(side=tk.LEFT)
        self.zoom_canvas = tk.Canvas(zoom_frame, height=ZOOM_H + 16, bg="#181818", highlightthickness=0)
        self.zoom_canvas.pack(side=tk.LEFT, fill=tk.X, expand=True)
        self.zoom_label = ttk.Label(zoom_frame, text="", width=40, justify=tk.LEFT)
        self.zoom_label.pack(side=tk.RIGHT)

        side = ttk.Frame(body, width=360)
        side.pack(side=tk.RIGHT, fill=tk.Y)
        self._build_side(side)

        self.status = ttk.Label(self.root, anchor=tk.W, relief=tk.SUNKEN)
        self.status.pack(side=tk.BOTTOM, fill=tk.X)

    def _build_side(self, parent) -> None:
        self.region_box = ttk.LabelFrame(parent, text="区域 (重叠按序号从小到大应用)")
        self.region_box.pack(side=tk.TOP, fill=tk.X, padx=6, pady=6)
        self.region_list = tk.Listbox(self.region_box, height=7, exportselection=False)
        self.region_list.pack(fill=tk.X)
        self.region_list.bind("<<ListboxSelect>>", self.on_select_region)
        btns = ttk.Frame(self.region_box)
        btns.pack(fill=tk.X, pady=(4, 0))
        ttk.Button(btns, text="删除", command=self.on_delete_region).pack(side=tk.LEFT)
        ttk.Button(btns, text="上移序号", command=lambda: self.bump_order(-1)).pack(side=tk.LEFT)
        ttk.Button(btns, text="下移序号", command=lambda: self.bump_order(1)).pack(side=tk.LEFT)

        fields = ttk.LabelFrame(parent, text="参数 (估计不稳时可手填)")
        fields.pack(side=tk.TOP, fill=tk.X, padx=6, pady=6)
        self.var_angle = tk.StringVar(value="0")
        self.var_length = tk.StringVar(value="1")
        self.var_order = tk.StringVar(value="0")
        self.var_feather = tk.StringVar(value="8")
        self.var_thickness = tk.StringVar(value="1.0")
        for row, (label, var) in enumerate(
            [
                ("方向 (度)", self.var_angle),
                ("长度 (px)", self.var_length),
                ("应用次序", self.var_order),
                ("羽化 (px)", self.var_feather),
                ("PSF 厚度", self.var_thickness),
            ]
        ):
            ttk.Label(fields, text=label).grid(row=row, column=0, sticky=tk.W, padx=4, pady=2)
            ttk.Entry(fields, textvariable=var, width=12).grid(row=row, column=1, sticky=tk.W)
        ttk.Button(fields, text="写入所选区域", command=self.on_apply_fields).grid(
            row=5, column=0, columnspan=2, sticky=tk.EW, padx=4, pady=4
        )

        est_frame = ttk.LabelFrame(parent, text="估计依据")
        est_frame.pack(side=tk.TOP, fill=tk.BOTH, expand=False, padx=6, pady=6)
        self.est_text = tk.Text(est_frame, height=11, wrap=tk.WORD, font=("Menlo", 10))
        self.est_text.pack(fill=tk.BOTH, expand=True)

        guard = ttk.LabelFrame(parent, text="噪点 / 暗边控制")
        guard.pack(side=tk.TOP, fill=tk.X, padx=6, pady=6)
        self.var_guard = tk.DoubleVar(value=0.55)
        self.var_noise_floor = tk.DoubleVar(value=0.0)
        self.var_denoise = tk.DoubleVar(value=0.0)
        self.var_iterations = tk.IntVar(value=24)
        self.var_noise = tk.DoubleVar(value=0.012)
        for label, var, frm, to, cmd in [
            ("平坦区保护", self.var_guard, 0.0, 0.95, None),
            ("噪声下限", self.var_noise_floor, 0.0, 0.05, None),
            ("前级去噪 σ", self.var_denoise, 0.0, 2.0, None),
            ("噪声估计 σ", self.var_noise, 0.0, 0.06, None),
        ]:
            ttk.Label(guard, text=label).pack(anchor=tk.W, padx=4)
            scale = ttk.Scale(guard, from_=frm, to=to, variable=var, command=lambda _v: self.on_param_change())
            scale.pack(fill=tk.X, padx=4, pady=(0, 4))
        ttk.Label(guard, text="迭代次数").pack(anchor=tk.W, padx=4)
        ttk.Spinbox(guard, from_=1, to=200, textvariable=self.var_iterations, width=6,
                    command=self.on_param_change).pack(anchor=tk.W, padx=4, pady=(0, 6))

        self.readout = tk.Text(parent, height=8, wrap=tk.WORD, font=("Menlo", 10))
        self.readout.pack(side=tk.BOTTOM, fill=tk.BOTH, expand=True, padx=6, pady=6)

    # -------------------------------------------------------------- helpers
    def set_status(self, text: str) -> None:
        self.status.config(text=text)

    def set_mode(self, mode: str) -> None:
        self.mode = mode
        self.mode_label.config(
            text={"idle": "就绪", "select_rect": "拖拽框选区域", "select_ref": "点击清晰的边"}[mode]
        )

    def selected_region(self) -> restore.Region | None:
        if 0 <= self.selected < len(self.regions):
            return self.regions[self.selected]
        return None

    # ---------------------------------------------------------------- files
    def on_open(self) -> None:
        path = filedialog.askopenfilename(
            title="打开图片", filetypes=[("Images", "*.png *.jpg *.jpeg *.bmp *.tif *.tiff"), ("All", "*.*")]
        )
        if path:
            self.open_image(path)

    def open_image(self, path: str) -> None:
        try:
            self.input_set = report.load_input(path)
        except Exception as exc:  # noqa: BLE001
            messagebox.showerror("打开失败", str(exc))
            return
        self.rgb_u8 = self.input_set.original
        self.gray = ops.rgb_to_gray(self.rgb_u8)
        self.regions = []
        self.result = None
        self.estimates = {}
        self.selected = 0
        self.ref_point = None
        self.ref_normal = None
        if self.input_set.blurred_regions:
            for i, rect in enumerate(self.input_set.blurred_regions):
                self.regions.append(
                    restore.Region(
                        name=f"R{i + 1}",
                        rect=tuple(int(v) for v in rect),
                        angle=0.0,
                        length=1.0,
                        order=i,
                        feather=8.0,
                    )
                )
            self.set_status("已载入样例并带上已知区域; 请点参考边或估计")
        else:
            self.set_status("已打开图片; 请框选一个拖影区域")
        self.refresh_region_list()
        self.redraw()

    def on_generate(self) -> None:
        out = Path("samples") / "gui_demo"
        synth.save_sample(out, width=960, height=640, seed=7)
        self.open_image(str(out / "blurred.png"))
        self.set_status(f"已生成并打开 {out / 'blurred.png'}")

    # --------------------------------------------------------------- canvas
    def _panel_size(self) -> tuple[int, int]:
        if self.rgb_u8 is None:
            return 0, 0
        h, w = self.rgb_u8.shape[:2]
        cw = max(self.canvas.winfo_width() - 3 * PANEL_GAP, 120)
        available_h = max(self.canvas.winfo_height() - 2 * PANEL_GAP, 120)
        scale = min(cw / (3 * w), available_h / h, 1.0)
        return int(w * scale), int(h * scale)

    def _to_image(self, arr: np.ndarray) -> tuple[Image.Image, tuple[int, int]]:
        pw, ph = self._panel_size()
        if pw <= 0:
            return Image.new("RGB", (1, 1)), (0, 0)
        im = Image.fromarray(arr, mode="RGB").resize((pw, ph), Image.Resampling.BILINEAR)
        return im, (pw, ph)

    def panels(self) -> list[tuple[str, np.ndarray]]:
        if self.rgb_u8 is None:
            return []
        if self.result is None:
            return [("输入", self.rgb_u8)]
        res_u8 = ops.to_uint8(self.result.image)
        resid = report.residual_image(res_u8, self.rgb_u8, gain=self._residual_gain)
        return [
            ("输入", self.rgb_u8),
            ("修复结果", res_u8),
            (f"残差 x{self._residual_gain:g}", resid),
        ]

    def redraw(self) -> None:
        self.canvas.delete("all")
        self._tk_images.clear()
        if self.rgb_u8 is None:
            self.canvas.create_text(200, 100, text="打开图片或生成样例", fill="#cfcfcf")
            return
        pw, ph = self._panel_size()
        x = PANEL_GAP
        y = 30
        for label, arr in self.panels():
            pil, _ = self._to_image(arr)
            tkimg = ImageTk.PhotoImage(pil)
            self._tk_images.append(tkimg)
            self.canvas.create_image(x, y, anchor=tk.NW, image=tkimg)
            self.canvas.create_text(x + 4, y - 18, text=label, fill="#e8e8e8", anchor=tk.NW)
            x += pw + PANEL_GAP
        self.view_scale = pw / self.rgb_u8.shape[1]
        self._draw_regions(x0=PANEL_GAP, y0=y, pw=pw, ph=ph)
        self.draw_zoom()

    def _draw_regions(self, x0: int, y0: int, pw: int, ph: int) -> None:
        colors = ["#ff5a5a", "#5aa0ff", "#59d17a", "#ffbc4d", "#c98bff"]
        n_panels = len(self.panels())
        for panel_idx in range(n_panels):
            ox = x0 + panel_idx * (pw + PANEL_GAP)
            for i, r in enumerate(self.regions):
                color = colors[i % len(colors)] if r.enabled else "#808080"
                xa = ox + r.rect[0] * self.view_scale
                ya = y0 + r.rect[1] * self.view_scale
                xb = ox + r.rect[2] * self.view_scale
                yb = y0 + r.rect[3] * self.view_scale
                width = 3 if i == self.selected else 1
                self.canvas.create_rectangle(xa, ya, xb, yb, outline=color, width=width)
                if panel_idx == 0:
                    self.canvas.create_text(
                        xa + 4, ya + 4, anchor=tk.NW, fill=color,
                        text=f"{i + 1}: {r.order} {r.angle:.0f}° {r.length:.1f}px",
                    )
                    for k in range(min(r.order, 6)):
                        self.canvas.create_line(
                            xa + 4, ya + 18 + 4 * k, xa + 26, ya + 18 + 4 * k, fill=color
                        )
        if self.ref_point is not None and self.ref_normal is not None:
            cx = x0 + self.ref_point[0] * self.view_scale
            cy = y0 + self.ref_point[1] * self.view_scale
            dx, dy = ops.angle_to_vec(self.ref_normal)
            self.canvas.create_line(
                cx - 20 * dx, cy - 20 * dy, cx + 20 * dx, cy + 20 * dy,
                fill="#ffe25a", width=2,
            )
            self.canvas.create_oval(cx - 3, cy - 3, cx + 3, cy + 3, outline="#ffe25a")

    def _canvas_to_image(self, x: float, y: float) -> tuple[float, float] | None:
        if self.rgb_u8 is None or self.view_scale <= 0:
            return None
        pw, _ = self._panel_size()
        for panel_idx in range(len(self.panels())):
            ox = PANEL_GAP + panel_idx * (pw + PANEL_GAP)
            if ox <= x <= ox + pw:
                return ((x - ox) / self.view_scale, (y - 30) / self.view_scale)
        return None

    def on_press(self, event) -> None:
        pt = self._canvas_to_image(event.x, event.y)
        if pt is None:
            return
        if self.mode == "select_ref":
            if self.input_set is None:
                return
            snapped = estimate.snap_to_edge(self.gray, pt)
            if snapped is None:
                self.set_status("附近没找到明显的边, 换一个位置")
                return
            (cx, cy), normal, strength = snapped
            self.ref_point = (cx, cy)
            self.ref_normal = normal
            self.set_mode("idle")
            self.set_status(f"参考边: ({cx:.0f},{cy:.0f}) 法线 {normal:.1f}°, 强度 {strength:.3f}")
            self.redraw()
            self.on_estimate()
            return
        if self.mode == "select_rect":
            self.drag_start = (pt[0], pt[1])
            self.drag_origin = (event.x, event.y)
            self.canvas.delete("rubber")
        else:
            # Clicking an existing region selects it.
            for i, r in enumerate(self.regions):
                if r.rect[0] <= pt[0] <= r.rect[2] and r.rect[1] <= pt[1] <= r.rect[3]:
                    self.selected = i
                    self.refresh_region_list()
                    self.load_fields()
                    self.redraw()
                    return

    def on_drag(self, event) -> None:
        if self.mode != "select_rect" or self.drag_start is None:
            return
        self.canvas.delete("rubber")
        self.canvas.create_rectangle(
            self.drag_origin[0], self.drag_origin[1], event.x, event.y,
            outline="#ffe25a", width=2, tags="rubber",
        )

    def on_release(self, event) -> None:
        if self.mode != "select_rect" or self.drag_start is None:
            return
        end = self._canvas_to_image(event.x, event.y)
        start = self.drag_start
        self.drag_start = None
        self.canvas.delete("rubber")
        if end is None:
            return
        rect = tuple(int(round(v)) for v in (start[0], start[1], end[0], end[1]))
        rect = ops.clamp_rect(rect, self.rgb_u8.shape[:2])
        if rect[2] - rect[0] < 12 or rect[3] - rect[1] < 12:
            self.set_status("区域太小")
            self.set_mode("idle")
            return
        self.regions.append(
            restore.Region(name=f"R{len(self.regions) + 1}", rect=rect, angle=0.0, length=1.0,
                           order=len(self.regions), feather=8.0)
        )
        self.selected = len(self.regions) - 1
        self.set_mode("idle")
        self.refresh_region_list()
        self.load_fields()
        self.redraw()
        self.set_status("已添加区域; 点参考边或直接估计")

    def on_hover(self, event) -> None:
        pt = self._canvas_to_image(event.x, event.y)
        if pt is not None:
            self.set_status(f"({pt[0]:.0f}, {pt[1]:.0f})  缩放 {self.view_scale:.2f}")

    def draw_zoom(self) -> None:
        self.zoom_canvas.delete("all")
        region = self.selected_region()
        if region is None or self.gray is None:
            self.zoom_label.config(text="选择区域后显示边沿放大预览")
            return
        h, w = self.gray.shape
        x0, y0, x1, y1 = ops.clamp_rect(region.rect, (h, w))
        cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
        half = 26
        xa, xb = max(0, cx - half), min(w, cx + half)
        ya, yb = max(0, cy - half), min(h, cy + half)
        src = self.rgb_u8[ya:yb, xa:xb]
        if self.result is not None:
            dst = ops.to_uint8(self.result.image)[ya:yb, xa:xb]
        else:
            dst = src
        src_big = Image.fromarray(src, mode="RGB").resize(
            (ZOOM_W, ZOOM_H), Image.Resampling.NEAREST
        )
        dst_big = Image.fromarray(dst, mode="RGB").resize(
            (ZOOM_W, ZOOM_H), Image.Resampling.NEAREST
        )
        tk_src = ImageTk.PhotoImage(src_big)
        tk_dst = ImageTk.PhotoImage(dst_big)
        self._tk_images.extend([tk_src, tk_dst])
        self.zoom_canvas.create_image(2, 4, anchor=tk.NW, image=tk_src)
        self.zoom_canvas.create_image(ZOOM_W + 8, 4, anchor=tk.NW, image=tk_dst)
        self.zoom_canvas.create_text(4, ZOOM_H + 6, anchor=tk.W, fill="#cfcfcf", text="输入")
        self.zoom_canvas.create_text(ZOOM_W + 10, ZOOM_H + 6, anchor=tk.W, fill="#cfcfcf", text="结果")
        if self.ref_point is not None:
            # Draw an edge-normal profile on the zoom strip.
            phi = self.ref_normal or 0.0
            self.zoom_label.config(
                text=f"参考边法线 {phi:.1f}°\n区域 {region.rect[0]},{region.rect[1]}\n"
                f"方向 {region.angle:.1f}° 长度 {region.length:.2f}px"
            )

    # -------------------------------------------------------------- regions
    def refresh_region_list(self) -> None:
        self.region_list.delete(0, tk.END)
        for i, r in enumerate(self.regions):
            mark = "" if r.enabled else " [关]"
            self.region_list.insert(
                tk.END,
                f"{i + 1}. 序{r.order} {r.angle:.1f}° {r.length:.1f}px {r.rect}{mark}",
            )
        if 0 <= self.selected < len(self.regions):
            self.region_list.selection_set(self.selected)

    def on_select_region(self, _event=None) -> None:
        sel = self.region_list.curselection()
        if sel:
            self.selected = int(sel[0])
            self.load_fields()
            self.redraw()

    def load_fields(self) -> None:
        r = self.selected_region()
        if r is None:
            return
        self.var_angle.set(f"{r.angle:.2f}")
        self.var_length.set(f"{r.length:.2f}")
        self.var_order.set(str(r.order))
        self.var_feather.set(f"{r.feather:.1f}")
        self.var_thickness.set(f"{r.thickness:.2f}")

    def on_apply_fields(self) -> None:
        r = self.selected_region()
        if r is None:
            return
        try:
            r.angle = ops.wrap_angle_180(float(self.var_angle.get()))
            r.length = max(float(self.var_length.get()), 0.0)
            r.order = int(float(self.var_order.get()))
            r.feather = max(float(self.var_feather.get()), 0.0)
            r.thickness = max(float(self.var_thickness.get()), 0.1)
            r.source = "manual"
        except ValueError:
            messagebox.showerror("参数错误", "请填写数字")
            return
        self.refresh_region_list()
        self.redraw()
        self.set_status("已写入手填参数")

    def on_delete_region(self) -> None:
        if self.selected_region() is None:
            return
        self.regions.pop(self.selected)
        self.selected = max(0, min(self.selected, len(self.regions) - 1))
        self.refresh_region_list()
        self.redraw()

    def bump_order(self, delta: int) -> None:
        r = self.selected_region()
        if r is None:
            return
        r.order = max(0, r.order + delta)
        self.refresh_region_list()
        self.load_fields()
        self.after_restore_if_ready()

    # ------------------------------------------------------------- estimate
    def on_estimate(self) -> None:
        r = self.selected_region()
        if r is None or self.gray is None:
            self.set_status("先框选一个区域")
            return
        est = estimate.estimate_region(
            self.gray,
            r.rect,
            ref_point=self.ref_point if self._ref_inside(r) else None,
            ref_normal=self.ref_normal if self._ref_inside(r) else None,
            thickness=r.thickness,
            base_width=1.4,
        )
        self.estimates[r.name] = est
        # Only auto-apply estimates we trust; otherwise keep whatever the user
        # typed and show the (unstable) estimate for reference.
        if est.confidence >= 0.2 and est.length > 0:
            r.angle = est.angle
            r.length = est.length
            r.source = "estimated"
            r.estimate = est.to_dict()
            applied = True
        else:
            applied = False
        self.load_fields()
        self.refresh_region_list()
        self.show_estimate(est, applied=applied)
        self.redraw()

    def _ref_inside(self, r: restore.Region) -> bool:
        if self.ref_point is None:
            return False
        return (r.rect[0] <= self.ref_point[0] <= r.rect[2]
                and r.rect[1] <= self.ref_point[1] <= r.rect[3])

    def show_estimate(self, est: estimate.BlurEstimate, applied: bool = True) -> None:
        self.est_text.delete("1.0", tk.END)
        lines = [
            f"方法: {est.method}",
            f"方向: {est.angle:.2f}° ± {est.angle_sigma:.2f}°",
            f"长度: {est.length:.2f}px ± {est.length_sigma:.2f}px",
            f"置信度: {est.confidence:.2f}   稳定: {'是' if est.stable else '否'}",
            "",
            "依据:",
        ]
        axes = est.dependencies.get("edges", [])
        for e in axes:
            lines.append(
                f"  边 {e['source']} 法线 {e['normal_deg']:.1f}° 宽 {e['width_10_90']:.2f}"
                f"±{e['width_sigma']:.2f} @({e['point'][0]:.0f},{e['point'][1]:.0f})"
            )
        sp = est.dependencies.get("spectral", {})
        lines.append(
            f"  频谱 窗{sp.get('window')} 带{sp.get('band')} "
            f"σ角{sp.get('angle_sigma_deg')} σ长{sp.get('length_sigma_px')} "
            f"可信={sp.get('confident')}"
        )
        for w in est.warnings:
            lines.append(f"! {w}")
        if not applied:
            lines.append("提示: 置信度低, 未自动写入; 请核对后手填并点「写入所选区域」。")
        elif not est.stable:
            lines.append("提示: 估计不稳, 可在右侧手填并写入。")
        self.est_text.insert(tk.END, "\n".join(lines))

    # -------------------------------------------------------------- restore
    def _sync_params(self) -> None:
        self.params.detail_guard = float(self.var_guard.get())
        self.params.noise_floor = float(self.var_noise_floor.get())
        self.params.denoise_sigma = float(self.var_denoise.get())
        self.params.iterations = int(self.var_iterations.get())

    def on_param_change(self) -> None:
        # Live sliders fire rapidly; debounce so we restore once after settling.
        if self._restore_job is not None:
            try:
                self.root.after_cancel(self._restore_job)
            except Exception:  # noqa: BLE001
                pass
        self._restore_job = self.root.after(180, self.after_restore_if_ready)

    def after_restore_if_ready(self) -> None:
        self._restore_job = None
        if self.result is not None:
            self.on_restore()

    def on_restore(self) -> None:
        if self.rgb_u8 is None or self._restoring:
            return
        self._restoring = True
        try:
            self._sync_params()
            rgb = self.rgb_u8.astype(np.float32) / 255.0
            try:
                self.result = restore.restore_multi(
                    rgb, self.regions, self.params, noise_sigma=float(self.var_noise.get())
                )
            except Exception as exc:  # noqa: BLE001
                messagebox.showerror("修复失败", repr(exc))
                return
            self.redraw()
            self.update_readout()
        finally:
            self._restoring = False

    def update_readout(self) -> None:
        self.readout.delete("1.0", tk.END)
        if self.result is None:
            return
        lines = []
        if self.input_set is not None and self.input_set.has_reference:
            clean_g = ops.rgb_to_gray(self.input_set.clean)
            before_g = ops.rgb_to_gray(self.rgb_u8)
            after_g = ops.rgb_to_gray(ops.to_uint8(self.result.image))
            union = self.result.apply_mask_union()
            lines.append(f"PSNR 前/后: {metrics.psnr(clean_g, before_g):.2f} / "
                         f"{metrics.psnr(clean_g, after_g):.2f} dB")
            lines.append(f"SSIM 前/后: {metrics.ssim(clean_g, before_g):.4f} / "
                         f"{metrics.ssim(clean_g, after_g):.4f}")
            untouched = metrics.untouched_change(before_g, after_g, union)
            lines.append(f"区域外平均变化: {untouched['mean_abs']:.5f}")
            if self.input_set.targets:
                summ = metrics.check_targets(clean_g, after_g, self.input_set.targets)["summary"]
                inside = summ.get("inside_region", {})
                lines.append(
                    f"区域内保留目标通过: {inside.get('passed', 0)}/{inside.get('count', 0)}"
                    f"  线宽误差均值 {inside.get('line_width_abs_error_mean_px')}"
                    f" px  边缘位置误差 {inside.get('edge_position_error_mean_px')} px"
                )
        union = self.result.apply_mask_union()
        lines.append(f"实际应用区域: {int((union > 0.5).sum())} px")
        # Overlap / order transparency: how many requested pixels got taken over.
        active = [r for r in self.result.regions if r.enabled]
        h, w = union.shape
        req = np.zeros((h, w), dtype=np.int16)
        for r in active:
            req += (ops.rect_mask((h, w), r.rect, feather=0.0) > 0.5).astype(np.int16)
        overlap = int((req > 1).sum())
        if overlap:
            lines.append(
                f"重叠像素: {overlap} px (共 {len(active)} 个区域, 按 order 升序覆盖)"
            )
        for i, r in enumerate(active):
            eff = self.result.effective_masks[i] if i < len(self.result.effective_masks) else None
            n_eff = int((eff > 0.5).sum()) if eff is not None else 0
            lines.append(f"  - {r.name} 序{r.order}: 实际生效 {n_eff} px, {r.angle:.1f}° {r.length:.1f}px")
        self.readout.insert(tk.END, "\n".join(lines))

    # --------------------------------------------------------------- export
    def on_export(self) -> None:
        if self.result is None:
            self.on_restore()
        if self.result is None:
            messagebox.showinfo("导出", "还没有修复结果")
            return
        outdir = filedialog.askdirectory(title="导出目录")
        if not outdir:
            return
        params = self.result.params.to_dict()
        params.update({k: v for k, v in self._extra_export().items()})
        meta = report.export_session(
            Path(outdir),
            self.result,
            input_set=self.input_set,
            extra={"gui_params": params, "estimates": {
                name: est.to_dict() for name, est in self.estimates.items()
            }},
        )
        self.set_status(f"已导出到 {outdir}")
        messagebox.showinfo("导出完成", json.dumps(meta, indent=2, ensure_ascii=False))

    def _extra_export(self) -> dict:
        return {
            "regions": [r.to_dict() for r in self.regions],
            "noise_sigma": float(self.var_noise.get()),
        }


def main(initial: str | None = None) -> None:
    if tk is None:
        print(
            "tkinter 不可用, 无法启动 GUI; 请使用命令行子命令。\n"
            f"原因: {_TK_IMPORT_ERROR}",
            file=sys.stderr,
        )
        raise SystemExit(2)
    root = tk.Tk()
    app = LabApp(root, initial)
    root.mainloop()
    _ = app


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
