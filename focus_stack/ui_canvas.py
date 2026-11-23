"""Tkinter 辅助：BGR ndarray ↔ PhotoImage、可缩放平移画布。"""
from __future__ import annotations

import tkinter as tk
from tkinter import ttk

import cv2
import numpy as np
from PIL import Image, ImageTk


def bgr_to_photo(image_bgr: np.ndarray) -> ImageTk.PhotoImage:
    if image_bgr.ndim == 2:
        image_bgr = cv2.cvtColor(image_bgr, cv2.COLOR_GRAY2BGR)
    rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    return ImageTk.PhotoImage(Image.fromarray(rgb))


class ZoomCanvas(tk.Canvas):
    """支持滚轮缩放、中键/左键拖动平移、点击回调的图像画布。

    同倍率查看由各页共用 zoom_level 属性实现（通过 zoom_group 同步）。
    """

    MIN_ZOOM = 0.1
    MAX_ZOOM = 8.0

    def __init__(self, master, on_click=None, zoom_group=None, **kw):
        super().__init__(master, highlightthickness=0, **kw)
        self._image_id = None
        self._photo = None
        self._base_image: np.ndarray | None = None
        self.zoom = 1.0
        self._drag_start = None
        self.on_click = on_click
        self.zoom_group: list["ZoomCanvas"] = zoom_group if zoom_group is not None else [self]
        if self not in self.zoom_group:
            self.zoom_group.append(self)

        self.bind("<MouseWheel>", self._on_wheel)          # macOS / Windows
        self.bind("<Button-4>", lambda e: self._zoom_at(e.x, e.y, 1.15))
        self.bind("<Button-5>", lambda e: self._zoom_at(e.x, e.y, 1 / 1.15))
        self.bind("<ButtonPress-2>", self._drag_begin)
        self.bind("<B2-Motion>", self._drag_move)
        self.bind("<ButtonPress-1>", self._left_down)
        self.bind("<B1-Motion>", self._drag_move)
        self.bind("<ButtonRelease-1>", self._left_up)
        self.configure(bg="#1e1e1e")

    # ------------------------------------------------------------------ #
    def set_image(self, image_bgr: np.ndarray | None):
        self._base_image = image_bgr
        self._render()

    def _render(self):
        if not self.winfo_exists():
            return
        self.delete("all")
        self._image_id = None
        if self._base_image is None:
            return
        img = self._base_image
        if abs(self.zoom - 1.0) > 1e-3:
            h, w = img.shape[:2]
            nw, nh = max(1, int(round(w * self.zoom))), max(1, int(round(h * self.zoom)))
            interp = cv2.INTER_NEAREST if self.zoom >= 1 else cv2.INTER_AREA
            img = cv2.resize(img, (nw, nh), interpolation=interp)
        self._photo = bgr_to_photo(img)
        self._image_id = self.create_image(0, 0, anchor="nw", image=self._photo)
        self.configure(scrollregion=self.bbox("all"))

    def fit(self):
        if not self.winfo_exists() or self._base_image is None:
            return
        h, w = self._base_image.shape[:2]
        cw = max(self.winfo_width(), 10)
        ch = max(self.winfo_height(), 10)
        self.set_zoom(min(cw / w, ch / h) * 0.98, x=0, y=0)

    def set_zoom(self, zoom: float, x: int | None = None, y: int | None = None,
                 sync: bool = True):
        if not self.winfo_exists():
            return
        zoom = float(np.clip(zoom, self.MIN_ZOOM, self.MAX_ZOOM))
        if x is None:
            x, y = self.winfo_width() // 2, self.winfo_height() // 2
        old = self.zoom
        self.zoom = zoom
        self._render()
        # 以光标为锚点缩放
        if old > 0:
            scale = zoom / old
            self.xview_scroll(int(x * (1 - scale)), "units")
            self.yview_scroll(int(y * (1 - scale)), "units")
        if sync:
            for other in self.zoom_group:
                if other is not self and other.winfo_exists():
                    other.set_zoom(zoom, x, y, sync=False)

    def _on_wheel(self, event):
        factor = 1.15 if event.delta > 0 else 1 / 1.15
        self._zoom_at(event.x, event.y, factor)

    def _zoom_at(self, x, y, factor):
        self.set_zoom(self.zoom * factor, x, y)

    def _drag_begin(self, event):
        self._drag_start = (event.x, event.y)
        self.configure(cursor="fleur")

    def _drag_move(self, event):
        if self._drag_start is None:
            return
        x0, y0 = self._drag_start
        dx, dy = event.x - x0, event.y - y0
        self._drag_start = (event.x, event.y)
        self.xview_scroll(-dx, "units")
        self.yview_scroll(-dy, "units")

    def _left_down(self, event):
        self._drag_start = (event.x, event.y)
        self._click_origin = (event.x, event.y)

    def _left_up(self, event):
        origin = getattr(self, "_click_origin", None)
        self._drag_start = None
        if origin is None or self.on_click is None:
            return
        moved = abs(event.x - origin[0]) + abs(event.y - origin[1])
        if moved > 4:   # 拖动不触发点击
            return
        cx = self.canvasx(event.x)
        cy = self.canvasy(event.y)
        if self._base_image is not None:
            x = int(cx / self.zoom)
            y = int(cy / self.zoom)
            h, w = self._base_image.shape[:2]
            if 0 <= x < w and 0 <= y < h:
                self.on_click(x, y)

    def image_coords(self, event) -> tuple[int, int]:
        return int(self.canvasx(event.x) / self.zoom), int(self.canvasy(event.y) / self.zoom)


def make_scrollable(parent, widget_cls=ttk.Frame, **kw):
    """带滚动条的容器，返回 (outer, inner)。"""
    outer = ttk.Frame(parent)
    vsb = ttk.Scrollbar(outer, orient="vertical")
    hsb = ttk.Scrollbar(outer, orient="horizontal")
    inner = widget_cls(outer, **kw)
    inner.bind("<Configure>", lambda e: outer.configure())
    vsb.pack(side="right", fill="y")
    hsb.pack(side="bottom", fill="x")
    inner.pack(side="left", fill="both", expand=True)
    return outer, inner
