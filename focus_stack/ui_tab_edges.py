"""页 4：合成边缘检查（需求 4）。

同一倍率下并排查看：
- 各张原图（配准后对齐帧）
- 硬边界结果（标签切换处白线）
- 柔和交界结果（soft 合成 + 半透明标签底）
覆盖不够共同覆盖时：裁掉共同区 / 保留全帧并标明无效区。
"""
from __future__ import annotations

import tkinter as tk
from tkinter import ttk

import cv2
import numpy as np

from .fusion import edge_regions
from .ui_canvas import ZoomCanvas


class EdgeTab(ttk.Frame):
    def __init__(self, master, state, app):
        super().__init__(master)
        self.state = state
        self.app = app
        self.zoom_group: list[ZoomCanvas] = []
        self._build()

    def _build(self):
        bar = ttk.Frame(self)
        bar.pack(fill="x", padx=8, pady=6)
        ttk.Label(bar, text="覆盖区处理：").pack(side="left")
        self.cover_var = tk.StringVar(value="keep")
        ttk.Radiobutton(bar, text="保留并标明无效区", value="keep",
                        variable=self.cover_var,
                        command=self._change_coverage).pack(side="left")
        ttk.Radiobutton(bar, text="裁到共同覆盖区", value="crop",
                        variable=self.cover_var,
                        command=self._change_coverage).pack(side="left")
        ttk.Button(bar, text="重新融合", command=self.app.refresh_refusion).pack(side="left", padx=10)
        ttk.Button(bar, text="全部适应窗口", command=self._fit).pack(side="right")
        ttk.Button(bar, text="100% 同倍率", command=lambda: self._set_zoom(1.0)).pack(side="right")
        ttk.Label(bar, text="　所有视图共享缩放/倍率").pack(side="right")

        self.nb = ttk.Notebook(self)
        self.nb.pack(fill="both", expand=True, padx=8, pady=(0, 8))
        self.canvases: list[ZoomCanvas] = []

    def _ensure_tabs(self, n):
        for c in self.canvases:
            if c in self.zoom_group:
                self.zoom_group.remove(c)
            c.destroy()
        self.canvases.clear()
        for i in range(n):
            c = ZoomCanvas(self.nb, zoom_group=self.zoom_group)
            self.canvases.append(c)
            self.nb.add(c, text=f"对齐源 {i + 1}")
        self.hard_canvas = ZoomCanvas(self.nb, zoom_group=self.zoom_group)
        self.soft_canvas = ZoomCanvas(self.nb, zoom_group=self.zoom_group)
        self.nb.add(self.hard_canvas, text="硬边界结果")
        self.nb.add(self.soft_canvas, text="柔和交界结果")
        self.canvases.extend([self.hard_canvas, self.soft_canvas])

    def _change_coverage(self):
        self.state.settings.coverage_mode = self.cover_var.get()
        if self.state.result:
            self.app.refresh_refusion()

    def _fit(self):
        for c in self.zoom_group:
            c.fit()

    def _set_zoom(self, z):
        for c in self.zoom_group:
            c.set_zoom(z)

    def refresh_after_run(self):
        r = self.state.result
        self.cover_var.set(self.state.settings.coverage_mode)
        n = len(r.aligned)
        self._ensure_tabs(n)
        self._show()
        self.after(50, self._fit)

    def _show(self):
        r = self.state.result
        bbox = r.fusion.bbox
        for i, img in enumerate(r.aligned):
            view = img
            if bbox is not None:
                x0, y0, x1, y1 = bbox
                view = view[y0:y1, x0:x1]
            if self.cover_var.get() == "keep":
                view = self._mark_invalid(view, r, bbox, i)
            self.canvases[i].set_image(view)

        labels = r.fusion.labels
        valid = r.fusion.valid_mask
        hard = edge_regions(labels, valid)
        # 硬边界叠在合成图上更直观
        hard_view = cv2.addWeighted(r.fusion.composite, 0.55, hard, 0.9, 0)
        if self.cover_var.get() == "keep":
            hard_view[valid == 0] = (50, 50, 50)
        self.hard_canvas.set_image(hard_view)

        soft = r.fusion.composite.copy()
        overlay = cv2.addWeighted(soft, 0.72, r.fusion.source_map, 0.45, 0)
        if self.cover_var.get() == "keep":
            overlay[valid == 0] = (50, 50, 50)
        self.soft_canvas.set_image(overlay)

    def _mark_invalid(self, view, result, bbox, src_index):
        """保留模式下把该源无效区用灰色斜纹标明。"""
        out = view.copy()
        if bbox is not None:
            return out  # 裁剪模式没有无效区
        cov = result.registration.items[src_index].coverage
        invalid = cov == 0
        if not invalid.any():
            return out
        hatch = np.zeros_like(out)
        cv2.rectangle(hatch, (0, 0), (out.shape[1], out.shape[0]), (70, 70, 70), -1)
        for x in range(-out.shape[0], out.shape[1], 14):
            cv2.line(hatch, (x, 0), (x + out.shape[0], out.shape[0]),
                     (110, 110, 110), 1)
        out[invalid] = cv2.addWeighted(out, 0.35, hatch, 0.65, 0)[invalid]
        return out
