"""tkinter 双面板 GUI：两组解释参数并排比较，点选像素查看字节溯源。

运行：python -m rawframe.gui [样例目录]
"""
from __future__ import annotations

import os
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

import numpy as np

from .model import FrameParams
from .rawio import RawFile
from .layout import planes_of, trace_pixel, describe_location, chroma_coverage
from .render import render_crop, overlay_missing, mean_abs_diff, to_ppm
from .config import export_png_sequence
from .samples import generate_all

PAD = 12  # 预览区最大边长


class InterpretationPanel(ttk.LabelFrame):
    """一组解释参数 + 对应预览画布 + 溯源文本。"""

    def __init__(self, master, title: str, on_pixel, on_params_change):
        super().__init__(master, text=title, padding=8)
        self.on_pixel = on_pixel
        self.on_params_change = on_params_change
        self.params: FrameParams | None = None
        self.rf: RawFile | None = None
        self._image = None
        self._zoom = 1
        self._crop: tuple[int, int, int, int] | None = None
        self._build_widgets()

    # ------------------------------------------------------------------ UI
    def _build_widgets(self) -> None:
        form = ttk.Frame(self)
        form.grid(row=0, column=0, sticky="ew", pady=(0, 6))
        self.var_w = tk.StringVar(value="16")
        self.var_h = tk.StringVar(value="8")
        self.var_fmt = tk.StringVar(value="i420")
        self.var_sy = tk.StringVar(value="0")
        self.var_suv = tk.StringVar(value="0")
        self.var_range = tk.StringVar(value="limited")
        fields = [
            ("宽", self.var_w), ("高", self.var_h),
            ("strideY(0=自动)", self.var_sy),
            ("strideUV(0=自动)", self.var_suv),
        ]
        for col, (label, var) in enumerate(fields):
            ttk.Label(form, text=label).grid(row=0, column=col * 2, padx=2)
            ttk.Entry(form, textvariable=var, width=7).grid(
                row=0, column=col * 2 + 1, padx=2)
        ttk.Label(form, text="格式").grid(row=0, column=8, padx=2)
        ttk.Combobox(form, textvariable=self.var_fmt, width=6,
                     values=("i420", "nv12", "rgba"), state="readonly"
                     ).grid(row=0, column=9, padx=2)
        ttk.Label(form, text="范围").grid(row=0, column=10, padx=2)
        ttk.Combobox(form, textvariable=self.var_range, width=8,
                     values=("limited", "full"), state="readonly"
                     ).grid(row=0, column=11, padx=2)
        ttk.Button(form, text="应用", command=self._apply).grid(
            row=0, column=12, padx=6)

        self.var_status = tk.StringVar(value="未加载文件")
        ttk.Label(self, textvariable=self.var_status, foreground="#064").grid(
            row=1, column=0, sticky="ew", pady=(0, 4))

        self.canvas = tk.Canvas(self, width=PAD * 28, height=PAD * 16,
                                background="#222", highlightthickness=1)
        self.canvas.grid(row=2, column=0, sticky="nsew")
        self.canvas.bind("<Button-1>", self._on_click)

        self.var_trace = tk.StringVar(value="在画面上点选像素查看字节来源")
        ttk.Label(self, textvariable=self.var_trace, justify="left",
                  wraplength=520, font=("Menlo", 10)).grid(
            row=3, column=0, sticky="ew", pady=(6, 0))

    def set_params(self, p: FrameParams) -> None:
        self.var_w.set(str(p.width))
        self.var_h.set(str(p.height))
        self.var_fmt.set(p.fmt)
        self.var_sy.set(str(p.stride_y))
        self.var_suv.set(str(p.stride_uv))
        self.var_range.set(p.color_range)

    def _read_params(self) -> FrameParams:
        return FrameParams(
            width=int(self.var_w.get()), height=int(self.var_h.get()),
            fmt=self.var_fmt.get(), stride_y=int(self.var_sy.get() or 0),
            stride_uv=int(self.var_suv.get() or 0),
            color_range=self.var_range.get())

    def _apply(self) -> None:
        try:
            self.params = self._read_params()
            self.params.validate()
        except (ValueError, tk.TclError) as ex:
            messagebox.showerror("参数错误", str(ex))
            return
        self.on_params_change(self)

    # -------------------------------------------------------------- 渲染
    def attach(self, rf: RawFile) -> None:
        self.rf = rf
        self.params = rf.params

    def render(self, frame_index: int,
               crop: tuple[int, int, int, int] | None, zoom: int) -> None:
        if self.rf is None or self.params is None:
            return
        self._crop = crop
        self._zoom = zoom
        planes = self.rf.read_planes(frame_index)
        rgb, miss, (cw, ch) = render_crop(self.params, planes, crop, zoom)
        rgb = overlay_missing(rgb, miss)
        self._rgb, self._miss = rgb, miss
        self._crop_origin = (crop[0], crop[1]) if crop else (0, 0)
        photo = tk.PhotoImage(data=to_ppm(rgb), master=self.canvas)
        self._image = photo
        self.canvas.delete("all")
        self.canvas.create_image(0, 0, anchor="nw", image=photo)
        self._draw_chroma_grid(crop, zoom, cw, ch)
        self._draw_status(frame_index, miss)

    def _draw_chroma_grid(self, crop, zoom, cw, ch) -> None:
        """YUV 模式下画出色度采样块边界；奇数边缘块用不同颜色提示。"""
        if self.params is None or self.params.fmt == "rgba":
            return
        x0, y0 = self._crop_origin
        for cx in range((x0 // 2), (x0 + cw) // 2 + 1):
            sx = max(0, cx * 2 - x0) * zoom
            if 0 <= sx < cw * zoom:
                self.canvas.create_line(sx, 0, sx, ch * zoom, fill="#ff8")
        for cy in range((y0 // 2), (y0 + ch) // 2 + 1):
            sy = max(0, cy * 2 - y0) * zoom
            if 0 <= sy < ch * zoom:
                self.canvas.create_line(0, sy, cw * zoom, sy, fill="#ff8")
        # 奇数宽/高的边缘色度块用红框标出真实覆盖范围
        if self.params.width % 2 or self.params.height % 2:
            for cy in range((self.params.height + 1) // 2):
                for cx in range((self.params.width + 1) // 2):
                    bx0, by0, bx1, by1 = chroma_coverage(self.params, cx, cy)
                    if bx1 - bx0 < 2 or by1 - by0 < 2:
                        rx0 = (bx0 - x0) * zoom
                        ry0 = (by0 - y0) * zoom
                        rx1 = (bx1 - x0) * zoom
                        ry1 = (by1 - y0) * zoom
                        if rx1 > 0 and ry1 > 0 and rx0 < cw * zoom and ry0 < ch * zoom:
                            self.canvas.create_rectangle(
                                max(0, rx0), max(0, ry0),
                                min(cw * zoom, rx1), min(ch * zoom, ry1),
                                outline="#f44", width=2)

    def _draw_status(self, frame_index: int, miss: np.ndarray) -> None:
        assert self.rf and self.params
        scan = self.rf.scan
        geoms = ", ".join(
            f"{g.name}@{g.offset}" + (f"(填充{g.row_padding}/行)"
                                      if g.row_padding else "")
            for g in planes_of(self.params))
        lines = [
            f"帧 {frame_index} | 完整帧 {scan.safe_frame_count} | "
            f"帧大小 {scan.frame_size}B | 文件 {scan.file_size}B | "
            f"剩余 {scan.leftover}B",
            f"平面起点: {geoms}",
        ]
        if scan.partial:
            pa = scan.partial
            lines.append(
                f"⚠ 截断帧 #{pa.index}: 缺 {scan.frame_size - pa.present_bytes}B，"
                f"首缺绝对偏移 {pa.first_missing_abs}（{pa.location}）"
                f"{'，缺失全为行尾填充' if pa.image_valid_complete else ''}")
        if miss.any():
            lines.append(f"青色区域为文件中缺失的像素，共 {int(miss.sum())} 个")
        self.var_status.set("\n".join(lines))

    # -------------------------------------------------------------- 交互
    def _on_click(self, event) -> None:
        if self.rf is None or self.params is None or not hasattr(self, "_rgb"):
            return
        zoom = self._zoom
        ix, iy = event.x // zoom, event.y // zoom
        h, w = self._rgb.shape[0] // zoom, self._rgb.shape[1] // zoom
        if not (0 <= ix < w and 0 <= iy < h):
            return
        x0, y0 = self._crop_origin
        self.on_pixel(self, ix + x0, iy + y0)

    def show_trace(self, frame_index: int, x: int, y: int) -> None:
        assert self.rf and self.params
        entries = trace_pixel(self.params, x, y)
        reads = self.rf.read_trace(frame_index, entries)
        lines = [f"像素 ({x},{y}) 的字节来源（帧 {frame_index}）："]
        for r in reads:
            e = r["entry"]
            vals = ["缺" if v is None else str(v) for v in r["values"]]
            lines.append(
                f"  {e.label:9s} 平面 {e.plane} 采样({e.sample_x},{e.sample_y}) "
                f"帧内偏移 {e.frame_rel_offset} → 绝对偏移 {r['abs_offset']} "
                f"值=[{', '.join(vals)}]")
            lines.append(f"             {describe_location(self.params, e.frame_rel_offset)}")
            if e.coverage:
                lines.append(f"             色度覆盖亮度矩形 {e.coverage}")
        self.var_trace.set("\n".join(lines))
        # 在画布上标出选中像素
        if hasattr(self, "_rgb"):
            self.canvas.delete("marker")
            ox, oy = self._crop_origin
            z = self._zoom
            self.canvas.create_rectangle(
                (x - ox) * z, (y - oy) * z,
                (x - ox + 1) * z - 1, (y - oy + 1) * z - 1,
                outline="#fff", width=2, tags="marker")


class RawFrameApp(tk.Tk):
    def __init__(self, sample_dir: str | None = None):
        super().__init__()
        self.title("原始帧布局检查工具 — i420 / nv12 / rgba")
        self.geometry("1180x920")
        self.file_path: str | None = None
        self.rf_a: RawFile | None = None
        self.rf_b: RawFile | None = None
        self.frame_index = 0
        self._build_widgets()
        if sample_dir and os.path.isdir(sample_dir):
            self.load_sample_dir(sample_dir)

    # -------------------------------------------------------------- 布局
    def _build_widgets(self) -> None:
        top = ttk.Frame(self, padding=6)
        top.pack(fill="x")
        ttk.Button(top, text="打开原始文件…", command=self.open_file).pack(side="left")
        ttk.Button(top, text="生成/刷新内置样例…",
                   command=self.generate_samples).pack(side="left", padx=4)
        self.var_sample = tk.StringVar()
        self.sample_box = ttk.Combobox(top, textvariable=self.var_sample,
                                       width=44, state="readonly")
        self.sample_box.pack(side="left", padx=6)
        self.sample_box.bind("<<ComboboxSelected>>", self.pick_sample)
        ttk.Label(top, text="帧:").pack(side="left")
        self.var_frame = tk.StringVar(value="0")
        ttk.Entry(top, textvariable=self.var_frame, width=5).pack(side="left")
        ttk.Button(top, text="跳转", command=self.goto_frame).pack(side="left", padx=4)

        ttk.Label(top, text="裁剪 x0,y0,x1,y1:").pack(side="left", padx=(12, 2))
        self.var_crop = tk.StringVar(value="")
        ttk.Entry(top, textvariable=self.var_crop, width=18).pack(side="left")
        ttk.Label(top, text="放大:").pack(side="left", padx=(8, 2))
        self.var_zoom = tk.StringVar(value="1")
        ttk.Combobox(top, textvariable=self.var_zoom, width=3,
                     values=("1", "2", "4", "8"), state="readonly").pack(side="left")
        ttk.Button(top, text="刷新预览", command=self.refresh).pack(side="left", padx=6)
        ttk.Button(top, text="导出本帧 PNG+配置",
                   command=self.export_current).pack(side="left")

        self.var_diff = tk.StringVar(value="")
        ttk.Label(self, textvariable=self.var_diff, foreground="#a30",
                  font=("Menlo", 11)).pack(fill="x", padx=8)

        body = ttk.Frame(self)
        body.pack(fill="both", expand=True)
        self.panel_a = InterpretationPanel(body, "解释 A", self.on_pixel,
                                           self.on_params_change)
        self.panel_b = InterpretationPanel(body, "解释 B", self.on_pixel,
                                           self.on_params_change)
        self.panel_a.pack(side="left", fill="both", expand=True, padx=4)
        self.panel_b.pack(side="left", fill="both", expand=True, padx=4)

    # -------------------------------------------------------------- 文件
    def generate_samples(self) -> None:
        d = filedialog.askdirectory(title="选择样例输出目录")
        if not d:
            return
        generate_all(d)
        self.load_sample_dir(d)
        messagebox.showinfo("完成", f"样例已生成到 {d}")

    def load_sample_dir(self, d: str) -> None:
        import json
        self.sample_dir = d
        with open(os.path.join(d, "manifest.json"), encoding="utf-8") as f:
            self.manifest = json.load(f)
        labels = [f"{m['key']}: {m['description']}" for m in self.manifest]
        self.sample_box["values"] = labels
        if labels:
            self.sample_box.current(0)
            self.pick_sample()

    def pick_sample(self, event=None) -> None:
        idx = self.sample_box.current()
        if idx < 0:
            return
        m = self.manifest[idx]
        path = os.path.join(self.sample_dir, m["filename"])
        p = FrameParams.from_dict(m["params"])
        self._open(path, p)

    def open_file(self) -> None:
        path = filedialog.askopenfilename(title="选择原始帧文件")
        if not path:
            return
        p = self.panel_a.params or FrameParams(16, 8)
        self._open(path, p)

    def _open(self, path: str, params: FrameParams) -> None:
        try:
            self.rf_a = RawFile(path, params)
            self.rf_b = RawFile(path, FrameParams(**{**params.to_dict()}))
        except Exception as ex:
            messagebox.showerror("打开失败", str(ex))
            return
        self.file_path = path
        self.frame_index = 0
        self.var_frame.set("0")
        self.panel_a.attach(self.rf_a)
        self.panel_b.attach(self.rf_b)
        self.panel_a.set_params(params)
        self.panel_b.set_params(params)
        self.refresh()

    # -------------------------------------------------------------- 预览
    def _current_crop(self) -> tuple[int, int, int, int] | None:
        s = self.var_crop.get().strip()
        if not s:
            return None
        try:
            x0, y0, x1, y1 = (int(v) for v in s.replace(" ", "").split(","))
            return x0, y0, x1, y1
        except ValueError:
            messagebox.showerror("裁剪错误", "格式应为 x0,y0,x1,y1")
            return None

    def goto_frame(self) -> None:
        try:
            self.frame_index = int(self.var_frame.get())
        except ValueError:
            messagebox.showerror("帧错误", "帧索引必须是整数")
            return
        self.refresh()

    def on_params_change(self, panel: InterpretationPanel) -> None:
        # 参数变化只重建该面板自己的 RawFile（只读重开，源文件不受影响）
        assert self.file_path
        try:
            rf = RawFile(self.file_path, panel.params)
        except Exception as ex:
            messagebox.showerror("参数错误", str(ex))
            return
        if panel is self.panel_a:
            self.rf_a = rf
        else:
            self.rf_b = rf
        panel.attach(rf)
        self.refresh()

    def refresh(self) -> None:
        if self.rf_a is None:
            return
        crop = self._current_crop()
        zoom = int(self.var_zoom.get())
        fi = self.frame_index
        # 截断帧也允许预览（缺字节处显示青色），越界则拒绝
        for rf, panel in ((self.rf_a, self.panel_a), (self.rf_b, self.panel_b)):
            if fi > rf.scan.complete_frames:
                messagebox.showerror(
                    "帧越界",
                    f"该解释下最多可预览到帧 {rf.scan.complete_frames}（截断帧）")
                return
        self.panel_a.render(fi, crop, zoom)
        self.panel_b.render(fi, crop, zoom)
        self._update_diff(crop)

    def _update_diff(self, crop) -> None:
        a, b = getattr(self.panel_a, "_rgb", None), getattr(self.panel_b, "_rgb", None)
        if a is None or b is None:
            return
        d = mean_abs_diff(a, b)
        pa, pb = self.panel_a.params, self.panel_b.params
        same = (pa.to_dict() == pb.to_dict())
        self.var_diff.set(
            f"两组解释的平均绝对色差: {d:.2f} / 255"
            + ("（参数相同，应一致）" if same else "（参数不同，色差可帮助判断哪种解释正确）"))

    # -------------------------------------------------------------- 溯源
    def on_pixel(self, panel: InterpretationPanel, x: int, y: int) -> None:
        self.panel_a.show_trace(self.frame_index, x, y)
        self.panel_b.show_trace(self.frame_index, x, y)

    # -------------------------------------------------------------- 导出
    def export_current(self) -> None:
        if self.rf_a is None:
            messagebox.showinfo("提示", "请先打开文件")
            return
        d = filedialog.askdirectory(title="选择 PNG 导出目录")
        if not d:
            return
        crop = self._current_crop()
        try:
            res = export_png_sequence(
                self.file_path, self.panel_a.params, d,
                [self.frame_index], crop=crop, tag="gui")
        except Exception as ex:
            messagebox.showerror("导出失败", str(ex))
            return
        messagebox.showinfo(
            "导出完成",
            f"PNG: {res.png_files[0]}\n配置: {res.config_path}\n"
            f"行尾填充不会写入 PNG；可用 verify 子命令回读校验")


def main() -> None:
    import sys
    sample_dir = sys.argv[1] if len(sys.argv) > 1 else None
    app = RawFrameApp(sample_dir)
    app.mainloop()


if __name__ == "__main__":
    main()
