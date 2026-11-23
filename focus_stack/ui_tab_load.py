"""页 1：导入与配准。

- 打开 3~5 张图，列表按用户给定顺序保留（可上移/下移、移除）
- 配准状态表（ok/warn/fail + 相关系数 + 说明）
- 配准边缘对照图（Canny 多色叠加，能看出哪些边缘对得上）
- 覆盖区示意
"""
from __future__ import annotations

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

import cv2
import numpy as np

from .registration import (
    EDGE_COLORS_BGR,
    STATUS_FAIL,
    STATUS_OK,
    STATUS_WARN,
    coverage_overlay,
    edge_overlay,
)
from .ui_canvas import ZoomCanvas

STATUS_TEXT = {STATUS_OK: "正常", STATUS_WARN: "警告", STATUS_FAIL: "失败"}
STATUS_COLOR = {STATUS_OK: "#1d7d32", STATUS_WARN: "#b07d00",
                STATUS_FAIL: "#b3261e"}


class LoadTab(ttk.Frame):
    def __init__(self, master, state, app):
        super().__init__(master)
        self.state = state
        self.app = app
        self.zoom_group: list[ZoomCanvas] = []
        self._build()

    def _build(self):
        top = ttk.Frame(self)
        top.pack(fill="x", padx=8, pady=6)
        ttk.Button(top, text="打开图片…（3~5 张）",
                   command=self._open_files).pack(side="left")
        ttk.Button(top, text="生成演示样例（场景）",
                   command=lambda: self.app.make_samples("scene")).pack(side="left", padx=4)
        ttk.Button(top, text="生成失败样例（明显移位）",
                   command=lambda: self.app.make_samples("failure")).pack(side="left")
        ttk.Button(top, text="上移", command=lambda: self._move(-1)).pack(side="left", padx=(16, 2))
        ttk.Button(top, text="下移", command=lambda: self._move(1)).pack(side="left", padx=2)
        ttk.Button(top, text="移除", command=self._remove).pack(side="left", padx=2)
        ttk.Button(top, text="开始配准与合成", style="Accent.TButton",
                   command=self.app.run_pipeline).pack(side="right")

        body = ttk.Panedwindow(self, orient="horizontal")
        body.pack(fill="both", expand=True, padx=8, pady=(0, 8))

        left = ttk.Frame(body)
        body.add(left, weight=1)
        self.file_list = tk.Listbox(left, height=8, activestyle="dotbox")
        self.file_list.pack(fill="x")
        cols = ("idx", "status", "cc", "detail")
        self.tree = ttk.Treeview(left, columns=cols, show="headings", height=8)
        for c, t, w in [("idx", "源", 40), ("status", "状态", 60),
                        ("cc", "相关系数", 80), ("detail", "配准说明", 420)]:
            self.tree.heading(c, text=t)
            self.tree.column(c, width=w, anchor="w")
        self.tree.pack(fill="both", expand=True, pady=(6, 0))
        self.tree.tag_configure(STATUS_OK, foreground=STATUS_COLOR[STATUS_OK])
        self.tree.tag_configure(STATUS_WARN, foreground=STATUS_COLOR[STATUS_WARN])
        self.tree.tag_configure(STATUS_FAIL, foreground=STATUS_COLOR[STATUS_FAIL])

        right = ttk.Frame(body)
        body.add(right, weight=3)
        nb = ttk.Notebook(right)
        nb.pack(fill="both", expand=True)
        self.edge_canvas = ZoomCanvas(nb, zoom_group=self.zoom_group)
        self.cover_canvas = ZoomCanvas(nb, zoom_group=self.zoom_group)
        nb.add(self.edge_canvas, text="配准边缘对照")
        nb.add(self.cover_canvas, text="覆盖区示意")
        bar = ttk.Frame(right)
        bar.pack(fill="x")
        ttk.Button(bar, text="适应窗口", command=self._fit).pack(side="left", pady=4)
        ttk.Button(bar, text="100%", command=lambda: self._set_zoom(1.0)).pack(side="left")
        self.hint = ttk.Label(
            bar, text="边缘对照：白色=参考帧，彩色=各源边缘；重合说明对得齐，彩色重边=错位")
        self.hint.pack(side="left", padx=12)

    # ------------------------------------------------------------------ #
    def _open_files(self):
        paths = filedialog.askopenfilenames(
            title="选择同一场景的 3~5 张照片",
            filetypes=[("图像", "*.png *.jpg *.jpeg *.tif *.tiff *.bmp"), ("所有文件", "*.*")])
        if not paths:
            return
        try:
            self.state.load_paths(list(paths))
        except Exception as exc:  # noqa: BLE001
            messagebox.showerror("打开失败", str(exc))
            return
        self.refresh_files()
        self.app.set_status(f"已载入 {len(paths)} 张图，顺序即焦点列表顺序")

    def refresh_files(self):
        self.file_list.delete(0, "end")
        import os
        for i, p in enumerate(self.state.source_paths):
            self.file_list.insert("end", f"{i + 1}.  {os.path.basename(p)}")

    def _selected_index(self):
        sel = self.file_list.curselection()
        return sel[0] if sel else None

    def _move(self, delta):
        i = self._selected_index()
        if i is None:
            return
        j = i + delta
        if not 0 <= j < len(self.state.source_paths):
            return
        paths = self.state.source_paths
        imgs = self.state.images
        paths[i], paths[j] = paths[j], paths[i]
        imgs[i], imgs[j] = imgs[j], imgs[i]
        self.refresh_files()
        self.file_list.selection_set(j)

    def _remove(self):
        i = self._selected_index()
        if i is None:
            return
        if len(self.state.source_paths) <= 3:
            messagebox.showwarning("无法移除", "至少保留 3 张图")
            return
        del self.state.source_paths[i]
        del self.state.images[i]
        self.refresh_files()

    def _fit(self):
        for c in self.zoom_group:
            c.fit()

    def _set_zoom(self, z):
        for c in self.zoom_group:
            c.set_zoom(z)

    # ------------------------------------------------------------------ #
    def refresh_after_run(self):
        reg = self.state.result.registration
        self.tree.delete(*self.tree.get_children())
        for it in reg.items:
            self.tree.insert(
                "", "end",
                values=(it.index + 1, STATUS_TEXT[it.status],
                        f"{it.correlation:.3f}", it.message),
                tags=(it.status,))
        result = self.state.result
        self.edge_canvas.set_image(edge_overlay(result.images, reg))
        self.cover_canvas.set_image(coverage_overlay(reg))
        self.after(50, self._fit)
        n_fail = sum(1 for it in reg.items if it.status == STATUS_FAIL)
        n_warn = sum(1 for it in reg.items if it.status == STATUS_WARN)
        if n_fail:
            self.app.set_status(f"配准完成：{n_fail} 张失败（已排除出合成），{n_warn} 张警告")
        elif n_warn:
            self.app.set_status(f"配准完成：{n_warn} 张警告，其余正常")
        else:
            self.app.set_status("配准完成：全部源对齐正常")
