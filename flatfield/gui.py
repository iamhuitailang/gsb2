"""Tkinter front end for the flat-field correction inspector.

Layout
------
* Left: three file lists (dark / flat / science), a reference-group editor and
  an export panel.  Each science image can be assigned its own reference group.
* Centre: a canvas showing original, dark-subtracted, corrected or gain at the
  same pan/zoom, so a point can be compared across views without hunting.
* Right: point inspector, reference quality panel and uniformity measurement.

Every control that can change a number calls :meth:`App.recompute`, which
resolves the reference group *strictly* (never by guessed index) and shows the
reasons when no group can be used.
"""

from __future__ import annotations

import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from typing import Optional

import numpy as np
from PIL import Image, ImageTk

from . import core
from .core import (
    CorrectionOptions,
    CorrectionResult,
    ExportJob,
    LoadedImage,
    ReferenceError,
    ReferenceLibrary,
    VIEW_NAMES,
    correct_image,
    corner_gradient,
    load_image,
    sample_point,
    uniform_region_stats,
)

def _normalise_for_display(array: np.ndarray, sensor_max: float) -> np.ndarray:
    arr = np.asarray(array, dtype=np.float64)
    if sensor_max <= 0:
        sensor_max = float(np.max(arr)) if arr.size else 1.0
    scaled = np.clip(arr / max(sensor_max, 1e-9), 0.0, 1.0)
    uint = (scaled * 255.0 + 0.5).astype(np.uint8)
    if uint.ndim == 2:
        uint = np.repeat(uint[..., None], 3, axis=2)
    return uint


def _gain_to_rgb(gain: np.ndarray) -> np.ndarray:
    """Blue → white → red ramp centred on gain 1.0 (the neutral point)."""
    g = np.asarray(gain, dtype=np.float64)
    if g.ndim == 3:
        g = g.mean(axis=2)
    v = np.clip(g / 2.0, 0.0, 1.0)
    low = np.clip(v * 2.0, 0.0, 1.0)
    high = np.clip((v - 0.5) * 2.0, 0.0, 1.0)
    rgb = np.empty(g.shape + (3,), dtype=np.uint8)
    rgb[..., 0] = np.where(v < 0.5, 40 + low * 215, 255)
    rgb[..., 1] = np.where(v < 0.5, 80 + low * 175, 255 - high * 200)
    rgb[..., 2] = np.where(v < 0.5, 200 + low * 55, 255 - high * 220)
    return rgb


class FileGroup(ttk.LabelFrame):
    """A list of files of one role (dark/flat/science) plus add/remove."""

    def __init__(self, master, title: str, on_change=None, height: int = 5):
        super().__init__(master, text=title, padding=4)
        self.on_change = on_change
        self.items: list[LoadedImage] = []

        self.listbox = tk.Listbox(self, height=height, selectmode=tk.EXTENDED,
                                  exportselection=False)
        self.listbox.grid(row=0, column=0, columnspan=2, sticky="nsew")
        self.listbox.bind("<<ListboxSelect>>", lambda _e: self._notify())
        self.rowconfigure(0, weight=1)
        self.columnconfigure(0, weight=1)

        ttk.Button(self, text="添加…", command=self.add_files).grid(row=1, column=0, sticky="w")
        ttk.Button(self, text="移除", command=self.remove_selected).grid(row=1, column=1, sticky="e")
        ttk.Button(self, text="清空", command=self.clear).grid(row=2, column=0, sticky="w")

    def add_files(self) -> None:
        paths = filedialog.askopenfilenames(
            title="选择图像",
            filetypes=[
                ("图像", "*.png *.tif *.tiff *.bmp *.jpg *.jpeg *.pgm *.ppm"),
                ("所有文件", "*.*"),
            ],
        )
        if not paths:
            return
        for path in paths:
            try:
                self.items.append(load_image(path))
            except Exception as exc:  # noqa: BLE001 - surfaced to the user
                messagebox.showerror("无法读取", f"{Path(path).name}\n{exc}")
        self._refresh()
        self._notify()

    def remove_selected(self) -> None:
        for index in reversed(self.listbox.curselection()):
            del self.items[index]
        self._refresh()
        self._notify()

    def clear(self) -> None:
        self.items.clear()
        self._refresh()
        self._notify()

    def selected(self) -> list[LoadedImage]:
        return [self.items[i] for i in self.listbox.curselection()]

    def _refresh(self) -> None:
        self.listbox.delete(0, tk.END)
        for image in self.items:
            self.listbox.insert(
                tk.END,
                f"{image.meta.path.name}  ·  {image.meta.size_label}  ·  "
                f"{image.meta.channel_label}  ·  {image.meta.exposure_label}",
            )

    def _notify(self) -> None:
        if self.on_change:
            self.on_change()


class App(ttk.Frame):
    def __init__(self, master: tk.Tk):
        super().__init__(master, padding=6)
        master.title("平场校正检查器")
        master.geometry("1500x920")
        self.pack(fill=tk.BOTH, expand=True)

        self.library = ReferenceLibrary()
        self.current: Optional[CorrectionResult] = None
        self.current_image: Optional[LoadedImage] = None
        self.current_index: int = -1
        self.zoom = 1.0
        self.pan = [0.0, 0.0]
        self._photo: Optional[ImageTk.PhotoImage] = None
        self._last_point: Optional[tuple[int, int]] = None
        self._drag_origin: Optional[tuple[int, int]] = None
        self._shift_drag_start: Optional[tuple[int, int]] = None
        self._rubber_ids: list[int] = []
        self.options = CorrectionOptions()
        self._choice_map: dict[str, object] = {}
        self._group_by_path: dict[str, str] = {}
        self._syncing_selection = False
        self._last_canvas_size: tuple[int, int] = (0, 0)
        self._rgb_cache: Optional[np.ndarray] = None
        self._rgb_cache_key: Optional[tuple] = None
        self._revision = 0

        self._build()
        self._refresh_group_list()
        self._refresh_group_choices()
        self._render_view()
        self._status("就绪。分别导入暗参考、亮参考和实拍图，再建立参考组。"
                     "Shift+拖拽可框选均匀区；滚轮缩放，拖拽平移。")

    # ------------------------------------------------------------------ UI
    def _build(self) -> None:
        left = ttk.Frame(self)
        left.pack(side=tk.LEFT, fill=tk.Y, padx=(0, 8))

        self.dark_files = FileGroup(left, "暗参考帧", self._on_dark_flat_changed)
        self.dark_files.pack(fill=tk.X, pady=2)
        self.flat_files = FileGroup(left, "均匀亮参考帧", self._on_dark_flat_changed)
        self.flat_files.pack(fill=tk.X, pady=2)
        self.science_files = FileGroup(left, "实拍图（选中哪张就检查哪张）",
                                       self._on_science_changed)
        self.science_files.pack(fill=tk.X, pady=2)

        groups = ttk.LabelFrame(left, text="参考组（同一配置）", padding=4)
        groups.pack(fill=tk.X, pady=4)
        self.group_list = tk.Listbox(groups, height=5, exportselection=False)
        self.group_list.grid(row=0, column=0, columnspan=3, sticky="nsew")
        self.group_list.bind("<<ListboxSelect>>", lambda _e: self._on_group_selected())
        groups.columnconfigure(0, weight=1)
        self.group_name_var = tk.StringVar(value="组1")
        ttk.Entry(groups, textvariable=self.group_name_var, width=12).grid(
            row=1, column=0, sticky="we", pady=(3, 0)
        )
        ttk.Button(groups, text="用所选帧建组", command=self._create_group).grid(
            row=1, column=1, columnspan=2, sticky="e", pady=(3, 0)
        )
        ttk.Button(groups, text="删除组", command=self._delete_group).grid(
            row=2, column=0, sticky="w", pady=(3, 0)
        )
        ttk.Button(groups, text="生成样例…", command=self._generate_samples).grid(
            row=2, column=1, columnspan=2, sticky="e", pady=(3, 0)
        )
        ttk.Label(groups, text="建组时未选中帧则使用清单全部帧。", foreground="#666").grid(
            row=3, column=0, columnspan=3, sticky="w"
        )

        ttk.Label(left, text="当前图使用的参考组").pack(anchor="w", pady=(2, 0))
        self.group_choices = ttk.Combobox(left, state="readonly", width=48)
        self.group_choices.pack(fill=tk.X)
        self.group_choices.bind("<<ComboboxSelected>>", lambda _e: self.recompute())
        self.group_status = tk.Text(left, height=6, width=50, wrap="word", relief="flat",
                                    background="#f6f6f6")
        self.group_status.pack(fill=tk.X, pady=(2, 4))

        opts = ttk.LabelFrame(left, text="校正选项", padding=4)
        opts.pack(fill=tk.X, pady=2)
        self.var_dark = tk.BooleanVar(value=True)
        self.var_gain = tk.BooleanVar(value=True)
        self.var_guard = tk.BooleanVar(value=True)
        ttk.Checkbutton(opts, text="扣除暗参考", variable=self.var_dark,
                        command=self._options_changed).pack(anchor="w")
        ttk.Checkbutton(opts, text="按位置校正亮度", variable=self.var_gain,
                        command=self._options_changed).pack(anchor="w")
        ttk.Checkbutton(opts, text="超量程时保护（不整片截白）", variable=self.var_guard,
                        command=self._options_changed).pack(anchor="w")

        export = ttk.LabelFrame(left, text="批量导出", padding=4)
        export.pack(fill=tk.X, pady=4)
        ttk.Button(export, text="导出全部实拍图…", command=self._export_batch).pack(fill=tk.X)
        ttk.Button(export, text="运行合成自检", command=self._run_synthetic_check).pack(
            fill=tk.X, pady=(3, 0)
        )

        centre = ttk.Frame(self)
        centre.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        controls = ttk.Frame(centre)
        controls.pack(fill=tk.X)
        ttk.Label(controls, text="同位置查看:").pack(side=tk.LEFT)
        self.view_var = tk.StringVar(value="校正后")
        for name in VIEW_NAMES:
            ttk.Radiobutton(controls, text=name, value=name, variable=self.view_var,
                            command=self._render_view).pack(side=tk.LEFT, padx=2)
        ttk.Button(controls, text="适应窗口", command=self._fit_view).pack(side=tk.RIGHT)
        ttk.Button(controls, text="100%", command=self._reset_zoom).pack(side=tk.RIGHT, padx=4)

        self.canvas = tk.Canvas(centre, background="#202020", highlightthickness=0)
        self.canvas.pack(fill=tk.BOTH, expand=True, pady=(4, 0))
        self.canvas.bind("<ButtonPress-1>", self._on_press)
        self.canvas.bind("<B1-Motion>", self._on_drag)
        self.canvas.bind("<Motion>", self._on_hover)
        self.canvas.bind("<ButtonRelease-1>", self._on_release)
        self.canvas.bind("<MouseWheel>", self._on_wheel)
        self.canvas.bind("<Button-4>", lambda e: self._zoom_at(e.x, e.y, 1.15))
        self.canvas.bind("<Button-5>", lambda e: self._zoom_at(e.x, e.y, 1 / 1.15))
        self.canvas.bind("<Configure>", self._on_canvas_configure)

        right = ttk.Frame(self)
        right.pack(side=tk.RIGHT, fill=tk.Y, padx=(8, 0))

        point = ttk.LabelFrame(right, text="选点检查（原始 / 参考 / 结果）", padding=4)
        point.pack(fill=tk.X)
        self.point_text = tk.Text(point, height=11, width=50, wrap="word",
                                  relief="flat", background="#f6f6f6")
        self.point_text.pack(fill=tk.X)

        quality = ttk.LabelFrame(right, text="亮参考质量", padding=4)
        quality.pack(fill=tk.X, pady=4)
        self.quality_text = tk.Text(quality, height=10, width=50, wrap="word",
                                    relief="flat", background="#f6f6f6")
        self.quality_text.pack(fill=tk.X)
        self.show_masks = tk.BooleanVar(value=True)
        ttk.Checkbutton(quality, text="图标出参考坏点(青)/热点(洋红)/过曝(橙)",
                        variable=self.show_masks,
                        command=self._render_view).pack(anchor="w")

        uniform = ttk.LabelFrame(right, text="均匀区测量（校正前后还差多少）", padding=4)
        uniform.pack(fill=tk.X, pady=4)
        row = ttk.Frame(uniform)
        row.pack(fill=tk.X)
        self.rect_vars = {k: tk.StringVar() for k in ("x0", "y0", "x1", "y1")}
        defaults = {"x0": "20", "y0": "200", "x1": "150", "y1": "300"}
        for key in ("x0", "y0", "x1", "y1"):
            ttk.Label(row, text=key.upper()).pack(side=tk.LEFT)
            ttk.Entry(row, textvariable=self.rect_vars[key], width=5).pack(side=tk.LEFT, padx=2)
            self.rect_vars[key].set(defaults[key])
        ttk.Button(uniform, text="测量矩形（或用 Shift+拖拽）",
                   command=self._measure_rect).pack(fill=tk.X, pady=(4, 0))
        self.uniform_text = tk.Text(uniform, height=10, width=50, wrap="word",
                                    relief="flat", background="#f6f6f6")
        self.uniform_text.pack(fill=tk.X, pady=(4, 0))

        self.status = tk.StringVar(value="")
        ttk.Label(self, textvariable=self.status, anchor="w", foreground="#333").pack(
            side=tk.BOTTOM, fill=tk.X, pady=(4, 0)
        )

    # --------------------------------------------------------------- state
    def _status(self, text: str) -> None:
        self.status.set(text)

    def _options_changed(self) -> None:
        self.options = CorrectionOptions(
            subtract_dark=self.var_dark.get(),
            apply_gain=self.var_gain.get(),
            guard_overflow=self.var_guard.get(),
        )
        self.recompute()

    def _on_dark_flat_changed(self) -> None:
        self._refresh_group_choices()
        if not self.library.groups:
            self.group_name_var.set(f"组{len(self.library.groups) + 1}")
        self._render_view()

    def _on_science_changed(self) -> None:
        if self._syncing_selection:
            return
        selection = self.science_files.listbox.curselection()
        index = selection[0] if selection else (
            self.current_index if 0 <= self.current_index < len(self.science_files.items) else 0
        )
        self._select_science(index)

    def _select_science(self, index: int) -> None:
        items = self.science_files.items
        if not items:
            self.current_image = None
            self.current_index = -1
            self.current = None
            self._refresh_group_choices()
            self._render_view()
            self._update_point_panel(None)
            self._update_quality_panel(None)
            return
        index = max(0, min(len(items) - 1, index))
        self.current_index = index
        self.current_image = items[index]
        if self.science_files.listbox.curselection() != (index,):
            self._syncing_selection = True
            try:
                self.science_files.listbox.selection_clear(0, tk.END)
                self.science_files.listbox.selection_set(index)
            finally:
                self._syncing_selection = False
        self._refresh_group_choices()
        self.recompute()
        self._fit_view()

    def _refresh_group_list(self) -> None:
        self.group_list.delete(0, tk.END)
        for group in self.library.groups.values():
            self.group_list.insert(tk.END, group.summary())

    def _refresh_group_choices(self) -> None:
        meta = self.current_image.meta if self.current_image is not None else None
        labels: list[str] = []
        self._choice_map = {}
        if meta is not None:
            for row in self.library.availability(meta):
                labels.append(row.label)
                self._choice_map[row.label] = row
        self.group_choices["values"] = labels
        desired = None
        if self.current_image is not None:
            desired_group = self._group_by_path.get(str(self.current_image.meta.path))
            if desired_group:
                for label, row in self._choice_map.items():
                    if row.group.name == desired_group:
                        desired = label
                        break
        if desired is None:
            usable = [label for label, row in self._choice_map.items() if row.usable]
            desired = usable[0] if usable else (labels[0] if labels else "")
        self.group_choices.set(desired)

    def _on_group_selected(self) -> None:
        sel = self.group_list.curselection()
        if sel:
            name = list(self.library.groups.keys())[sel[0]]
            self.group_name_var.set(name)

    def _selected_group(self):
        label = self.group_choices.get()
        if not label or label not in self._choice_map:
            return None, ["未选择参考组"]
        row = self._choice_map[label]
        if not row.usable:
            return None, row.reasons + row.notes
        return row.group, []

    # --------------------------------------------------------- group editing
    def _create_group(self) -> None:
        name = self.group_name_var.get().strip()
        darks = list(self.dark_files.selected()) or list(self.dark_files.items)
        flats = list(self.flat_files.selected()) or list(self.flat_files.items)
        if not darks and not flats:
            messagebox.showwarning("无法建组", "请先添加至少一帧暗参考或亮参考。")
            return
        try:
            self.library.create_group(name, darks, flats)
        except ReferenceError as exc:
            details = "\n".join(exc.reasons)
            messagebox.showerror("参考组配置不一致", f"{exc}\n\n{details}")
            return
        self.group_name_var.set(f"组{len(self.library.groups) + 1}")
        self._refresh_group_list()
        self._refresh_group_choices()
        self._status(f"已建立参考组「{name}」。")
        self.recompute()

    def _delete_group(self) -> None:
        sel = self.group_list.curselection()
        if not sel:
            return
        name = list(self.library.groups.keys())[sel[0]]
        self.library.remove_group(name)
        self._group_by_path = {
            path: group for path, group in self._group_by_path.items() if group != name
        }
        self._refresh_group_list()
        self._refresh_group_choices()
        self.recompute()

    # ------------------------------------------------------------ correction
    def recompute(self) -> None:
        self.options = CorrectionOptions(
            subtract_dark=self.var_dark.get(),
            apply_gain=self.var_gain.get(),
            guard_overflow=self.var_guard.get(),
        )
        meta = self.current_image.meta if self.current_image is not None else None
        self._revision += 1
        if meta is None or self.current_image is None:
            self.current = None
            self._set_group_status("尚未载入实拍图。")
            self._update_point_panel(None)
            self._update_quality_panel(None)
            self._render_view()
            return

        group, reasons = self._selected_group()
        if group is None:
            self.current = None
            self._set_group_status("未应用参考组:\n" + "\n".join(reasons))
            self._update_point_panel(None)
            self._update_quality_panel(None)
            self._render_view()
            self._status("没有可用的参考组；图像按原样显示。")
            return

        try:
            result = correct_image(
                self.current_image.array,
                group,
                self.options,
                sensor_max=meta.sensor_max or None,
                bit_depth=meta.bit_depth,
            )
        except Exception as exc:  # noqa: BLE001 - keep the UI alive
            self.current = None
            self._set_group_status(f"校正失败:\n{exc}")
            self._update_point_panel(None)
            self._update_quality_panel(None)
            self._render_view()
            self._status(f"校正失败: {exc}")
            return

        self.current = result
        self._group_by_path[str(meta.path)] = group.name
        lines = [f"使用参考组: {group.summary()}"]
        lines.extend(result.steps)
        lines.extend("⚠ " + w for w in result.warnings)
        self._set_group_status("\n".join(lines))
        self._update_quality_panel(result)
        self._update_point_panel(self._last_point)
        self._render_view()
        self._status(
            f"{meta.path.name}: 高光占比 {result.clipped_before:.2%} → "
            f"{result.clipped_after:.2%} · 参考组「{result.group_name}」"
        )

    def _set_group_status(self, text: str) -> None:
        self.group_status.delete("1.0", tk.END)
        self.group_status.insert("1.0", text)

    # -------------------------------------------------------------- display
    def _display_array(self) -> Optional[np.ndarray]:
        view = self.view_var.get()
        if self.current_image is None:
            return None
        if view == "原图":
            return self.current_image.array
        # Dark-subtracted / corrected / gain views only exist once a group was
        # applied; showing the raw frame under a "gain" label would be a lie.
        if self.current is None:
            return None
        return self.current.view(view)

    def _display_rgb(self, view: str) -> Optional[np.ndarray]:
        # Pan/zoom re-renders call this on every motion event.  Normalising a
        # multi-megapixel frame each time is needlessly expensive, so the
        # converted RGB buffer is cached until the view or the correction
        # changes (``_revision`` is bumped by recompute()).
        cache_key = (view, self._revision)
        if self._rgb_cache_key == cache_key:
            return self._rgb_cache
        array = self._display_array()
        if array is None:
            self._rgb_cache_key = None
            self._rgb_cache = None
            return None
        if view == "增益图":
            rgb = _gain_to_rgb(array)
        else:
            sensor = self.current.sensor_max if self.current is not None else (
                self.current_image.meta.sensor_max or 255.0
            )
            rgb = _normalise_for_display(array, sensor)
        self._rgb_cache_key = cache_key
        self._rgb_cache = rgb
        return rgb

    def _render_view(self) -> None:
        self.canvas.delete("all")
        self._rubber_ids = []
        if self.current_image is None:
            self.canvas.create_text(12, 12, anchor="nw", fill="#bbb",
                                    text="尚未载入实拍图")
            return
        view = self.view_var.get()
        rgb = self._display_rgb(view)
        if rgb is None:
            if self.current is None and view != "原图":
                self.canvas.create_text(
                    12, 12, anchor="nw", fill="#bbb",
                    text=f"「{view}」视图需要先应用一个可用的参考组。",
                )
            return
        cw = max(1, self.canvas.winfo_width())
        ch = max(1, self.canvas.winfo_height())
        h, w = rgb.shape[:2]
        zoom = max(self.zoom, 1e-6)

        # Visible source rectangle, expanded by one pixel so resampling has
        # neighbours to work with at the edges.
        sx0 = max(0, int((-self.pan[0]) / zoom) - 1)
        sy0 = max(0, int((-self.pan[1]) / zoom) - 1)
        sx1 = min(w, int((cw - self.pan[0]) / zoom) + 2)
        sy1 = min(h, int((ch - self.pan[1]) / zoom) + 2)
        if sx1 <= sx0 or sy1 <= sy0:
            self.canvas.create_text(
                12, 12, anchor="nw", fill="#bbb",
                text="图像已移出视图，点击「适应窗口」恢复。",
            )
            return

        crop = rgb[sy0:sy1, sx0:sx1]
        target_w = max(1, int(round((sx1 - sx0) * zoom)))
        target_h = max(1, int(round((sy1 - sy0) * zoom)))
        # Cap the resample size: canvases are never larger than a few thousand px.
        target_w = min(target_w, 8000)
        target_h = min(target_h, 8000)
        pil_img = Image.fromarray(crop, mode="RGB").resize(
            (target_w, target_h), Image.NEAREST if zoom >= 3 else Image.BILINEAR
        )
        self._photo = ImageTk.PhotoImage(pil_img)
        self.canvas.create_image(
            self.pan[0] + sx0 * zoom, self.pan[1] + sy0 * zoom,
            anchor="nw", image=self._photo,
        )
        if self.show_masks.get() and self.current is not None and view != "增益图":
            self._draw_masks()
        self._draw_point_marker()

    def _canvas_to_pixel(self, cx: int, cy: int) -> tuple[int, int]:
        x = int((cx - self.pan[0]) / max(self.zoom, 1e-9))
        y = int((cy - self.pan[1]) / max(self.zoom, 1e-9))
        return x, y

    def _pixel_to_canvas(self, x: float, y: float) -> tuple[float, float]:
        return self.pan[0] + x * self.zoom, self.pan[1] + y * self.zoom

    def _fit_view(self) -> None:
        if self.current_image is None:
            return
        cw = max(1, self.canvas.winfo_width())
        ch = max(1, self.canvas.winfo_height())
        h, w = self.current_image.shape
        self.zoom = min(cw / w, ch / h) * 0.98
        self.pan = [(cw - w * self.zoom) / 2, (ch - h * self.zoom) / 2]
        self._render_view()

    def _reset_zoom(self) -> None:
        if self.current_image is None:
            return
        cw = max(1, self.canvas.winfo_width())
        ch = max(1, self.canvas.winfo_height())
        h, w = self.current_image.shape
        self.zoom = 1.0
        self.pan = [max(0, (cw - w) / 2), max(0, (ch - h) / 2)]
        self._render_view()

    def _zoom_at(self, cx: float, cy: float, factor: float) -> None:
        if self.current_image is None:
            return
        px, py = self._canvas_to_pixel(cx, cy)
        self.zoom = max(0.05, min(32.0, self.zoom * factor))
        self.pan[0] = cx - px * self.zoom
        self.pan[1] = cy - py * self.zoom
        self._render_view()

    def _draw_masks(self) -> None:
        assert self.current is not None
        diag = self.current.diagnostics
        if diag is None:
            return
        masks = {
            "dead": diag.dead_mask,
            "hot": diag.hot_mask,
            "sat": diag.saturated_mask,
        }
        colors = {"dead": "#00d0ff", "hot": "#ff55ff", "sat": "#ffaa00"}
        r = max(1.5, min(4.0, 2.0 * self.zoom))
        for key, mask in masks.items():
            if mask.ndim == 3:
                mask = mask.any(axis=2)
            ys, xs = np.nonzero(mask)
            if ys.size > 4000:
                step = int(np.ceil(ys.size / 4000))
                ys, xs = ys[::step], xs[::step]
            for y, x in zip(ys, xs):
                cx, cy = self._pixel_to_canvas(x + 0.5, y + 0.5)
                self.canvas.create_oval(cx - r, cy - r, cx + r, cy + r,
                                        outline=colors[key])

    def _draw_point_marker(self) -> None:
        if self._last_point is None:
            return
        x, y = self._last_point
        cx, cy = self._pixel_to_canvas(x + 0.5, y + 0.5)
        self.canvas.create_line(cx - 9, cy, cx + 9, cy, fill="#00ff88", width=1)
        self.canvas.create_line(cx, cy - 9, cx, cy + 9, fill="#00ff88", width=1)

    # --------------------------------------------------------------- events
    def _on_canvas_configure(self, event) -> None:
        """Fit only when the canvas first gets a usable size.

        Re-fitting on every resize would undo the user's zoom and pan.  A
        window resize after that keeps the centre point stable instead.
        """
        new_size = (event.width, event.height)
        if new_size == self._last_canvas_size:
            return
        first = self._last_canvas_size == (0, 0)
        old_w, old_h = self._last_canvas_size
        self._last_canvas_size = new_size
        if first:
            self._fit_view()
            return
        if self.current_image is None or old_w <= 0 or old_h <= 0:
            self._render_view()
            return
        self.pan[0] += (event.width - old_w) / 2
        self.pan[1] += (event.height - old_h) / 2
        self._render_view()

    def _on_press(self, event) -> None:
        self._drag_origin = (event.x, event.y)
        if event.state & 0x0001:  # Shift
            self._shift_drag_start = (event.x, event.y)

    def _on_drag(self, event) -> None:
        if self._drag_origin is None:
            return
        if self._shift_drag_start is not None:
            for item in self._rubber_ids:
                self.canvas.delete(item)
            x0, y0 = self._shift_drag_start
            self._rubber_ids = [
                self.canvas.create_rectangle(x0, y0, event.x, event.y,
                                             outline="#ffd000", width=1)
            ]
            return
        dx = event.x - self._drag_origin[0]
        dy = event.y - self._drag_origin[1]
        self.pan[0] += dx
        self.pan[1] += dy
        self._drag_origin = (event.x, event.y)
        self._render_view()

    def _on_release(self, event) -> None:
        if self._shift_drag_start is not None and self.current_image is not None:
            x0, y0 = self._shift_drag_start
            x0p, y0p = self._canvas_to_pixel(min(x0, event.x), min(y0, event.y))
            x1p, y1p = self._canvas_to_pixel(max(x0, event.x), max(y0, event.y))
            h, w = self.current_image.shape
            self.rect_vars["x0"].set(str(max(0, min(w - 1, x0p))))
            self.rect_vars["y0"].set(str(max(0, min(h - 1, y0p))))
            self.rect_vars["x1"].set(str(max(0, min(w - 1, x1p))))
            self.rect_vars["y1"].set(str(max(0, min(h - 1, y1p))))
            self._shift_drag_start = None
            for item in self._rubber_ids:
                self.canvas.delete(item)
            self._rubber_ids = []
            self._measure_rect()
        self._drag_origin = None

    def _on_hover(self, event) -> None:
        if self.current_image is None:
            return
        x, y = self._canvas_to_pixel(event.x, event.y)
        h, w = self.current_image.shape
        if 0 <= x < w and 0 <= y < h:
            self._last_point = (x, y)
            self._update_point_panel(self._last_point)

    def _on_wheel(self, event) -> None:
        self._zoom_at(event.x, event.y, 1.15 if event.delta > 0 else 1 / 1.15)

    # --------------------------------------------------------------- panels
    def _update_point_panel(self, point: Optional[tuple[int, int]]) -> None:
        self.point_text.delete("1.0", tk.END)
        if point is None or self.current is None:
            self.point_text.insert(
                "1.0",
                "在图上移动鼠标即可查看该点：原始值、所用参考值、增益和结果，\n"
                "在任意视图下都有效。",
            )
            return
        names = (
            self.current_image.meta.channel_names
            if self.current_image is not None
            else None
        )
        sample = sample_point(self.current, point[0], point[1], channel_names=names)
        self.point_text.insert("1.0", "\n".join(sample.lines()))

    def _update_quality_panel(self, result: Optional[CorrectionResult]) -> None:
        self.quality_text.delete("1.0", tk.END)
        if result is None or result.diagnostics is None:
            self.quality_text.insert(
                "1.0",
                "尚无可用的亮参考。\n亮参考的极暗点、坏点和过曝点会在应用后列出。",
            )
            return
        lines = result.diagnostics.summary_lines()
        lines.append(f"参考组: {result.group_name}")
        lines.append(f"高光占比: {result.clipped_before:.2%} → {result.clipped_after:.2%}")
        if result.guard_mask.any():
            lines.append(
                f"超量程保护: {float(np.mean(result.guard_mask)):.2%} 像素保留扣暗值"
            )
        lines.extend("⚠ " + w for w in result.warnings)
        self.quality_text.insert("1.0", "\n".join(lines))

    # ---------------------------------------------------------- measurements
    def _rect_from_vars(self) -> Optional[tuple[int, int, int, int]]:
        try:
            return tuple(int(self.rect_vars[k].get())
                         for k in ("x0", "y0", "x1", "y1"))  # type: ignore[return-value]
        except ValueError:
            messagebox.showwarning("矩形无效", "矩形坐标需要是整数。")
            return None

    def _measure_rect(self) -> None:
        rect = self._rect_from_vars()
        if rect is None or self.current_image is None:
            return
        before = self.current_image.array
        after = self.current.corrected if self.current is not None else before
        stats = uniform_region_stats(before, after, rect)
        corners = corner_gradient(before, after)
        self.uniform_text.delete("1.0", tk.END)
        lines = [
            f"区域 (x0={stats['rect'][0]}, y0={stats['rect'][1]}, "
            f"x1={stats['rect'][2]}, y1={stats['rect'][3]})，{stats['channels']} 通道平均",
            f"校正前: 均值 {stats['before_mean']:.2f}  "
            f"标准差 {stats['before_std']:.3f}  极差 {stats['before_span']:.2f}",
            f"校正后: 均值 {stats['after_mean']:.2f}  "
            f"标准差 {stats['after_std']:.3f}  极差 {stats['after_span']:.2f}",
            f"标准差下降 {stats['std_reduction']:.1%}  "
            f"极差下降 {stats['span_reduction']:.1%}",
            f"角落差 (左上-右下): {corners['before_delta']:.2f} → "
            f"{corners['after_delta']:.2f}",
            f"均值变化 {stats['mean_change']:+.2f}",
        ]
        for index, channel in enumerate(stats["per_channel"]):
            lines.append(
                f"  通道{index}: σ {channel['before_std']:.3f} → {channel['after_std']:.3f}"
            )
        self.uniform_text.insert("1.0", "\n".join(lines))
        self._status(
            f"均匀区标准差下降 {stats['std_reduction']:.1%}，"
            f"极差下降 {stats['span_reduction']:.1%}。"
        )

    # --------------------------------------------------------------- export
    def _export_batch(self) -> None:
        if not self.science_files.items:
            messagebox.showwarning("没有可导出的图", "请先添加实拍图。")
            return
        if not self.library.groups:
            messagebox.showwarning("没有参考组", "请先建立参考组。")
            return
        out_dir = filedialog.askdirectory(title="选择导出目录")
        if not out_dir:
            return
        jobs = []
        for image in self.science_files.items:
            jobs.append(
                ExportJob(
                    image=image,
                    group_name=self._group_by_path.get(str(image.meta.path)),
                )
            )
        manifest = core.export_batch(jobs, self.library, out_dir, self.options)
        self._show_manifest(manifest, out_dir)

    def _show_manifest(self, manifest, out_dir: str) -> None:
        good = len(manifest.records)
        verified = sum(1 for r in manifest.records if r.verified)
        lines = [
            f"已导出 {good} 张，读回核对通过 {verified}/{good}",
            f"目录: {out_dir}",
            f"清单: {Path(out_dir) / 'flatfield_manifest.json'}",
        ]
        if manifest.errors:
            lines.append("")
            lines.append("跳过的图像（配置不匹配，未套用参考组）:")
            lines.extend("  " + e for e in manifest.errors)
        for record in manifest.records:
            lines.append("")
            lines.append(Path(record.output_path).name)
            lines.append(f"  参考组: {record.group_name}")
            lines.append(
                f"  角落差: {record.corner_before_delta:.2f} → "
                f"{record.corner_after_delta:.2f}"
            )
            lines.append(
                f"  读回误差: 最大 {record.readback_max_abs_error:.6f} / "
                f"平均 {record.readback_mean_abs_error:.6f} "
                f"({'通过' if record.verified else '未通过'})"
            )
            lines.append(
                f"  存储范围: [{record.store_low:.2f}, {record.store_high:.2f}]  "
                f"（含负值偏移，清单可逆算）"
            )
        window = tk.Toplevel(self)
        window.title("导出结果")
        box = tk.Text(window, width=96, height=30, wrap="word")
        box.pack(fill=tk.BOTH, expand=True)
        box.insert("1.0", "\n".join(lines))
        self._status(f"已导出 {good} 张到 {out_dir}")

    # ------------------------------------------------------------- synthetic
    def _generate_samples(self) -> None:
        out_dir = filedialog.askdirectory(title="选择样例输出目录")
        if not out_dir:
            return
        try:
            sample = core.write_synthetic_samples(out_dir)
        except Exception as exc:  # noqa: BLE001
            messagebox.showerror("生成失败", str(exc))
            return
        self.dark_files.items.clear()
        self.flat_files.items.clear()
        self.science_files.items.clear()
        for image in [sample.science, *sample.darks, *sample.flats]:
            loaded = load_image(image.meta.path)
            name = loaded.meta.path.name
            if name.startswith("dark"):
                self.dark_files.items.append(loaded)
            elif name.startswith("flat"):
                self.flat_files.items.append(loaded)
            else:
                self.science_files.items.append(loaded)
        for group in (self.dark_files, self.flat_files, self.science_files):
            group._refresh()
        # Repeated "生成样例" runs must not fail just because the group name is
        # taken; replace the old synthetic group instead.
        if "合成参考" in self.library.groups:
            self.library.remove_group("合成参考")
        try:
            self.library.create_group(
                "合成参考", list(self.dark_files.items), list(self.flat_files.items)
            )
        except ReferenceError as exc:
            messagebox.showerror("建组失败", str(exc))
        self._refresh_group_list()
        self._select_science(0)
        self.rect_vars["x0"].set(str(sample.uniform_rect[0]))
        self.rect_vars["y0"].set(str(sample.uniform_rect[1]))
        self.rect_vars["x1"].set(str(sample.uniform_rect[2]))
        self.rect_vars["y1"].set(str(sample.uniform_rect[3]))
        self._measure_rect()
        self._status(f"已生成样例到 {out_dir}，并建立「合成参考」组。")

    def _run_synthetic_check(self) -> None:
        report = core.synthetic_validation()
        lines = [f"{key}: {value}" for key, value in report.items()]
        window = tk.Toplevel(self)
        window.title("合成自检（能量出校正前后差异）")
        box = tk.Text(window, width=88, height=26, wrap="word")
        box.pack(fill=tk.BOTH, expand=True)
        box.insert("1.0", "\n".join(lines))
        self._status(
            f"合成自检: 均匀区标准差下降 {report['uniform_std_reduction']:.1%}，"
            f"角落差下降 {report['corner_delta_reduction']:.2f}"
        )


def main() -> None:
    root = tk.Tk()
    style = ttk.Style()
    if "aqua" in style.theme_names():
        style.theme_use("aqua")
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
