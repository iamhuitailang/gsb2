"""页 2：合成结果与点击回看（需求 2）。

左侧合成图（点击任一点），右侧来源图 + 该点信息：
倾向使用哪张源、各源相对清晰度、配准状态、像素颜色。
顶部切换 硬边界 / 柔和交界，调柔和温度。
"""
from __future__ import annotations

import tkinter as tk
from tkinter import ttk

import cv2
import numpy as np

from .fusion import SOURCE_COLORS_BGR
from .pipeline import point_info
from .ui_canvas import ZoomCanvas


class CompositeTab(ttk.Frame):
    def __init__(self, master, state, app):
        super().__init__(master)
        self.state = state
        self.app = app
        self.zoom_group: list[ZoomCanvas] = []
        self._build()

    def _build(self):
        bar = ttk.Frame(self)
        bar.pack(fill="x", padx=8, pady=6)
        self.mode_var = tk.StringVar(value="soft")
        ttk.Radiobutton(bar, text="柔和交界", value="soft",
                        variable=self.mode_var,
                        command=self._change_mode).pack(side="left")
        ttk.Radiobutton(bar, text="硬边界", value="hard",
                        variable=self.mode_var, command=self._change_mode).pack(side="left")
        ttk.Label(bar, text="  柔和温度：").pack(side="left")
        self.temp_var = tk.DoubleVar(value=8.0)
        scale = ttk.Scale(bar, from_=0.5, to=30, variable=self.temp_var,
                          command=lambda _v: self._change_temp())
        scale.pack(side="left")
        self.temp_label = ttk.Label(bar, width=6, text="8.0")
        self.temp_label.pack(side="left")
        ttk.Button(bar, text="重新融合", command=self.app.refresh_refusion).pack(side="left", padx=10)
        ttk.Button(bar, text="适应窗口", command=self._fit).pack(side="right")
        ttk.Button(bar, text="100%", command=lambda: self._set_zoom(1.0)).pack(side="right")

        body = ttk.Panedwindow(self, orient="horizontal")
        body.pack(fill="both", expand=True, padx=8, pady=(0, 8))

        left = ttk.Labelframe(body, text="合成图（点击任意位置回看来源）")
        body.add(left, weight=3)
        self.canvas = ZoomCanvas(left, on_click=self._on_click,
                                 zoom_group=self.zoom_group)
        self.canvas.pack(fill="both", expand=True)

        right = ttk.Frame(body)
        body.add(right, weight=2)
        smf = ttk.Labelframe(right, text="来源图（颜色=该像素取自哪张源）")
        smf.pack(fill="both", expand=True)
        self.source_canvas = ZoomCanvas(smf, zoom_group=self.zoom_group)
        self.source_canvas.pack(fill="both", expand=True)

        info = ttk.Labelframe(right, text="点击回看")
        info.pack(fill="x", pady=(6, 0))
        self.info_label = ttk.Label(info, text="点击左侧合成图查看", justify="left")
        self.info_label.pack(anchor="w", padx=6, pady=4)
        cols = ("idx", "sharp", "raw", "status", "color")
        self.tree = ttk.Treeview(info, columns=cols, show="headings", height=6)
        for c, t, w in [("idx", "源", 40), ("sharp", "相对清晰度", 90),
                        ("raw", "原始分数", 90), ("status", "配准", 60),
                        ("color", "该点 BGR", 110)]:
            self.tree.heading(c, text=t)
            self.tree.column(c, width=w, anchor="w")
        self.tree.pack(fill="x", padx=6, pady=(0, 6))
        self.legend = ttk.Label(info, text="", justify="left")
        self.legend.pack(anchor="w", padx=6, pady=(0, 6))

    # ------------------------------------------------------------------ #
    def _change_mode(self):
        self.state.settings.fusion_mode = self.mode_var.get()
        if self.state.result:
            self.app.refresh_refusion()

    def _change_temp(self):
        v = round(float(self.temp_var.get()), 2)
        self.temp_label.configure(text=str(v))
        self.state.settings.temperature = v

    def _fit(self):
        for c in self.zoom_group:
            c.fit()

    def _set_zoom(self, z):
        for c in self.zoom_group:
            c.set_zoom(z)

    def refresh_after_run(self):
        r = self.state.result
        self.mode_var.set(r.fusion.mode)
        self.temp_var.set(r.temperature)
        self.temp_label.configure(text=str(round(r.temperature, 1)))
        self._show_images()
        self._legend()
        self.after(50, self._fit)

    def _show_images(self):
        r = self.state.result
        self.canvas.set_image(r.fusion.composite)
        self.source_canvas.set_image(r.fusion.source_map)

    def _legend(self):
        n = len(self.state.images)
        parts = []
        for i in range(n):
            b, g, r = SOURCE_COLORS_BGR[i % len(SOURCE_COLORS_BGR)]
            hexv = f"#{r:02x}{g:02x}{b:02x}"
            parts.append(f"■ 源 {i + 1}")
        self.legend.configure(text="来源配色：" + "  ".join(parts))

    def _on_click(self, x, y):
        if not self.state.result:
            return
        info = point_info(self.state.result, x, y)
        x0, y0 = info["point"]
        chosen = info["chosen"]
        self.info_label.configure(
            text=f"坐标 ({x0}, {y0})　倾向采用：源 {chosen + 1 if chosen >= 0 else '—'}")
        self.tree.delete(*self.tree.get_children())
        for d in info["per_source"]:
            mark = "← 采用" if d["chosen"] else ""
            if not d["usable"]:
                status = "失败/排除"
            elif d["status"] == "warn":
                status = "警告"
            else:
                status = "正常"
            self.tree.insert(
                "", "end",
                values=(f"{d['index'] + 1} {mark}",
                        f"{d['rel_sharpness']:.3f}",
                        f"{d['raw']:.1f}", status,
                        str(d["bgr"])))
