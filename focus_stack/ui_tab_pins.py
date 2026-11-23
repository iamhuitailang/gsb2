"""页 3：局部固定（pin）与重影检查（需求 3）。

- 在图上拖出矩形/椭圆（多边形逐点单击，双击结束），强制该区域使用指定源
- pin 列表：改所属源、删除；修改一块选择后其他 pin 保留
- 重影高亮：接缝带内颜色差异大的位置用红色叠加，pin 周边单独统计
- 大面积纯色区选取是否稳定，可打开“显示标签底图”核对连片程度
"""
from __future__ import annotations

import tkinter as tk
from tkinter import messagebox, ttk

import cv2
import numpy as np

from .fusion import SOURCE_COLORS_BGR
from .selection import pin_ghost
from .ui_canvas import ZoomCanvas


class PinTab(ttk.Frame):
    def __init__(self, master, state, app):
        super().__init__(master)
        self.state = state
        self.app = app
        self.zoom_group: list[ZoomCanvas] = []
        self._draw_mode = "rect"
        self._drag_start = None
        self._poly_points: list[tuple[int, int]] = []
        self._rubber = None
        self._build()

    def _build(self):
        bar = ttk.Frame(self)
        bar.pack(fill="x", padx=8, pady=6)
        ttk.Label(bar, text="绘制形状：").pack(side="left")
        self.shape_var = tk.StringVar(value="rect")
        for txt, val in [("矩形", "rect"), ("椭圆", "ellipse"), ("多边形", "polygon")]:
            ttk.Radiobutton(bar, text=txt, value=val, variable=self.shape_var,
                            command=self._shape_changed).pack(side="left")
        ttk.Label(bar, text="　固定给源：").pack(side="left")
        self.source_var = tk.IntVar(value=0)
        self.source_box = ttk.Combobox(bar, width=4, textvariable=self.source_var,
                                       state="readonly")
        self.source_box.pack(side="left")
        ttk.Button(bar, text="撤销多边形点", command=self._undo_poly).pack(side="left", padx=8)
        ttk.Button(bar, text="删除选中 pin", command=self._delete_pin).pack(side="left")
        self.ghost_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(bar, text="重影高亮", variable=self.ghost_var,
                        command=self.refresh_view).pack(side="left", padx=10)
        self.label_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(bar, text="标签底图（看纯色区选取连片）",
                        variable=self.label_var,
                        command=self.refresh_view).pack(side="left")
        ttk.Button(bar, text="重新融合", style="Accent.TButton",
                   command=self.app.refresh_refusion).pack(side="right")

        body = ttk.Panedwindow(self, orient="horizontal")
        body.pack(fill="both", expand=True, padx=8, pady=(0, 8))
        left = ttk.Labelframe(body, text="固定区域编辑（左键拖拽/点击；多边形双击结束）")
        body.add(left, weight=3)
        self.canvas = ZoomCanvas(left, zoom_group=self.zoom_group)
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<ButtonPress-1>", self._canvas_down, add="+")
        self.canvas.bind("<B1-Motion>", self._canvas_drag, add="+")
        self.canvas.bind("<ButtonRelease-1>", self._canvas_up, add="+")
        self.canvas.bind("<Double-Button-1>", self._canvas_double, add="+")
        # 仅当 pin 页处于激活状态时，画布上的鼠标事件才用于绘制 pin，
        # 避免其他页签/程序化事件误创建 pin
        self._active = False
        self.winfo_toplevel().bind(
            "<<NotebookTabChanged>>", self._tab_changed, add="+")

        right = ttk.Frame(body)
        body.add(right, weight=2)
        lf = ttk.Labelframe(right, text="已固定区域（其他 pin 在编辑时保留）")
        lf.pack(fill="both", expand=True)
        cols = ("name", "shape", "source")
        self.tree = ttk.Treeview(lf, columns=cols, show="headings", height=8)
        for c, t, w in [("name", "名称", 140), ("shape", "形状", 80),
                        ("source", "固定给源", 80)]:
            self.tree.heading(c, text=t)
            self.tree.column(c, width=w)
        self.tree.pack(fill="both", expand=True, padx=4, pady=4)
        self.tree.bind("<<TreeviewSelect>>", lambda _e: self._select_pin())
        sf = ttk.Frame(right)
        sf.pack(fill="x")
        ttk.Label(sf, text="改为源：").pack(side="left")
        self.change_box = ttk.Combobox(sf, width=4, state="readonly")
        self.change_box.pack(side="left")
        ttk.Button(sf, text="应用", command=self._change_source).pack(side="left", padx=4)

        gf = ttk.Labelframe(right, text="重影检查（接缝带颜色差异，0~255）")
        gf.pack(fill="x", pady=(6, 0))
        self.ghost_label = ttk.Label(gf, text="", justify="left")
        self.ghost_label.pack(anchor="w", padx=6, pady=4)
        self.pin_ghost_label = ttk.Label(gf, text="", justify="left")
        self.pin_ghost_label.pack(anchor="w", padx=6, pady=(0, 6))

    # ------------------------------------------------------------------ #
    def _tab_changed(self, event):
        nb = event.widget
        cur = nb.select()
        self._active = bool(cur) and str(nb.nametowidget(cur)) == str(self)

    def _shape_changed(self):
        self._draw_mode = self.shape_var.get()
        self._poly_points.clear()

    def _undo_poly(self):
        if self._poly_points:
            self._poly_points.pop()
            self._redraw_poly()

    def _canvas_down(self, event):
        if not self._active or not self.state.result:
            return
        x, y = self.canvas.image_coords(event)
        if self._draw_mode == "polygon":
            self._poly_points.append((x, y))
            self._redraw_poly()
        else:
            self._drag_start = (x, y)

    def _canvas_drag(self, event):
        if not self._active or not self.state.result or self._drag_start is None:
            return
        x, y = self.canvas.image_coords(event)
        x0, y0 = self._drag_start
        if self._rubber:
            self.canvas.delete(self._rubber)
        self._rubber = self.canvas.create_rectangle(
            min(x0, x) * self.canvas.zoom, min(y0, y) * self.canvas.zoom,
            max(x0, x) * self.canvas.zoom, max(y0, y) * self.canvas.zoom,
            outline="#00ffff", width=2)

    def _canvas_up(self, event):
        if not self._active or not self.state.result or self._drag_start is None:
            self._drag_start = None
            return
        x, y = self.canvas.image_coords(event)
        x0, y0 = self._drag_start
        self._drag_start = None
        if self._rubber:
            self.canvas.delete(self._rubber)
            self._rubber = None
        if abs(x - x0) + abs(y - y0) < 5:
            return
        src = int(self.source_var.get())
        pin = self.state.add_pin(src, self._draw_mode, [x0, y0, x, y],
                                 name=f"{self._draw_mode}→源{src + 1}")
        self.app.refresh_refusion()
        self._select_pin_id(pin.id)

    def _canvas_double(self, _event):
        if not self._active:
            return
        if self._draw_mode != "polygon" or len(self._poly_points) < 3:
            return
        src = int(self.source_var.get())
        pin = self.state.add_pin(src, "polygon", list(self._poly_points),
                                 name=f"polygon→源{src + 1}")
        self._poly_points.clear()
        self.app.refresh_refusion()
        self._select_pin_id(pin.id)

    def _redraw_poly(self):
        self.refresh_view()
        if len(self._poly_points) >= 2:
            pts = [c for p in self._poly_points for c in
                   (p[0] * self.canvas.zoom, p[1] * self.canvas.zoom)]
            self.canvas.create_line(*pts, fill="#00ffff", width=2)
        for x, y in self._poly_points:
            self.canvas.create_oval(x * self.canvas.zoom - 3, y * self.canvas.zoom - 3,
                                    x * self.canvas.zoom + 3, y * self.canvas.zoom + 3,
                                    fill="#00ffff")

    # ------------------------------------------------------------------ #
    def _delete_pin(self):
        sel = self.tree.selection()
        if not sel:
            return
        pin_id = sel[0]
        if self.state.remove_pin(pin_id):
            self.app.refresh_refusion()

    def _select_pin(self):
        sel = self.tree.selection()
        if sel:
            self._selected_id = sel[0]

    def _select_pin_id(self, pin_id):
        for iid in self.tree.get_children():
            if iid == pin_id:
                self.tree.selection_set(iid)

    def _change_source(self):
        sel = self.tree.selection()
        if not sel or not self.change_box.get():
            return
        self.state.set_pin_source(sel[0], int(self.change_box.get()))
        self.app.refresh_refusion()
        self._select_pin_id(sel[0])

    # ------------------------------------------------------------------ #
    def refresh_after_run(self):
        n = len(self.state.images)
        values = [str(i) for i in range(n)]
        self.source_box["values"] = values
        self.change_box["values"] = values
        if not self.source_box.get():
            self.source_box.set(0)
            self.change_box.set(0)
        self.refresh_view()

    def refresh_view(self):
        r = self.state.result
        if r is None:
            return
        base = r.fusion.composite.copy()
        if self.label_var.get():
            base = cv2.addWeighted(base, 0.35, r.fusion.source_map, 0.65, 0)

        # pin 轮廓
        for pin in self.state.pins.pins:
            color = SOURCE_COLORS_BGR[pin.source_index % len(SOURCE_COLORS_BGR)]
            bright = tuple(min(255, c + 90) for c in color)
            if pin.shape == "polygon":
                cv2.polylines(base, [np.asarray(pin.coords, np.int32)], True, bright, 2)
            else:
                x0, y0, x1, y1 = pin.coords
                if pin.shape == "rect":
                    cv2.rectangle(base, (x0, y0), (x1, y1), bright, 2)
                else:
                    cv2.ellipse(base,
                                ((x0 + x1) // 2, (y0 + y1) // 2),
                                (abs(x1 - x0) // 2, abs(y1 - y0) // 2),
                                0, 0, 360, bright, 2)

        # 重影高亮
        if self.ghost_var.get():
            g = r.ghost
            if r.fusion.bbox is not None:
                x0, y0, x1, y1 = r.fusion.bbox
                g = g[y0:y1, x0:x1]
            strong = (g > 40).astype(np.uint8) * 255
            red = np.zeros_like(base)
            red[..., 2] = strong
            base = cv2.addWeighted(base, 1.0, red, 0.55, 0)

        self.canvas.set_image(base)

        # pin 列表（id 作为 iid，增删后其余行保持）
        existing = set(self.tree.get_children())
        alive = set()
        for pin in self.state.pins.pins:
            alive.add(pin.id)
            if pin.id not in existing:
                self.tree.insert("", "end", iid=pin.id,
                                 values=(pin.name, pin.shape, pin.source_index))
            else:
                self.tree.item(pin.id,
                               values=(pin.name, pin.shape, pin.source_index))
        for gone in existing - alive:
            self.tree.delete(gone)

        # 重影统计
        st = r.ghost_stats
        self.ghost_label.configure(
            text=(f"接缝带像素：{st['seam_pixels']}　平均差异：{st['mean']:.1f}　"
                  f"P90：{st['p90']:.1f}　最大：{st['max']:.0f}\n"
                  "红色越亮=该交界附近两张源颜色差越大，柔和融合越可能出现重影"))
        lines = []
        for pin in self.state.pins.pins:
            pg = pin_ghost(pin, r.ghost)
            if pg["pixels"]:
                lines.append(f"{pin.name}：覆盖 {pg['pixels']} px，"
                             f"接缝差异均值 {pg['mean']:.1f}，最大 {pg['max']:.0f}")
        self.pin_ghost_label.configure(text="\n".join(lines) or "尚无固定区域")
