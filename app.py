"""像素风批量换色工具 —— 图形界面（tkinter，纯本地运行）。

用法: python3 app.py
"""

from __future__ import annotations

import os
import tkinter as tk
from tkinter import colorchooser, filedialog, messagebox, simpledialog, ttk

import numpy as np
from PIL import Image, ImageTk

from pixel_recolor import samples
from pixel_recolor.batch import BatchResult, export_batch, run_batch
from pixel_recolor.core import (
    ColorMapping,
    Scheme,
    apply_scheme,
    extract_palette,
    highlight_preview,
    load_rgba,
    rgb_to_hex,
)
from pixel_recolor.project import ImageItem, Project

CHECKER = 8  # 透明区域棋盘格大小


def make_checker(w: int, h: int) -> Image.Image:
    img = Image.new("RGBA", (w, h), (200, 200, 200, 255))
    px = img.load()
    for y in range(h):
        for x in range(w):
            if (x // CHECKER + y // CHECKER) % 2:
                px[x, y] = (160, 160, 160, 255)
    return img


def to_photo(arr: np.ndarray, max_size: int = 420) -> ImageTk.PhotoImage:
    """RGBA 数组 -> 棋盘底 PhotoImage（最近邻放大，保持像素感）。"""
    im = Image.fromarray(arr, "RGBA")
    scale = max(1, min(max_size // im.width, max_size // im.height))
    if scale > 1:
        im = im.resize((im.width * scale, im.height * scale), Image.NEAREST)
    bg = make_checker(im.width, im.height)
    bg.alpha_composite(im)
    return ImageTk.PhotoImage(bg), scale


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("像素风批量换色工具")
        self.geometry("1280x760")

        self.project = Project()
        self.project_path = ""
        self.batch: BatchResult | None = None
        self._img_cache: dict[str, np.ndarray] = {}
        self._photo = None  # 防止被 GC
        self._preview_scale = 1
        self._compare_win = None

        self.preview_mode = tk.StringVar(value="preview")
        self.pick_mode = tk.BooleanVar(value=False)
        self.status = tk.StringVar(value="就绪")

        self._build_ui()
        self._refresh_all()

    # ---------- UI 构建 ----------

    def _build_ui(self):
        bar = ttk.Frame(self)
        bar.pack(side=tk.TOP, fill=tk.X, padx=4, pady=4)
        ttk.Button(bar, text="添加图片", command=self.add_images).pack(side=tk.LEFT)
        ttk.Button(bar, text="移除图片", command=self.remove_image).pack(side=tk.LEFT)
        ttk.Button(bar, text="生成示例图", command=self.gen_samples).pack(side=tk.LEFT)
        ttk.Separator(bar, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=6)
        ttk.Button(bar, text="打开工程", command=self.load_project).pack(side=tk.LEFT)
        ttk.Button(bar, text="保存工程", command=self.save_project).pack(side=tk.LEFT)
        ttk.Separator(bar, orient=tk.VERTICAL).pack(side=tk.LEFT, fill=tk.Y, padx=6)
        ttk.Button(bar, text="批量应用", command=self.run_batch).pack(side=tk.LEFT)
        ttk.Button(bar, text="导出PNG+清单", command=self.export).pack(side=tk.LEFT)
        ttk.Button(bar, text="方案对比", command=self.compare_schemes).pack(side=tk.LEFT)

        main = ttk.PanedWindow(self, orient=tk.HORIZONTAL)
        main.pack(fill=tk.BOTH, expand=True, padx=4, pady=4)

        # 左：图片列表
        left = ttk.Frame(main, width=280)
        main.add(left, weight=0)
        ttk.Label(left, text="图片列表（双击查看失败原因）").pack(anchor=tk.W)
        self.image_list = tk.Listbox(left, height=18, exportselection=False)
        self.image_list.pack(fill=tk.BOTH, expand=True)
        self.image_list.bind("<<ListboxSelect>>", lambda e: self.refresh_preview())
        self.image_list.bind("<Double-Button-1>", self.show_image_error)

        row = ttk.Frame(left)
        row.pack(fill=tk.X, pady=2)
        ttk.Label(row, text="方案:").pack(side=tk.LEFT)
        self.image_scheme = ttk.Combobox(row, state="readonly", width=14)
        self.image_scheme.pack(side=tk.LEFT, fill=tk.X, expand=True)
        self.image_scheme.bind("<<ComboboxSelected>>", self.assign_scheme)
        ttk.Button(left, text="设置排除蒙版…", command=self.set_mask).pack(fill=tk.X)
        ttk.Button(left, text="清除排除蒙版", command=self.clear_mask).pack(fill=tk.X)

        # 中：预览
        mid = ttk.Frame(main)
        main.add(mid, weight=1)
        modes = ttk.Frame(mid)
        modes.pack(fill=tk.X)
        for text, val in [
            ("原图", "original"),
            ("方案预览", "preview"),
            ("改动高亮", "highlight"),
            ("批量结果", "batch"),
        ]:
            ttk.Radiobutton(
                modes, text=text, value=val, variable=self.preview_mode,
                command=self.refresh_preview,
            ).pack(side=tk.LEFT)
        ttk.Checkbutton(
            modes, text="取色模式（点击预览图选源色）", variable=self.pick_mode
        ).pack(side=tk.LEFT, padx=8)
        self.canvas = tk.Canvas(mid, bg="#808080", highlightthickness=0)
        self.canvas.pack(fill=tk.BOTH, expand=True)
        self.canvas.bind("<Button-1>", self.on_canvas_click)

        # 右：方案编辑
        right = ttk.Frame(main, width=360)
        main.add(right, weight=0)
        ttk.Label(right, text="配色方案").pack(anchor=tk.W)
        srow = ttk.Frame(right)
        srow.pack(fill=tk.X)
        self.scheme_list = tk.Listbox(srow, height=5, exportselection=False)
        self.scheme_list.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self.scheme_list.bind("<<ListboxSelect>>", lambda e: self._refresh_mappings())
        scol = ttk.Frame(srow)
        scol.pack(side=tk.LEFT, fill=tk.Y)
        ttk.Button(scol, text="新建", command=self.add_scheme).pack(fill=tk.X)
        ttk.Button(scol, text="复制", command=self.dup_scheme).pack(fill=tk.X)
        ttk.Button(scol, text="删除", command=self.del_scheme).pack(fill=tk.X)

        ttk.Label(right, text="换色规则（源色 → 目标色）").pack(anchor=tk.W, pady=(8, 0))
        self.mapping_list = tk.Listbox(right, height=8, exportselection=False)
        self.mapping_list.pack(fill=tk.BOTH, expand=True)
        self.mapping_list.bind("<<ListboxSelect>>", lambda e: self._load_mapping())
        mrow = ttk.Frame(right)
        mrow.pack(fill=tk.X)
        ttk.Button(mrow, text="新增规则", command=self.add_mapping).pack(side=tk.LEFT)
        ttk.Button(mrow, text="删除规则", command=self.del_mapping).pack(side=tk.LEFT)
        ttk.Button(mrow, text="从调色板选源色", command=self.pick_from_palette).pack(side=tk.LEFT)

        edit = ttk.LabelFrame(right, text="选中规则")
        edit.pack(fill=tk.X, pady=4)
        erow = ttk.Frame(edit)
        erow.pack(fill=tk.X, pady=2)
        self.src_var = tk.StringVar(value="#000000")
        self.dst_var = tk.StringVar(value="#ffffff")
        self.src_btn = tk.Button(erow, textvariable=self.src_var, width=9,
                                 command=self.choose_src)
        self.src_btn.pack(side=tk.LEFT, padx=2)
        ttk.Label(erow, text="→").pack(side=tk.LEFT)
        self.dst_btn = tk.Button(erow, textvariable=self.dst_var, width=9,
                                 command=self.choose_dst)
        self.dst_btn.pack(side=tk.LEFT, padx=2)
        self.enabled_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(edit, text="启用", variable=self.enabled_var,
                        command=self.apply_mapping_edit).pack(anchor=tk.W)
        ttk.Label(edit, text="相似度容差 (0=精确):").pack(anchor=tk.W)
        self.tol_var = tk.IntVar(value=0)
        tol = ttk.Scale(edit, from_=0, to=200, variable=self.tol_var,
                        command=lambda v: self.apply_mapping_edit())
        tol.pack(fill=tk.X)
        self.tol_label = ttk.Label(edit, text="0")
        self.tol_label.pack(anchor=tk.E)
        self.tol_var.trace_add("write", lambda *a: self.tol_label.config(
            text=str(self.tol_var.get())))
        ttk.Button(edit, text="应用修改", command=self.apply_mapping_edit).pack(
            anchor=tk.E, pady=2)

        prot = ttk.LabelFrame(right, text="保护色（颜色组排除，永不改动）")
        prot.pack(fill=tk.X, pady=4)
        self.prot_list = tk.Listbox(prot, height=3, exportselection=False)
        self.prot_list.pack(fill=tk.X)
        prow = ttk.Frame(prot)
        prow.pack(fill=tk.X)
        ttk.Button(prow, text="添加", command=self.add_protected).pack(side=tk.LEFT)
        ttk.Button(prow, text="删除", command=self.del_protected).pack(side=tk.LEFT)

        ttk.Label(self, textvariable=self.status, relief=tk.SUNKEN,
                  anchor=tk.W).pack(side=tk.BOTTOM, fill=tk.X)

    # ---------- 辅助 ----------

    def current_image_item(self) -> ImageItem | None:
        sel = self.image_list.curselection()
        if not sel:
            return None
        idx = sel[0]
        return self.project.images[idx] if idx < len(self.project.images) else None

    def current_scheme(self) -> Scheme | None:
        sel = self.scheme_list.curselection()
        if not sel:
            return None
        idx = sel[0]
        return self.project.schemes[idx] if idx < len(self.project.schemes) else None

    def current_mapping(self) -> ColorMapping | None:
        scheme = self.current_scheme()
        sel = self.mapping_list.curselection()
        if not scheme or not sel or sel[0] >= len(scheme.mappings):
            return None
        return scheme.mappings[sel[0]]

    def load_image(self, path: str) -> np.ndarray:
        if path not in self._img_cache:
            self._img_cache[path] = load_rgba(path)
        return self._img_cache[path]

    def _refresh_all(self):
        self._refresh_images()
        self._refresh_schemes()
        self.refresh_preview()

    def _refresh_images(self):
        self.image_list.delete(0, tk.END)
        results = {r.path: r for r in self.batch.results} if self.batch else {}
        for item in self.project.images:
            name = os.path.basename(item.path)
            tag = ""
            if item.path in results:
                r = results[item.path]
                tag = " ✓" if r.ok else " ✗失败"
            mask = " [蒙版]" if item.mask else ""
            self.image_list.insert(tk.END, f"{name} → {item.scheme or '(未指定)'}{mask}{tag}")
        names = [s.name for s in self.project.schemes]
        self.image_scheme["values"] = names

    def _refresh_schemes(self):
        keep = self.scheme_list.curselection()
        self.scheme_list.delete(0, tk.END)
        for s in self.project.schemes:
            self.scheme_list.insert(tk.END, s.name)
        if keep and keep[0] < len(self.project.schemes):
            self.scheme_list.selection_set(keep[0])
        elif self.project.schemes:
            self.scheme_list.selection_set(0)
        self._refresh_mappings()

    def _refresh_mappings(self):
        self.mapping_list.delete(0, tk.END)
        scheme = self.current_scheme()
        if scheme:
            for m in scheme.mappings:
                flag = "" if m.enabled else "（停用）"
                self.mapping_list.insert(
                    tk.END, f"{m.src} → {m.dst}  容差{m.tolerance}{flag}")
            self._refresh_protected()
        self._load_mapping()
        self._refresh_images()

    def _refresh_protected(self):
        self.prot_list.delete(0, tk.END)
        scheme = self.current_scheme()
        if scheme:
            for c in scheme.protected:
                self.prot_list.insert(tk.END, c)

    def _load_mapping(self):
        m = self.current_mapping()
        if not m:
            return
        self.src_var.set(m.src)
        self.dst_var.set(m.dst)
        self.tol_var.set(m.tolerance)
        self.enabled_var.set(m.enabled)
        self.src_btn.config(bg=m.src)
        self.dst_btn.config(bg=m.dst)

    # ---------- 图片操作 ----------

    def add_images(self):
        paths = filedialog.askopenfilenames(
            filetypes=[("PNG 图片", "*.png"), ("所有文件", "*.*")])
        for p in paths:
            if p and all(i.path != p for i in self.project.images):
                scheme = self.project.schemes[0].name if self.project.schemes else ""
                self.project.images.append(ImageItem(path=p, scheme=scheme))
        self.batch = None
        self._refresh_images()
        if paths:
            self.image_list.selection_clear(0, tk.END)
            self.image_list.selection_set(tk.END)
            self.refresh_preview()

    def remove_image(self):
        item = self.current_image_item()
        if item:
            self.project.images.remove(item)
            self.batch = None
            self._refresh_images()
            self.refresh_preview()

    def assign_scheme(self, _event=None):
        item = self.current_image_item()
        if item:
            item.scheme = self.image_scheme.get()
            self._refresh_images()
            self.refresh_preview()

    def set_mask(self):
        item = self.current_image_item()
        if not item:
            return
        p = filedialog.askopenfilename(filetypes=[("PNG 图片", "*.png")])
        if p:
            item.mask = p
            self._refresh_images()
            self.refresh_preview()

    def clear_mask(self):
        item = self.current_image_item()
        if item:
            item.mask = ""
            self._refresh_images()
            self.refresh_preview()

    def gen_samples(self):
        d = filedialog.askdirectory(title="选择示例图输出目录")
        if not d:
            return
        paths = samples.generate(d)
        for p in paths:
            if all(i.path != p for i in self.project.images):
                scheme = self.project.schemes[0].name if self.project.schemes else ""
                self.project.images.append(ImageItem(path=p, scheme=scheme))
        self._refresh_images()
        self.status.set(f"已生成 {len(paths)} 张示例图: {d}")

    def show_image_error(self, _event=None):
        item = self.current_image_item()
        if not item or not self.batch:
            return
        for r in self.batch.results:
            if r.path == item.path and not r.ok:
                messagebox.showerror("处理失败", f"{item.path}\n\n{r.error}")

    # ---------- 方案操作 ----------

    def add_scheme(self):
        name = simpledialog.askstring("新建方案", "方案名称:", parent=self)
        if name:
            if self.project.scheme_by_name(name):
                messagebox.showwarning("重名", "方案名已存在")
                return
            self.project.schemes.append(Scheme(name=name))
            self._refresh_schemes()
            self.scheme_list.selection_clear(0, tk.END)
            self.scheme_list.selection_set(tk.END)
            self._refresh_mappings()

    def dup_scheme(self):
        s = self.current_scheme()
        if s:
            copy = Scheme.from_dict(s.to_dict())
            copy.name = s.name + " 副本"
            self.project.schemes.append(copy)
            self._refresh_schemes()

    def del_scheme(self):
        s = self.current_scheme()
        if s and messagebox.askyesno("删除", f"删除方案 {s.name}?"):
            self.project.schemes.remove(s)
            self._refresh_schemes()

    def add_mapping(self):
        s = self.current_scheme()
        if s:
            s.mappings.append(ColorMapping(src="#000000", dst="#ffffff", tolerance=0))
            self._refresh_mappings()
            self.mapping_list.selection_clear(0, tk.END)
            self.mapping_list.selection_set(tk.END)
            self._load_mapping()

    def del_mapping(self):
        s, m = self.current_scheme(), self.current_mapping()
        if s and m:
            s.mappings.remove(m)
            self._refresh_mappings()
            self.refresh_preview()

    def apply_mapping_edit(self):
        m = self.current_mapping()
        if not m:
            return
        m.src = self.src_var.get()
        m.dst = self.dst_var.get()
        m.tolerance = int(self.tol_var.get())
        m.enabled = self.enabled_var.get()
        self.src_btn.config(bg=m.src)
        self.dst_btn.config(bg=m.dst)
        self._refresh_mappings()
        self.refresh_preview()

    def choose_src(self):
        c = colorchooser.askcolor(self.src_var.get(), parent=self)
        if c and c[1]:
            self.src_var.set(c[1])
            self.apply_mapping_edit()

    def choose_dst(self):
        c = colorchooser.askcolor(self.dst_var.get(), parent=self)
        if c and c[1]:
            self.dst_var.set(c[1])
            self.apply_mapping_edit()

    def pick_from_palette(self):
        """从当前图片提取调色板，点击色块即设为源色。"""
        item = self.current_image_item()
        if not item:
            self.status.set("请先选择图片")
            return
        palette = extract_palette(self.load_image(item.path))
        if not palette:
            return
        win = tk.Toplevel(self)
        win.title("点击色块设为源色")
        for i, (hexv, count) in enumerate(palette):
            b = tk.Button(win, bg=hexv, width=4, height=2,
                          text=str(count), fg="#ffffff", compound=tk.CENTER,
                          command=lambda h=hexv: self._palette_chosen(win, h))
            b.grid(row=i // 8, column=i % 8, padx=1, pady=1)

    def _palette_chosen(self, win, hexv):
        if not self.current_mapping():
            self.add_mapping()
        self.src_var.set(hexv)
        self.apply_mapping_edit()
        win.destroy()

    def add_protected(self):
        s = self.current_scheme()
        if not s:
            return
        c = colorchooser.askcolor(parent=self)
        if c and c[1] and c[1] not in s.protected:
            s.protected.append(c[1])
            self._refresh_protected()
            self.refresh_preview()

    def del_protected(self):
        s = self.current_scheme()
        sel = self.prot_list.curselection()
        if s and sel:
            del s.protected[sel[0]]
            self._refresh_protected()
            self.refresh_preview()

    # ---------- 预览 ----------

    def refresh_preview(self):
        item = self.current_image_item()
        if not item:
            return
        if item.scheme:
            self.image_scheme.set(item.scheme)
        try:
            arr = self.load_image(item.path)
        except Exception as exc:
            self.status.set(f"读取失败: {exc}")
            return
        mode = self.preview_mode.get()
        try:
            if mode == "original":
                disp = arr
            elif mode == "batch":
                disp = arr
                if self.batch:
                    for r in self.batch.results:
                        if r.path == item.path:
                            if r.ok and r.data is not None:
                                disp = r.data
                            else:
                                self.status.set(f"该图批量处理失败: {r.error}")
                            break
            else:
                scheme = self.project.scheme_by_name(item.scheme)
                if scheme is None:
                    disp = arr
                    self.status.set("该图片未指定方案")
                else:
                    mask = None
                    if item.mask:
                        from pixel_recolor.batch import _load_mask
                        mask = _load_mask(item.mask, arr.shape[:2])
                    out, changed = apply_scheme(arr, scheme, mask)
                    disp = highlight_preview(arr, changed) if mode == "highlight" else out
                    self.status.set(
                        f"{os.path.basename(item.path)}: 将改动 {int(changed.sum())} 像素")
        except Exception as exc:
            self.status.set(f"预览失败: {exc}")
            return
        self._photo, self._preview_scale = to_photo(disp)
        self.canvas.delete("all")
        self.canvas.create_image(10, 10, anchor=tk.NW, image=self._photo)
        self.canvas.config(scrollregion=(0, 0, self._photo.width() + 20,
                                         self._photo.height() + 20))

    def on_canvas_click(self, event):
        """取色模式：点击预览图，把该像素颜色设为当前规则源色。"""
        if not self.pick_mode.get():
            return
        item = self.current_image_item()
        if not item:
            return
        arr = self.load_image(item.path)
        x = int((self.canvas.canvasx(event.x) - 10) // self._preview_scale)
        y = int((self.canvas.canvasy(event.y) - 10) // self._preview_scale)
        if 0 <= y < arr.shape[0] and 0 <= x < arr.shape[1]:
            r, g, b, a = (int(v) for v in arr[y, x])
            if a == 0:
                self.status.set("透明区域无颜色可取")
                return
            if not self.current_mapping():
                self.add_mapping()
            self.src_var.set(rgb_to_hex((r, g, b)))
            self.apply_mapping_edit()
            self.status.set(f"已取色 {self.src_var.get()} @ ({x},{y})")

    # ---------- 方案对比 ----------

    def compare_schemes(self):
        """同一图片应用多套方案，并排比较。"""
        item = self.current_image_item()
        if not item or not self.project.schemes:
            self.status.set("请先选择图片并建立方案")
            return
        if self._compare_win and self._compare_win.winfo_exists():
            self._compare_win.destroy()
        win = tk.Toplevel(self)
        win.title(f"方案对比 — {os.path.basename(item.path)}")
        self._compare_win = win
        arr = self.load_image(item.path)
        photos = []
        for col, scheme in enumerate(self.project.schemes):
            frame = ttk.LabelFrame(win, text=scheme.name)
            frame.grid(row=0, column=col, padx=4, pady=4)
            try:
                out, changed = apply_scheme(arr, scheme)
                photo, _ = to_photo(out, max_size=300)
                photos.append(photo)
                tk.Label(frame, image=photo).pack()
                ttk.Label(frame, text=f"改动 {int(changed.sum())} 像素").pack()
            except Exception as exc:
                ttk.Label(frame, text=f"失败: {exc}").pack()
        win._photos = photos  # 防止 GC

    # ---------- 批量 / 导出 / 工程 ----------

    def run_batch(self):
        if not self.project.images:
            self.status.set("请先添加图片")
            return
        self.batch = run_batch(self.project)
        ok, fail = len(self.batch.succeeded), len(self.batch.failed)
        self._refresh_images()
        self.status.set(f"批量应用完成: 成功 {ok}, 失败 {fail}（双击失败项查看原因）")
        self.preview_mode.set("batch")
        self.refresh_preview()

    def export(self):
        if not self.project.images:
            self.status.set("请先添加图片")
            return
        d = filedialog.askdirectory(title="选择导出目录（原图不会被修改）")
        if not d:
            return
        batch, json_path, csv_path = export_batch(self.project, d)
        self.batch = batch
        self._refresh_images()
        ok, fail = len(batch.succeeded), len(batch.failed)
        messagebox.showinfo(
            "导出完成",
            f"成功 {ok} 张, 失败 {fail} 张\n清单:\n{json_path}\n{csv_path}")
        self.status.set(f"导出完成: {d}")

    def save_project(self):
        p = self.project_path or filedialog.asksaveasfilename(
            defaultextension=".json", filetypes=[["换色工程", "*.json"]])
        if not p:
            return
        self.project.save(p)
        self.project_path = p
        self.status.set(f"工程已保存: {p}")

    def load_project(self):
        p = filedialog.askopenfilename(filetypes=[["换色工程", "*.json"]])
        if not p:
            return
        try:
            self.project = Project.load(p)
            self.project_path = p
            self.batch = None
            self._img_cache.clear()
            self._refresh_all()
            self.status.set(f"工程已打开: {p}")
        except Exception as exc:
            messagebox.showerror("打开失败", str(exc))


if __name__ == "__main__":
    App().mainloop()
