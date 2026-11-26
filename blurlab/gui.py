"""Tk 界面：拖影校准、选区预览、三联对比、参数扫描、导出。

启动：``python3 -m blurlab.gui``

界面只做事件转发，逻辑在 :mod:`blurlab.app`。交互要点
-----------------------------------------------------
- 画布工具：``参考边`` 模式下一拖 = 一条跨边线段；``选区`` 模式下一拖 = 一个区域；
- 滚轮缩放、中键/右键拖拽平移，三联视图共享同一缩放；
- 参考边模式可连续拖多条，估计结果实时显示依赖窗口与置信度；
- "实际范围" 按钮切换彩色覆盖图，显示重叠处的生效归属与覆盖计数。
"""

from __future__ import annotations

import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import numpy as np
from PIL import Image, ImageTk

from .app import AppController
from .compare import ViewState, render_triptych
from .regions import coverage_overlay


class BlurLabGUI:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("BlurLab — 移动标牌拖影修复试验台")
        self.root.geometry("1380x860")
        self.ctl = AppController()

        self.tool = tk.StringVar(value="edge")  # edge | region | pan
        self.drag_start: tuple[float, float] | None = None
        self.drag_line: int | None = None
        self.drag_rect: int | None = None
        self._photo_main: ImageTk.PhotoImage | None = None
        self._photo_tri: ImageTk.PhotoImage | None = None
        self._tri_rect: tuple[int, int, int, int] | None = None
        self.show_coverage = tk.BooleanVar(value=False)

        self._build_layout()
        self._bind_events()
        self._refresh_all()

    # ------------------------------------------------------------------ 布局
    def _build_layout(self) -> None:
        top = ttk.Frame(self.root, padding=4)
        top.pack(side=tk.TOP, fill=tk.X)
        ttk.Button(top, text="打开图片", command=self.on_open).pack(side=tk.LEFT, padx=2)
        ttk.Button(top, text="生成样例", command=self.on_generate).pack(side=tk.LEFT, padx=2)
        ttk.Button(top, text="打开拖影样例", command=self.on_open_blurred).pack(side=tk.LEFT, padx=2)
        ttk.Separator(top, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=6)
        for text, value in (("参考边", "edge"), ("选区", "region"), ("平移", "pan")):
            ttk.Radiobutton(top, text=text, value=value, variable=self.tool).pack(side=tk.LEFT, padx=2)
        ttk.Separator(top, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=6)
        ttk.Button(top, text="预览", command=self.on_preview).pack(side=tk.LEFT, padx=2)
        ttk.Button(top, text="适应窗口", command=self.on_fit).pack(side=tk.LEFT, padx=2)
        ttk.Button(top, text="导出", command=self.on_export).pack(side=tk.LEFT, padx=2)
        ttk.Button(top, text="验证", command=self.on_validate).pack(side=tk.LEFT, padx=2)
        ttk.Checkbutton(top, text="显示实际应用范围", variable=self.show_coverage,
                        command=self.refresh_main).pack(side=tk.LEFT, padx=8)

        main = ttk.PanedWindow(self.root, orient=tk.HORIZONTAL)
        main.pack(fill=tk.BOTH, expand=True)

        left = ttk.Frame(main)
        main.add(left, weight=3)
        self.canvas = tk.Canvas(left, background="#18181c", highlightthickness=0)
        self.canvas.pack(fill=tk.BOTH, expand=True)
        self.status = ttk.Label(left, text="就绪", anchor=tk.W, padding=(6, 3))
        self.status.pack(fill=tk.X)

        self.tri_canvas = tk.Canvas(left, background="#121215", height=300, highlightthickness=0)
        self.tri_canvas.pack(fill=tk.X)

        right = ttk.Notebook(main)
        main.add(right, weight=2)
        self.nb = right

        self._tab_estimate(right)
        self._tab_region(right)
        self._tab_sweep(right)
        self._tab_log(right)

    def _tab_estimate(self, nb: ttk.Notebook) -> None:
        f = ttk.Frame(nb, padding=6)
        nb.add(f, text="估计")
        ttk.Label(f, text="参考边：切到「参考边」工具，在清晰的边上一拖。\n可拖多条法向不同的边。",
                  justify=tk.LEFT).pack(anchor=tk.W)
        ttk.Button(f, text="清除参考边", command=self.on_clear_edges).pack(anchor=tk.W, pady=4)

        self.est_text = tk.Text(f, height=16, wrap=tk.WORD)
        self.est_text.pack(fill=tk.X, pady=4)

        ttk.Separator(f).pack(fill=tk.X, pady=6)
        ttk.Label(f, text="手填参数（估计不稳时）").pack(anchor=tk.W)
        row = ttk.Frame(f)
        row.pack(fill=tk.X, pady=2)
        ttk.Label(row, text="长度 px").pack(side=tk.LEFT)
        self.manual_len = ttk.Entry(row, width=7)
        self.manual_len.insert(0, "9")
        self.manual_len.pack(side=tk.LEFT, padx=3)
        ttk.Label(row, text="方向 °").pack(side=tk.LEFT)
        self.manual_angle = ttk.Entry(row, width=7)
        self.manual_angle.insert(0, "30")
        self.manual_angle.pack(side=tk.LEFT, padx=3)
        ttk.Button(row, text="采用手填", command=self.on_manual).pack(side=tk.LEFT, padx=4)

        ttk.Separator(f).pack(fill=tk.X, pady=6)
        ttk.Label(f, text="参考边剖面（拟合 vs 实测）").pack(anchor=tk.W)
        self.profile_canvas = tk.Canvas(f, height=170, background="#1b1b20", highlightthickness=0)
        self.profile_canvas.pack(fill=tk.X, pady=4)

    def _tab_region(self, nb: ttk.Notebook) -> None:
        f = ttk.Frame(nb, padding=6)
        nb.add(f, text="选区")
        ttk.Label(f, text="切到「选区」工具在图上拖出矩形；每个选区可单独设参数。").pack(anchor=tk.W)

        cols = ("label", "length", "angle", "prio", "feather")
        self.region_tree = ttk.Treeview(f, columns=cols, show="headings", height=7)
        for c, t, w in (
            ("label", "区域", 50),
            ("length", "长度", 56),
            ("angle", "方向", 56),
            ("prio", "次序", 46),
            ("feather", "羽化", 50),
        ):
            self.region_tree.heading(c, text=t)
            self.region_tree.column(c, width=w, anchor=tk.CENTER)
        self.region_tree.pack(fill=tk.X, pady=4)
        self.region_tree.bind("<<TreeviewSelect>>", lambda e: self._sync_region_controls())

        ttk.Button(f, text="删除选中区域", command=self.on_delete_region).pack(anchor=tk.W)

        g = ttk.Frame(f)
        g.pack(fill=tk.X, pady=6)
        self.region_vars = {}
        specs = [
            ("length_px", "长度 px", 0.0, 60.0, 0.5),
            ("angle_deg", "方向 °", 0.0, 180.0, 1.0),
            ("noise_gain", "噪点放大上限", 1.0, 30.0, 0.5),
            ("regularization", "正则强度", 0.1, 30.0, 0.1),
            ("shadow_limit", "暗侧过冲上限", 0.0, 0.5, 0.01),
            ("overshoot", "亮侧过冲上限", 0.0, 0.5, 0.01),
            ("feather_px", "羽化 px", 0.0, 40.0, 1.0),
            ("priority", "次序(小=先处理)", 0.0, 99.0, 1.0),
        ]
        for i, (key, label, lo, hi, step) in enumerate(specs):
            ttk.Label(g, text=label).grid(row=i, column=0, sticky=tk.W, pady=1)
            var = tk.DoubleVar(value=lo)
            self.region_vars[key] = var
            ttk.Scale(
                g, from_=lo, to=hi, variable=var, orient=tk.HORIZONTAL, length=150,
                command=lambda _v, k=key: self._on_region_slider(k),
            ).grid(row=i, column=1, sticky=tk.EW, padx=4)
            ent = ttk.Entry(g, width=6)
            ent.grid(row=i, column=2)
            ent.bind("<Return>", lambda _e, k=key: self._on_entry_commit(k))
            ent.bind("<FocusOut>", lambda _e, k=key: self._on_entry_commit(k))
            self.region_vars[key + "_entry"] = ent  # type: ignore[assignment]
        g.columnconfigure(1, weight=1)

        ttk.Button(f, text="只预览该选区（含边沿余量）", command=self.on_preview_selected).pack(anchor=tk.W, pady=4)
        ttk.Button(f, text="应用参数并刷新", command=self.on_preview).pack(anchor=tk.W)

    def _tab_sweep(self, nb: ttk.Notebook) -> None:
        f = ttk.Frame(nb, padding=6)
        nb.add(f, text="扫描")
        ttk.Label(f, text="长度列表 (逗号分隔)").pack(anchor=tk.W)
        self.sweep_lengths = ttk.Entry(f)
        self.sweep_lengths.insert(0, "5,7,9,11,13,15,17,21")
        self.sweep_lengths.pack(fill=tk.X)
        ttk.Label(f, text="噪点放大上限列表").pack(anchor=tk.W, pady=(6, 0))
        self.sweep_gains = ttk.Entry(f)
        self.sweep_gains.insert(0, "2,4,6")
        self.sweep_gains.pack(fill=tk.X)
        ttk.Button(f, text="对选中区域扫描", command=self.on_sweep).pack(anchor=tk.W, pady=6)
        self.sweep_text = tk.Text(f, height=18)
        self.sweep_text.pack(fill=tk.BOTH, expand=True)

    def _tab_log(self, nb: ttk.Notebook) -> None:
        f = ttk.Frame(nb, padding=6)
        nb.add(f, text="日志")
        self.log_text = tk.Text(f, wrap=tk.WORD)
        self.log_text.pack(fill=tk.BOTH, expand=True)

    # ------------------------------------------------------------------ 事件
    def _bind_events(self) -> None:
        self.canvas.bind("<ButtonPress-1>", self.on_press)
        self.canvas.bind("<B1-Motion>", self.on_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)
        self.canvas.bind("<MouseWheel>", self.on_wheel)
        self.canvas.bind("<Button-4>", lambda e: self.on_wheel(e, 1.1))
        self.canvas.bind("<Button-5>", lambda e: self.on_wheel(e, 1 / 1.1))
        self.canvas.bind("<Shift-B1-Motion>", lambda e: None)
        self.canvas.bind("<ButtonPress-3>", self.on_right_press)
        self.canvas.bind("<B3-Motion>", self.on_right_drag)
        self.canvas.bind("<Configure>", lambda e: self.refresh_main())
        self.root.bind("<Control-o>", lambda e: self.on_open())

    def _img_xy(self, sx: float, sy: float) -> tuple[float, float]:
        return self.ctl.s.view.screen_to_image(sx, sy)

    def on_press(self, event) -> None:
        self.drag_start = (event.x, event.y)
        if self.tool.get() == "pan":
            return
        if self.tool.get() == "edge":
            self.drag_line = self.canvas.create_line(event.x, event.y, event.x, event.y,
                                                     fill="#ffd23c", width=2)
        elif self.tool.get() == "region":
            self.drag_rect = self.canvas.create_rectangle(event.x, event.y, event.x, event.y,
                                                          outline="#41d4ff", width=2)

    def on_drag(self, event) -> None:
        if self.tool.get() == "pan" and self.drag_start is not None:
            self.ctl.pan(event.x - self.drag_start[0], event.y - self.drag_start[1])
            self.drag_start = (event.x, event.y)
            self.refresh_main()
            return
        if self.drag_line is not None and self.drag_start:
            self.canvas.coords(self.drag_line, self.drag_start[0], self.drag_start[1], event.x, event.y)
        if self.drag_rect is not None and self.drag_start:
            self.canvas.coords(self.drag_rect, self.drag_start[0], self.drag_start[1], event.x, event.y)

    def on_release(self, event) -> None:
        if self.drag_start is None:
            return
        x0, y0 = self.drag_start
        x1, y1 = event.x, event.y
        mode = self.tool.get()
        if self.drag_line is not None:
            self.canvas.delete(self.drag_line)
            self.drag_line = None
            self.ctl.add_reference_edge(self._img_xy(x0, y0), self._img_xy(x1, y1))
            self._log_estimate()
            self.refresh_main()
        elif self.drag_rect is not None:
            self.canvas.delete(self.drag_rect)
            self.drag_rect = None
            ix0, iy0 = self._img_xy(x0, y0)
            ix1, iy1 = self._img_xy(x1, y1)
            if abs(ix1 - ix0) < 3 or abs(iy1 - iy0) < 3:
                self.drag_start = None
                return
            try:
                region = self.ctl.add_region((ix0, iy0, ix1, iy1))
            except ValueError as exc:
                self.status.config(text=str(exc))
                self.drag_start = None
                return
            self._refresh_region_list(select=region)
            self.on_preview()
        self.drag_start = None

    def on_right_press(self, event) -> None:
        self._right_anchor = (event.x, event.y)

    def on_right_drag(self, event) -> None:
        anchor = getattr(self, "_right_anchor", None)
        if anchor is None:
            return
        self.ctl.pan(event.x - anchor[0], event.y - anchor[1])
        self._right_anchor = (event.x, event.y)
        self.refresh_main()

    def on_wheel(self, event, factor: float | None = None) -> None:
        if factor is None:
            factor = 1.15 if event.delta > 0 else 1 / 1.15
        self.ctl.zoom(factor, event.x, event.y)
        self.refresh_main()

    # ---------------------------------------------------------------- 动作
    def on_open(self) -> None:
        path = filedialog.askopenfilename(
            filetypes=[("图片", "*.png *.jpg *.jpeg *.bmp *.tif *.tiff"), ("全部", "*.*")]
        )
        if not path:
            return
        self.ctl.load_image(path)
        self.ctl.fit_view(self.canvas.winfo_width(), self.canvas.winfo_height())
        self._refresh_all()
        self.status.config(text=f"已载入 {path}")

    def on_open_blurred(self) -> None:
        path = filedialog.askopenfilename(
            filetypes=[("图片", "*.png *.jpg *.jpeg *.bmp *.tif *.tiff"), ("全部", "*.*")]
        )
        if not path:
            return
        self.ctl.load_blurred_sample(path)
        self.ctl.fit_view(self.canvas.winfo_width(), self.canvas.winfo_height())
        self._refresh_all()
        self.status.config(text=f"已载入 {path}")

    def on_generate(self) -> None:
        outdir = filedialog.askdirectory(title="选择样例输出目录")
        if not outdir:
            return
        paths = self.ctl.generate_samples(Path(outdir))
        self.ctl.load_blurred_sample(paths["variants"][0]["path"])
        self._refresh_all()
        self.status.config(text=f"样例已生成到 {outdir}")

    def on_clear_edges(self) -> None:
        self.ctl.clear_reference_edges()
        self.est_text.delete("1.0", tk.END)
        self.refresh_main()

    def on_manual(self) -> None:
        try:
            L = float(self.manual_len.get())
            a = float(self.manual_angle.get())
        except ValueError:
            self.status.config(text="手填参数需要数字")
            return
        self.ctl.set_manual_estimate(L, a)
        self._log_estimate()
        self.refresh_main()

    def on_fit(self) -> None:
        """把图像适配进主画布；三联视图共享同一 scale。"""
        self.ctl.fit_view(self.canvas.winfo_width(), self.canvas.winfo_height())
        self.refresh_main()
        if self.ctl.s.last_pipeline is not None:
            self.refresh_triptych()

    def on_preview(self) -> None:
        if self.ctl.s.image is None:
            return
        try:
            p = self.ctl.preview()
        except Exception as exc:  # noqa: BLE001
            messagebox.showerror("预览失败", str(exc))
            return
        for note in p.notes:
            self._log(note)
        self._log(f"预览完成，{p.elapsed_ms:.0f} ms")
        self.refresh_main()
        self.refresh_triptych()

    def on_preview_selected(self) -> None:
        region = self._selected_region()
        if region is None:
            self.status.config(text="先选一个区域")
            return
        out = self.ctl.preview_selected_only(region)
        x0, y0, x1, y1 = region.rect
        from .deblur import suggested_padding

        m = suggested_padding(region.params.length_px)
        h, w = self.ctl.s.image.shape[:2]
        bx0, by0 = max(0, x0 - m), max(0, y0 - m)
        bx1, by1 = min(w, x1 + m), min(h, y1 + m)
        orig = self.ctl.s.image[by0:by1, bx0:bx1]
        img, _ = render_triptych(orig, out, orig - out, pane_size=(360, 260))
        self._show_triptych(img)
        self.status.config(text=f"选区 {region.label} 局部预览（含余量 {m}px）")

    def on_delete_region(self) -> None:
        region = self._selected_region()
        if region is None:
            return
        self.ctl.remove_region(region)
        self._refresh_region_list()
        self.on_preview()

    def on_export(self) -> None:
        outdir = filedialog.askdirectory(title="导出目录")
        if not outdir:
            return
        try:
            paths = self.ctl.export(outdir)
        except Exception as exc:  # noqa: BLE001
            messagebox.showerror("导出失败", str(exc))
            return
        self._log("导出: " + ", ".join(paths.values()))
        messagebox.showinfo("导出完成", "\n".join(paths.values()))

    def on_validate(self) -> None:
        try:
            text = self.ctl.validate()
        except Exception as exc:  # noqa: BLE001
            messagebox.showerror("验证失败", str(exc))
            return
        self._log(text)
        self.status.config(text="验证结果见日志页")

    def on_sweep(self) -> None:
        region = self._selected_region()
        if region is None:
            self.status.config(text="先选一个区域")
            return
        try:
            lengths = [float(v) for v in self.sweep_lengths.get().split(",") if v.strip()]
            gains = [float(v) for v in self.sweep_gains.get().split(",") if v.strip()]
        except ValueError:
            self.status.config(text="扫描参数需要数字列表")
            return
        rows = self.ctl.sweep(region, lengths, gains)
        self.sweep_text.delete("1.0", tk.END)
        self.sweep_text.insert(tk.END, self.ctl.sweep_text())

    # ---------------------------------------------------------------- 渲染
    def _selected_region(self):
        sel = self.region_tree.selection()
        if not sel or self.ctl.s.region_set is None:
            return None
        label = sel[0]
        for r in self.ctl.s.region_set.regions:
            if r.label == label:
                return r
        return None

    def _refresh_region_list(self, select=None) -> None:
        self.region_tree.delete(*self.region_tree.get_children())
        if self.ctl.s.region_set is None:
            return
        for r in self.ctl.s.region_set.regions:
            self.region_tree.insert(
                "",
                tk.END,
                iid=r.label,
                values=(
                    r.label,
                    f"{r.params.length_px:.1f}",
                    f"{r.params.angle_deg:.1f}",
                    r.priority,
                    f"{r.feather_px:.0f}",
                ),
            )
        if select is not None:
            self.region_tree.selection_set(select.label)
        self._sync_region_controls()

    def _sync_region_controls(self) -> None:
        region = self._selected_region()
        if region is None:
            return
        self.ctl.s.active_region = region
        values = {
            "length_px": region.params.length_px,
            "angle_deg": region.params.angle_deg,
            "noise_gain": region.params.noise_gain,
            "regularization": region.params.regularization,
            "shadow_limit": region.params.shadow_limit,
            "overshoot": region.params.overshoot,
            "feather_px": region.feather_px,
            "priority": float(region.priority),
        }
        for key, val in values.items():
            var = self.region_vars[key]
            var.set(float(val))
            entry = self.region_vars.get(key + "_entry")
            if isinstance(entry, ttk.Entry):
                entry.delete(0, tk.END)
                entry.insert(0, f"{val:g}")

    def _on_region_slider(self, key: str) -> None:
        region = self._selected_region()
        if region is None:
            return
        value = self.region_vars[key].get()
        self.ctl.update_region_params(region, **{key: value})
        entry = self.region_vars.get(key + "_entry")
        if isinstance(entry, ttk.Entry):
            entry.delete(0, tk.END)
            entry.insert(0, f"{value:g}")
        # 只更新列表行，避免整表重建触发 <<TreeviewSelect>> 再回灌滑杆形成递归
        if self.region_tree.exists(region.label):
            self.region_tree.item(
                region.label,
                values=(
                    region.label,
                    f"{region.params.length_px:.1f}",
                    f"{region.params.angle_deg:.1f}",
                    region.priority,
                    f"{region.feather_px:.0f}",
                ),
            )

    def _on_entry_commit(self, key: str) -> None:
        """数值输入框回车/失焦时提交，并同步回滑杆。"""
        region = self._selected_region()
        entry = self.region_vars.get(key + "_entry")
        if region is None or not isinstance(entry, ttk.Entry):
            return
        raw = entry.get().strip()
        try:
            value = float(raw)
        except ValueError:
            # 非法输入回滚到当前值
            self._sync_region_controls()
            return
        self.ctl.update_region_params(region, **{key: value})
        var = self.region_vars[key]
        var.set(value)
        self._refresh_region_list(select=region)

    def _log_estimate(self) -> None:
        est = self.ctl.s.estimate
        if est is None:
            return
        d = est.to_dict()
        length_txt = "未知" if d["length_px"] is None else f"{d['length_px']:.2f}"
        angle_txt = "未知" if d["angle_deg"] is None else f"{d['angle_deg']:.1f}°"
        lines = [
            f"方法: {d['method']}   置信度: {d['confidence']:.2f}",
            f"长度: {length_txt} ± {d['length_ci95_px']:.2f} px",
            f"方向: {angle_txt} ± {d['angle_ci95_deg']:.1f}°",
            "",
        ]
        for f in d["edges"]:
            lines.append(
                f"边 {f['label']}: 法向 {f['normal_deg']:.1f}°, 投影宽 {f['width_px']:.2f}±{f['width_ci95_px']:.2f} px"
            )
            lo, hi = f["significant_u_range"]
            lines.append(f"    依赖范围 u∈[{lo:.1f}, {hi:.1f}] px（窗半宽 {f['fit_window_half_px']:.0f}）")
            lines.append(f"    σ0={f['sensor_sigma_px']:.2f} px, RSS={f['rss']:.2e}")
        if d["warnings"]:
            lines.append("")
            lines.extend("⚠ " + w for w in d["warnings"])
        if d["method"] == "single-edge" and d["length_vs_angle"]:
            lines.append("")
            lines.append("单边长度依赖 (L = w / cosΔ):")
            for c in d["length_vs_angle"][:6]:
                lines.append(f"    Δ={c['angle_offset_deg']:>2}° -> L={c['length_px']:.1f} px")
        self.est_text.delete("1.0", tk.END)
        self.est_text.insert(tk.END, "\n".join(lines))
        self._draw_profiles()

    def _draw_profiles(self) -> None:
        c = self.profile_canvas
        c.delete("all")
        est = self.ctl.s.estimate
        if est is None or not est.edge_fits:
            return
        w = max(200, c.winfo_width())
        h = max(120, c.winfo_height())
        colors = ["#ff7a59", "#4fc3f7", "#9ccc65", "#ffd54f"]
        for i, fit in enumerate(est.edge_fits[:3]):
            pad = 10
            u = fit.u
            v = fit.v
            lo = min(v.min(), fit.model.min())
            hi = max(v.max(), fit.model.max())
            span = max(1e-6, hi - lo)

            def px(uu, vv):
                x = pad + (uu - u[0]) / max(1e-6, u[-1] - u[0]) * (w - 2 * pad)
                y = h - pad - (vv - lo) / span * (h - 2 * pad)
                return x, y

            pts_v = [coord for uu, vv in zip(u, fit.v) for coord in px(uu, vv)]
            c.create_line(*pts_v, fill=colors[i % len(colors)], width=1)
            pts_m = [coord for uu, vv in zip(u, fit.model) for coord in px(uu, vv)]
            c.create_line(*pts_m, fill="#ffffff", width=2, dash=(4, 2))
        c.create_text(6, 6, anchor=tk.NW, text="实线=实测  虚线=拟合", fill="#cccccc")

    def refresh_main(self) -> None:
        if self.ctl.s.image is None:
            self.canvas.delete("all")
            return
        img = self.ctl.s.image
        if self.show_coverage.get() and self.ctl.s.region_set is not None:
            img = coverage_overlay(img, self.ctl.s.region_set, mode="owner")
        view = self.ctl.s.view
        cw = max(50, self.canvas.winfo_width())
        ch = max(50, self.canvas.winfo_height())
        if view.scale <= 0:
            view.fit(img.shape[1], img.shape[0], cw, ch)

        rect = self._tri_rect
        pil = _render_single(img, view, (cw, ch), rect)
        self._photo_main = ImageTk.PhotoImage(pil)
        self.canvas.delete("all")
        self.canvas.create_image(0, 0, anchor=tk.NW, image=self._photo_main)
        self._draw_region_boxes()

    def _draw_region_boxes(self) -> None:
        if self.ctl.s.region_set is None:
            return
        view = self.ctl.s.view
        for r in self.ctl.s.region_set.regions:
            x0, y0 = view.image_to_screen(r.rect[0], r.rect[1])
            x1, y1 = view.image_to_screen(r.rect[2], r.rect[3])
            color = "#ff5f5f" if r.enabled else "#777777"
            self.canvas.create_rectangle(x0, y0, x1, y1, outline=color, width=2, dash=(5, 3))
            self.canvas.create_text(
                x0 + 3, y0 + 3, anchor=tk.NW,
                text=f"{r.label} L{r.params.length_px:.0f} θ{r.params.angle_deg:.0f} p{r.priority}",
                fill=color,
            )

    def refresh_triptych(self) -> None:
        if self.ctl.s.last_pipeline is None:
            return
        p = self.ctl.s.last_pipeline
        cw = max(300, self.canvas.winfo_width())
        pane_w = max(160, cw // 3)
        pane_h = max(120, self.tri_canvas.winfo_height() - 24)
        img, _ = render_triptych(
            p.original, p.result, p.residual,
            view=self.ctl.s.view, pane_size=(pane_w, pane_h),
            rect=self._tri_rect, residual_gain=self.ctl.s.residual_gain,
        )
        self._show_triptych(img)

    def _show_triptych(self, img: Image.Image) -> None:
        self._photo_tri = ImageTk.PhotoImage(img)
        self.tri_canvas.delete("all")
        self.tri_canvas.create_image(0, 0, anchor=tk.NW, image=self._photo_tri)

    def _refresh_all(self) -> None:
        self._refresh_region_list()
        self.refresh_main()
        if self.ctl.s.last_pipeline is not None:
            self.refresh_triptych()

    def _log(self, text: str) -> None:
        self.log_text.insert(tk.END, text + "\n")
        self.log_text.see(tk.END)


def _render_single(img: np.ndarray, view: ViewState, size: tuple[int, int],
                   rect: tuple[int, int, int, int] | None) -> Image.Image:
    from .compare import _render_pane

    return _render_pane(img, view, size, rect)


def main() -> int:
    try:
        root = tk.Tk()
    except tk.TclError as exc:
        print(f"无法启动 Tk 界面（{exc}）。无显示器环境请使用 CLI：python3 -m blurlab.cli --help")
        return 1
    BlurLabGUI(root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
