"""Tkinter 图形界面。

布局：
- 顶部工具栏：打开目录 / 工程保存加载 / 一致性检查 / 导出
- 中部：左侧画面查看区，右侧参数面板
- 底部：亮度曲线图（可拖选稳定范围），缩略图时间轴
"""

from __future__ import annotations

import shutil
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageTk

from . import analysis, sequence, stabilize
from .project import Project, load_project, save_project

THUMB_W, THUMB_H = 96, 54
THUMB_PAD = 4
CHART_H = 150
CHART_MARGIN = dict(left=46, right=12, top=12, bottom=20)

VIEW_CURRENT = "当前帧"
VIEW_ADJACENT = "相邻对比"
VIEW_BEFORE_AFTER = "前后对比"
VIEW_DIFF = "差异图"


class FlickerFixerApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Flicker Fixer - 图片序列亮度稳定工具")
        self.geometry("1200x860")

        # 数据状态
        self.paths: list[Path] = []
        self.images: list[Image.Image] = []
        self.result: analysis.AnalysisResult | None = None
        self.gains: list[float] | None = None  # 计算后存在，预览/差异/导出共用
        self.current = 0
        self.selection: list[int | None] = [None, None]
        self.input_dir = ""

        # 界面资源
        self._thumb_photos: list[ImageTk.PhotoImage] = []
        self._view_photo: ImageTk.PhotoImage | None = None
        self._drag_start_x: int | None = None

        # 参数变量
        self.var_strength = tk.DoubleVar(value=0.8)
        self.var_window = tk.IntVar(value=9)
        self.var_spike = tk.DoubleVar(value=6.0)
        self.var_cut = tk.DoubleVar(value=25.0)
        self.var_view = tk.StringVar(value=VIEW_CURRENT)
        self.var_status = tk.StringVar(value="请打开图片序列目录")

        self._build_toolbar()
        self._build_main()
        self._build_chart()
        self._build_timeline()
        self._build_statusbar()

        self.bind("<Left>", lambda e: self.seek(self.current - 1))
        self.bind("<Right>", lambda e: self.seek(self.current + 1))

    # ------------------------------------------------------------------ UI 搭建

    def _build_toolbar(self) -> None:
        bar = ttk.Frame(self)
        bar.pack(side=tk.TOP, fill=tk.X, padx=6, pady=4)
        ttk.Button(bar, text="打开序列目录", command=self.open_directory).pack(side=tk.LEFT, padx=2)
        ttk.Button(bar, text="一致性检查", command=self.show_consistency).pack(side=tk.LEFT, padx=2)
        ttk.Separator(bar, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=6)
        ttk.Button(bar, text="保存工程", command=self.save_project_dialog).pack(side=tk.LEFT, padx=2)
        ttk.Button(bar, text="打开工程", command=self.load_project_dialog).pack(side=tk.LEFT, padx=2)
        ttk.Separator(bar, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=6)
        ttk.Button(bar, text="导出序列", command=self.export_sequence).pack(side=tk.LEFT, padx=2)

    def _build_main(self) -> None:
        main = ttk.Frame(self)
        main.pack(side=tk.TOP, fill=tk.BOTH, expand=True, padx=6)

        self.view_canvas = tk.Canvas(main, bg="#202020", highlightthickness=0)
        self.view_canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self.view_canvas.bind("<Configure>", lambda e: self.refresh_view())

        panel = ttk.Frame(main, width=240)
        panel.pack(side=tk.RIGHT, fill=tk.Y, padx=(8, 0))
        panel.pack_propagate(False)

        ttk.Label(panel, text="视图模式").pack(anchor=tk.W)
        for mode in (VIEW_CURRENT, VIEW_ADJACENT, VIEW_BEFORE_AFTER, VIEW_DIFF):
            ttk.Radiobutton(panel, text=mode, value=mode, variable=self.var_view,
                            command=self.refresh_view).pack(anchor=tk.W)

        ttk.Separator(panel).pack(fill=tk.X, pady=8)
        ttk.Label(panel, text="稳定强度").pack(anchor=tk.W)
        strength_row = ttk.Frame(panel)
        strength_row.pack(fill=tk.X)
        self.lbl_strength = ttk.Label(strength_row, text="80%")
        self.lbl_strength.pack(side=tk.RIGHT)
        ttk.Scale(strength_row, from_=0, to=1, variable=self.var_strength,
                  command=self._on_strength).pack(side=tk.LEFT, fill=tk.X, expand=True)

        form = ttk.Frame(panel)
        form.pack(fill=tk.X, pady=4)
        ttk.Label(form, text="平滑窗口(帧)").grid(row=0, column=0, sticky=tk.W)
        ttk.Spinbox(form, from_=3, to=51, increment=2, width=6,
                    textvariable=self.var_window).grid(row=0, column=1, sticky=tk.E)
        ttk.Label(form, text="突变阈值(亮度)").grid(row=1, column=0, sticky=tk.W)
        ttk.Spinbox(form, from_=1, to=50, increment=1, width=6,
                    textvariable=self.var_spike).grid(row=1, column=1, sticky=tk.E)
        ttk.Label(form, text="切镜阈值(差异)").grid(row=2, column=0, sticky=tk.W)
        ttk.Spinbox(form, from_=5, to=120, increment=5, width=6,
                    textvariable=self.var_cut).grid(row=2, column=1, sticky=tk.E)
        form.columnconfigure(0, weight=1)

        ttk.Button(panel, text="重新分析", command=self.reanalyze).pack(fill=tk.X, pady=(6, 2))
        ttk.Separator(panel).pack(fill=tk.X, pady=8)

        ttk.Label(panel, text="稳定范围（在曲线图上拖选）").pack(anchor=tk.W)
        row = ttk.Frame(panel)
        row.pack(fill=tk.X)
        ttk.Button(row, text="全选", command=self.select_all).pack(side=tk.LEFT, expand=True, fill=tk.X, padx=(0, 2))
        ttk.Button(row, text="清除选区", command=self.clear_selection).pack(side=tk.LEFT, expand=True, fill=tk.X, padx=(2, 0))
        self.lbl_selection = ttk.Label(panel, text="未选择")
        self.lbl_selection.pack(anchor=tk.W, pady=2)

        ttk.Button(panel, text="计算稳定处理", command=self.compute_stabilization).pack(fill=tk.X, pady=(6, 2))
        ttk.Button(panel, text="清除处理结果", command=self.clear_stabilization).pack(fill=tk.X, pady=2)

        ttk.Separator(panel).pack(fill=tk.X, pady=8)
        self.lbl_frame_info = ttk.Label(panel, text="", justify=tk.LEFT, wraplength=220)
        self.lbl_frame_info.pack(anchor=tk.W)

    def _build_chart(self) -> None:
        self.chart = tk.Canvas(self, height=CHART_H, bg="#101418", highlightthickness=0)
        self.chart.pack(side=tk.TOP, fill=tk.X, padx=6, pady=(4, 0))
        self.chart.bind("<Configure>", lambda e: self.redraw_chart())
        self.chart.bind("<ButtonPress-1>", self._chart_press)
        self.chart.bind("<B1-Motion>", self._chart_drag)
        self.chart.bind("<ButtonRelease-1>", self._chart_release)

    def _build_timeline(self) -> None:
        wrap = ttk.Frame(self)
        wrap.pack(side=tk.TOP, fill=tk.X, padx=6, pady=4)
        self.timeline = tk.Canvas(wrap, height=THUMB_H + 14, bg="#181818", highlightthickness=0)
        scroll = ttk.Scrollbar(wrap, orient=tk.HORIZONTAL, command=self.timeline.xview)
        self.timeline.configure(xscrollcommand=scroll.set)
        self.timeline.pack(side=tk.TOP, fill=tk.X)
        scroll.pack(side=tk.TOP, fill=tk.X)
        self.timeline.bind("<Button-1>", self._timeline_click)
        self.timeline.bind("<MouseWheel>", lambda e: self.timeline.xview_scroll(-e.delta, "units"))

    def _build_statusbar(self) -> None:
        ttk.Label(self, textvariable=self.var_status, anchor=tk.W, relief=tk.SUNKEN).pack(
            side=tk.BOTTOM, fill=tk.X)

    # ------------------------------------------------------------------ 数据加载

    def open_directory(self, directory: str | None = None) -> bool:
        directory = directory or filedialog.askdirectory(title="选择图片序列目录")
        if not directory:
            return False
        paths = sequence.list_sequence(directory)
        if not paths:
            messagebox.showwarning("空目录", "该目录下没有受支持的图片文件")
            return False
        self.input_dir = directory
        self.paths = paths
        self.images = sequence.load_images(paths)
        self.current = 0
        self.selection = [None, None]
        self.gains = None
        self.reanalyze()
        self._build_thumbnails()
        self.var_status.set(f"已加载 {len(paths)} 帧：{directory}")
        return True

    def reanalyze(self) -> None:
        if not self.images:
            return
        self.result = analysis.analyze(
            self.images,
            spike_threshold=self.var_spike.get(),
            cut_threshold=self.var_cut.get(),
        )
        self.gains = None
        self.redraw_chart()
        self.refresh_view()
        self._update_frame_info()

    def _build_thumbnails(self) -> None:
        self.timeline.delete("all")
        self._thumb_photos.clear()
        step = THUMB_W + THUMB_PAD
        for i, img in enumerate(self.images):
            thumb = img.convert("RGB")
            thumb.thumbnail((THUMB_W, THUMB_H), Image.BILINEAR)
            photo = ImageTk.PhotoImage(thumb)
            self._thumb_photos.append(photo)
            x = i * step
            self.timeline.create_image(x + THUMB_W // 2, THUMB_H // 2, image=photo, tags=(f"thumb{i}",))
            self.timeline.create_text(x + 3, THUMB_H + 4, text=str(i), anchor=tk.NW,
                                      fill="#999", font=("", 8))
        self.timeline.configure(scrollregion=(0, 0, len(self.images) * step, THUMB_H + 14))
        self._decorate_timeline()

    def _decorate_timeline(self) -> None:
        """根据分析结果与当前帧刷新缩略图描边。"""
        self.timeline.delete("marker")
        step = THUMB_W + THUMB_PAD
        if self.result:
            for i in self.result.spikes:
                self.timeline.create_rectangle(i * step, 0, i * step + THUMB_W, THUMB_H,
                                               outline="#e74c3c", width=2, tags="marker")
            for i, is_cut in enumerate(self.result.cuts):
                if is_cut:
                    self.timeline.create_rectangle(i * step, 0, i * step + THUMB_W, THUMB_H,
                                                   outline="#3498db", width=2, tags="marker")
        if self.images:
            self.timeline.create_rectangle(self.current * step, 0, self.current * step + THUMB_W,
                                           THUMB_H, outline="#f39c12", width=3, tags="marker")

    # ------------------------------------------------------------------ 曲线图

    def _frame_to_x(self, i: int) -> float:
        w = self.chart.winfo_width()
        n = max(1, len(self.images) - 1)
        inner = w - CHART_MARGIN["left"] - CHART_MARGIN["right"]
        return CHART_MARGIN["left"] + inner * i / n

    def _x_to_frame(self, x: float) -> int:
        w = self.chart.winfo_width()
        n = max(1, len(self.images) - 1)
        inner = w - CHART_MARGIN["left"] - CHART_MARGIN["right"]
        t = (x - CHART_MARGIN["left"]) / max(1, inner)
        return round(min(1.0, max(0.0, t)) * n)

    def redraw_chart(self) -> None:
        self.chart.delete("all")
        if not self.result or not self.result.luminance:
            return
        lum = self.result.luminance
        h = CHART_H
        top, bottom = CHART_MARGIN["top"], h - CHART_MARGIN["bottom"]
        lo_l, hi_l = min(lum), max(lum)
        pad = max(2.0, (hi_l - lo_l) * 0.15)
        lo_l, hi_l = lo_l - pad, hi_l + pad

        def y_of(v: float) -> float:
            return bottom - (v - lo_l) / (hi_l - lo_l) * (bottom - top)

        # 选区底色
        if self.selection[0] is not None and self.selection[1] is not None:
            x0 = self._frame_to_x(self.selection[0])
            x1 = self._frame_to_x(self.selection[1])
            self.chart.create_rectangle(x0, top, x1, bottom, fill="#1d3040", outline="")

        # 坐标轴与刻度
        self.chart.create_line(CHART_MARGIN["left"], top, CHART_MARGIN["left"], bottom, fill="#555")
        self.chart.create_line(CHART_MARGIN["left"], bottom, self.chart.winfo_width() - CHART_MARGIN["right"],
                               bottom, fill="#555")
        for v in (lo_l + pad, hi_l - pad):
            y = y_of(v)
            self.chart.create_text(CHART_MARGIN["left"] - 4, y, text=f"{v:.1f}",
                                   anchor=tk.E, fill="#888", font=("", 8))

        # 切镜位置（蓝虚线）
        for i, is_cut in enumerate(self.result.cuts):
            if is_cut:
                x = self._frame_to_x(i)
                self.chart.create_line(x, top, x, bottom, fill="#3498db", dash=(4, 3))

        # 亮度曲线（处理后为绿色叠加）
        pts = []
        for i, v in enumerate(lum):
            pts += [self._frame_to_x(i), y_of(v)]
        if len(pts) >= 4:
            self.chart.create_line(*pts, fill="#f1c40f", width=1.5)
        if self.gains:
            proc = [lum[i] * self.gains[i] for i in range(len(lum))]
            pts = []
            for i, v in enumerate(proc):
                pts += [self._frame_to_x(i), y_of(v)]
            if len(pts) >= 4:
                self.chart.create_line(*pts, fill="#2ecc71", width=1.5)

        # 突变点（红）
        for i in self.result.spikes:
            x, y = self._frame_to_x(i), y_of(lum[i])
            self.chart.create_oval(x - 4, y - 4, x + 4, y + 4, fill="#e74c3c", outline="")

        # 当前帧
        x = self._frame_to_x(self.current)
        self.chart.create_line(x, top, x, bottom, fill="#f39c12", width=2)

    def _chart_press(self, event) -> None:
        self._drag_start_x = event.x

    def _chart_drag(self, event) -> None:
        if self._drag_start_x is None or not self.images:
            return
        a = self._x_to_frame(self._drag_start_x)
        b = self._x_to_frame(event.x)
        if a != b:
            self.selection = [min(a, b), max(a, b)]
            self._update_selection_label()
            self.redraw_chart()

    def _chart_release(self, event) -> None:
        if self._drag_start_x is None or not self.images:
            return
        a = self._x_to_frame(self._drag_start_x)
        b = self._x_to_frame(event.x)
        if a == b:  # 单击：定位帧
            self.seek(a)
        else:
            self.selection = [min(a, b), max(a, b)]
            self._update_selection_label()
            self.redraw_chart()
        self._drag_start_x = None

    # ------------------------------------------------------------------ 时间轴

    def _timeline_click(self, event) -> None:
        if not self.images:
            return
        x = self.timeline.canvasx(event.x)
        i = int(x // (THUMB_W + THUMB_PAD))
        self.seek(i)

    def seek(self, i: int) -> None:
        if not self.images:
            return
        self.current = max(0, min(len(self.images) - 1, i))
        self._decorate_timeline()
        self.timeline.xview_moveto(max(0.0, (self.current - 3) / max(1, len(self.images))))
        self.redraw_chart()
        self.refresh_view()
        self._update_frame_info()

    # ------------------------------------------------------------------ 画面查看

    def _processed(self, i: int) -> Image.Image:
        if self.gains is None:
            return self.images[i]
        return stabilize.apply_gain(self.images[i], self.gains[i])

    def _compose_view(self) -> Image.Image:
        mode = self.var_view.get()
        i = self.current
        cur = self.images[i].convert("RGB")
        if mode == VIEW_CURRENT:
            img = self._processed(i).convert("RGB") if self.gains else cur
            return img
        if mode == VIEW_ADJACENT:
            prev = self.images[max(0, i - 1)].convert("RGB")
            return self._side_by_side(prev, cur, f"帧 {max(0, i - 1)}", f"帧 {i}")
        if mode == VIEW_BEFORE_AFTER:
            after = self._processed(i).convert("RGB")
            return self._side_by_side(cur, after, f"帧 {i} 原图", f"帧 {i} 处理后")
        # VIEW_DIFF
        after = self._processed(i).convert("RGB")
        diff = ImageChops.difference(cur, after)
        arr = np.asarray(diff, dtype=np.uint16) * 4  # 放大 4 倍便于观察
        return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")

    @staticmethod
    def _side_by_side(a: Image.Image, b: Image.Image, la: str, lb: str) -> Image.Image:
        h = max(a.height, b.height)
        def fit(im: Image.Image) -> Image.Image:
            return im.resize((round(im.width * h / im.height), h), Image.BILINEAR) if im.height != h else im
        a, b = fit(a), fit(b)
        gap, label_h = 6, 22
        out = Image.new("RGB", (a.width + b.width + gap, h + label_h), "#303030")
        out.paste(a, (0, label_h))
        out.paste(b, (a.width + gap, label_h))
        d = ImageDraw.Draw(out)
        d.text((6, 4), la, fill="#f1c40f")
        d.text((a.width + gap + 6, 4), lb, fill="#2ecc71")
        return out

    def refresh_view(self) -> None:
        self.view_canvas.delete("all")
        if not self.images:
            return
        img = self._compose_view()
        cw = max(1, self.view_canvas.winfo_width())
        ch = max(1, self.view_canvas.winfo_height())
        scale = min(cw / img.width, ch / img.height, 1.0)
        disp = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))),
                          Image.BILINEAR)
        self._view_photo = ImageTk.PhotoImage(disp)
        self.view_canvas.create_image(cw // 2, ch // 2, image=self._view_photo)

    def _update_frame_info(self) -> None:
        if not self.images or not self.result:
            self.lbl_frame_info.config(text="")
            return
        i = self.current
        tags = []
        if self.result.cuts[i]:
            tags.append("镜头切换")
        if i in self.result.spikes:
            tags.append(f"亮度突变 {self.result.spike_dev[i]:+.1f}")
        gain_txt = f"\n增益: {self.gains[i]:.3f}" if self.gains else ""
        self.lbl_frame_info.config(
            text=f"帧 {i}/{len(self.images) - 1}  {self.paths[i].name}\n"
                 f"亮度: {self.result.luminance[i]:.2f}{gain_txt}\n"
                 f"{'；'.join(tags) if tags else '正常'}")

    # ------------------------------------------------------------------ 选区与稳定

    def _update_selection_label(self) -> None:
        lo, hi = self.selection
        self.lbl_selection.config(text="未选择" if lo is None else f"帧 {lo} ~ {hi}")

    def select_all(self) -> None:
        if self.images:
            self.selection = [0, len(self.images) - 1]
            self._update_selection_label()
            self.redraw_chart()

    def clear_selection(self) -> None:
        self.selection = [None, None]
        self._update_selection_label()
        self.redraw_chart()

    def compute_stabilization(self) -> None:
        if not self.result:
            return
        lo, hi = self.selection
        if lo is None:
            messagebox.showinfo("未选择范围", "请先在亮度曲线图上拖选稳定范围（或点“全选”）")
            return
        self.gains = stabilize.compute_gains(
            self.result.luminance, self.result.cuts, lo, hi,
            window=self.var_window.get(), strength=self.var_strength.get(),
        )
        changed = sum(1 for g in self.gains if abs(g - 1.0) > 1e-4)
        self.var_status.set(f"已计算稳定增益：{changed} 帧被调整（范围 {lo}~{hi}，强度 {self.var_strength.get():.0%}）")
        self.redraw_chart()
        self.refresh_view()
        self._update_frame_info()

    def clear_stabilization(self) -> None:
        self.gains = None
        self.redraw_chart()
        self.refresh_view()
        self._update_frame_info()
        self.var_status.set("已清除处理结果，恢复原始序列显示")

    def _on_strength(self, _value) -> None:
        v = self.var_strength.get()
        self.lbl_strength.config(text=f"{v:.0%}")
        if self.gains is not None:  # 已计算过时按新强度实时重算
            lo, hi = self.selection
            if lo is not None and self.result:
                self.gains = stabilize.compute_gains(
                    self.result.luminance, self.result.cuts, lo, hi,
                    window=self.var_window.get(), strength=v)
                self.redraw_chart()
                self.refresh_view()

    # ------------------------------------------------------------------ 一致性检查

    def show_consistency(self) -> None:
        if not self.paths:
            messagebox.showinfo("未加载", "请先打开图片序列目录")
            return
        report = sequence.check_consistency(self.paths)
        win = tk.Toplevel(self)
        win.title("一致性检查")
        win.geometry("520x420")
        text = tk.Text(win, wrap=tk.WORD, font=("Menlo", 11))
        text.pack(fill=tk.BOTH, expand=True)
        text.insert("1.0", sequence.format_report(report))
        text.config(state=tk.DISABLED)

    # ------------------------------------------------------------------ 工程

    def save_project_dialog(self) -> None:
        if not self.input_dir:
            messagebox.showinfo("未加载", "请先打开图片序列目录")
            return
        path = filedialog.asksaveasfilename(
            defaultextension=".json", initialfile="project.ffproj.json",
            filetypes=[("Flicker Fixer 工程", "*.ffproj.json"), ("JSON", "*.json")])
        if not path:
            return
        project = Project(
            input_dir=self.input_dir,
            selection=self.selection,
            strength=self.var_strength.get(),
            smooth_window=self.var_window.get(),
            spike_threshold=self.var_spike.get(),
            cut_threshold=self.var_cut.get(),
        )
        save_project(project, path)
        self.var_status.set(f"工程已保存：{path}")

    def load_project_dialog(self) -> None:
        path = filedialog.askopenfilename(
            filetypes=[("Flicker Fixer 工程", "*.ffproj.json"), ("JSON", "*.json")])
        if not path:
            return
        try:
            project = load_project(path)
        except Exception as exc:
            messagebox.showerror("加载失败", str(exc))
            return
        if not self.open_directory(project.input_dir):
            return
        self.var_strength.set(project.strength)
        self.var_window.set(project.smooth_window)
        self.var_spike.set(project.spike_threshold)
        self.var_cut.set(project.cut_threshold)
        self.selection = list(project.selection)
        self._on_strength(None)
        self.reanalyze()
        self._update_selection_label()
        self.redraw_chart()
        self.var_status.set(f"工程已加载：{path}")

    # ------------------------------------------------------------------ 导出

    def export_sequence(self) -> None:
        if not self.paths:
            messagebox.showinfo("未加载", "请先打开图片序列目录")
            return
        out_dir = filedialog.askdirectory(title="选择导出目录")
        if not out_dir:
            return
        out = Path(out_dir)
        processed = 0
        for i, src in enumerate(self.paths):
            dst = out / src.name  # 文件名一一对应，顺序不变
            if self.gains is not None and abs(self.gains[i] - 1.0) > 1e-6:
                img = stabilize.apply_gain(self.images[i], self.gains[i])
                if src.suffix.lower() in (".jpg", ".jpeg"):
                    img.convert("RGB").save(dst, quality=95)
                else:
                    img.save(dst)
                processed += 1
            else:
                shutil.copy2(src, dst)  # 范围外帧原样复制
        self.var_status.set(f"导出完成：{processed} 帧已稳定，{len(self.paths) - processed} 帧原样复制 → {out_dir}")
        messagebox.showinfo("导出完成",
                            f"共 {len(self.paths)} 帧\n稳定处理 {processed} 帧\n输出目录：{out_dir}")


def main() -> None:
    app = FlickerFixerApp()
    app.mainloop()


if __name__ == "__main__":
    main()
