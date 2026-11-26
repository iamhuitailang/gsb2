"""Tkinter 图形界面：圈模板、查找、人工复核与导出。

设计要点：
- 每张目标图的决策按文件身份键独立存储，切换图片互不串状态；
- 阈值滑块只做即时过滤，重算（角度/缩放/翻面参数变化）时通过
  :class:`ReviewStore` 把已确认/误报按位置+朝向认回；
- 翻面默认关闭，勾选后才搜索镜像候选；
- 候选列表选中后弹出四宫格局部对照（变换模板/目标/差异/单元热力）。
"""

from __future__ import annotations

import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import cv2
import numpy as np
from PIL import Image, ImageTk

from .candidates import Match
from .export import export_results
from .matching import SearchParams, find_matches
from .review import ReviewStore, image_identity
from .template import Template, extract_rect_template, load_image, load_template, save_template
from .visualization import comparison_panel, draw_all, template_preview


def _cv_to_photo(img_bgr: np.ndarray, max_side: int | None = None) -> ImageTk.PhotoImage:
    rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    pil = Image.fromarray(rgb)
    if max_side and max(pil.size) > max_side:
        pil.thumbnail((max_side, max_side))
    return ImageTk.PhotoImage(pil)


class ExtractDialog(tk.Toplevel):
    """在源图上拖矩形圈模板的模态对话框。"""

    def __init__(self, master: tk.Misc, image: np.ndarray, image_path: str):
        super().__init__(master)
        self.title("圈出模板（按住左键拖框）")
        self.image = image
        self.image_path = image_path
        self.result: Template | None = None
        self.mode_var = tk.StringVar(value="flood")
        self.tol_var = tk.IntVar(value=24)

        h, w = image.shape[:2]
        scale = min(1.0, 900 / w, 700 / h)
        self.scale = scale
        disp = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        self.photo = _cv_to_photo(disp)
        self.canvas = tk.Canvas(
            self, width=disp.shape[1], height=disp.shape[0],
            highlightthickness=1, highlightbackground="#888",
        )
        self.canvas.pack(side=tk.LEFT)
        self.canvas.create_image(0, 0, anchor=tk.NW, image=self.photo)
        self.canvas.bind("<ButtonPress-1>", self._press)
        self.canvas.bind("<B1-Motion>", self._drag)
        self.canvas.bind("<ButtonRelease-1>", self._release)
        self._start = None
        self._rect_id = None
        self._rect = None

        panel = ttk.Frame(self, padding=10)
        panel.pack(side=tk.RIGHT, fill=tk.Y)
        ttk.Label(panel, text="背景处理").pack(anchor=tk.W)
        for text, val in [
            ("整块矩形", "rect"),
            ("灌掉连通背景 (flood)", "flood"),
            ("只留中心连通前景", "center"),
        ]:
            ttk.Radiobutton(panel, text=text, variable=self.mode_var, value=val).pack(anchor=tk.W)
        ttk.Label(panel, text="颜色容差").pack(anchor=tk.W, pady=(8, 0))
        ttk.Scale(panel, from_=4, to=80, variable=self.tol_var, orient=tk.HORIZONTAL).pack(fill=tk.X)
        self.preview_lab = ttk.Label(panel)
        self.preview_lab.pack(pady=12)
        btns = ttk.Frame(panel)
        btns.pack(fill=tk.X)
        ttk.Button(btns, text="确定", command=self._ok).pack(side=tk.LEFT, expand=True, fill=tk.X)
        ttk.Button(btns, text="取消", command=self.destroy).pack(side=tk.LEFT, expand=True, fill=tk.X)
        self.transient(master)
        self.grab_set()

    def _press(self, event):
        self._start = (event.x, event.y)
        if self._rect_id:
            self.canvas.delete(self._rect_id)
        self._rect_id = self.canvas.create_rectangle(
            event.x, event.y, event.x, event.y, outline=(255, 60, 60), width=2
        )

    def _drag(self, event):
        if self._start and self._rect_id:
            self.canvas.coords(self._rect_id, self._start[0], self._start[1], event.x, event.y)

    def _release(self, event):
        if not self._start:
            return
        x0, y0 = self._start
        x1, y1 = event.x, event.y
        x, y = min(x0, x1), min(y0, y1)
        w, h = abs(x1 - x0), abs(y1 - y0)
        if w < 4 or h < 4:
            return
        self._rect = (
            int(x / self.scale), int(y / self.scale),
            int(w / self.scale), int(h / self.scale),
        )
        self._refresh_preview()

    def _refresh_preview(self):
        if not self._rect:
            return
        tpl = extract_rect_template(
            self.image, self._rect, mode=self.mode_var.get(), bg_tolerance=int(self.tol_var.get())
        )
        self._temp = _cv_to_photo(template_preview(tpl, 220))
        self.preview_lab.configure(image=self._temp)

    def _ok(self):
        if not self._rect:
            messagebox.showwarning("提示", "请先在图上拖出矩形", parent=self)
            return
        try:
            tpl = extract_rect_template(
                self.image, self._rect, mode=self.mode_var.get(),
                bg_tolerance=int(self.tol_var.get()),
            )
        except ValueError as exc:
            messagebox.showerror("提取失败", str(exc), parent=self)
            return
        self.result = tpl.cropped()
        self.destroy()


class MarkFinderApp:
    def __init__(self, root: tk.Tk, initial_image: str | None, initial_template: str | None,
                 state_path: str):
        self.root = root
        root.title("markfinder 模板查找器")
        root.geometry("1280x840")
        self.store = ReviewStore(state_path)
        self.state_path = Path(state_path)
        self.image: np.ndarray | None = None
        self.image_path: str | None = None
        self.image_key: str | None = None
        self.state = None
        self.template: Template | None = None
        self._photo = None
        self._zoom = 1.0
        self._busy = False
        self._build_menu()
        self._build_layout()
        if initial_template:
            self._load_template(initial_template)
        if initial_image:
            self.open_image(initial_image)

    # ----------------------------------------------------------- 布局
    def _build_menu(self) -> None:
        menubar = tk.Menu(self.root)
        m_file = tk.Menu(menubar, tearoff=0)
        m_file.add_command(label="打开目标图…", command=self.ask_open_image)
        m_file.add_command(label="从图片圈模板…", command=self.ask_extract_template)
        m_file.add_command(label="打开模板 PNG…", command=self.ask_open_template)
        m_file.add_command(label="保存模板 PNG…", command=self.save_template_as)
        m_file.add_separator()
        m_file.add_command(label="导出当前图结果…", command=self.export_current)
        m_file.add_separator()
        m_file.add_command(label="退出", command=self.root.destroy)
        menubar.add_cascade(label="文件", menu=m_file)
        self.root.config(menu=menubar)

    def _build_layout(self) -> None:
        main = ttk.PanedWindow(self.root, orient=tk.HORIZONTAL)
        main.pack(fill=tk.BOTH, expand=True)

        # 左：画布
        left = ttk.Frame(main)
        main.add(left, weight=4)
        canvas_wrap = ttk.Frame(left)
        canvas_wrap.pack(fill=tk.BOTH, expand=True)
        self.canvas = tk.Canvas(canvas_wrap, background="#3a3a3a")
        sy = ttk.Scrollbar(canvas_wrap, orient=tk.VERTICAL, command=self.canvas.yview)
        sx = ttk.Scrollbar(canvas_wrap, orient=tk.HORIZONTAL, command=self.canvas.xview)
        self.canvas.configure(yscrollcommand=sy.set, xscrollcommand=sx.set)
        self.canvas.grid(row=0, column=0, sticky=tk.NSEW)
        sy.grid(row=0, column=1, sticky=tk.NS)
        sx.grid(row=1, column=0, sticky=tk.EW)
        canvas_wrap.rowconfigure(0, weight=1)
        canvas_wrap.columnconfigure(0, weight=1)
        self.canvas.bind("<MouseWheel>", self._wheel)
        self.canvas.bind("<Button-2>", self._pan_start)
        self.canvas.bind("<B2-Motion>", self._pan_move)
        self.canvas.bind("<Button-1>", self._canvas_click)
        self.status = ttk.Label(left, text="未打开图片", anchor=tk.W)
        self.status.pack(fill=tk.X)

        # 右：控制面板
        right = ttk.Frame(main, padding=8)
        main.add(right, weight=2)

        self.tpl_preview = ttk.Label(right, text="（无模板）", anchor=tk.CENTER, width=28)
        self.tpl_preview.pack(fill=tk.X)

        param = ttk.LabelFrame(right, text="查找参数", padding=8)
        param.pack(fill=tk.X, pady=6)
        self.vars = {}
        self._spin(param, "min_angle", "最小角度", 0.0, 0.0, 360.0)
        self._spin(param, "max_angle", "最大角度", 360.0, 0.0, 360.0)
        self._spin(param, "angle_step", "角度步距", 5.0, 1.0, 45.0, increment=1.0)
        self._spin(param, "min_scale", "最小缩放", 0.8, 0.2, 4.0, increment=0.05)
        self._spin(param, "max_scale", "最大缩放", 1.25, 0.2, 4.0, increment=0.05)
        self._spin(param, "num_scales", "缩放档数", 5, 1, 15, increment=1)
        self.flip_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(
            param, text="允许翻面匹配（默认关闭）", variable=self.flip_var
        ).pack(anchor=tk.W, pady=4)
        self.run_btn = ttk.Button(param, text="开始查找", command=self.run_search)
        self.run_btn.pack(fill=tk.X, pady=(6, 0))
        self.progress = ttk.Progressbar(param, mode="determinate")
        self.progress.pack(fill=tk.X, pady=(6, 0))
        self.progress_lab = ttk.Label(param, text="")
        self.progress_lab.pack(anchor=tk.W)

        thr = ttk.LabelFrame(right, text="阈值（即时过滤，不丢人工结论）", padding=8)
        thr.pack(fill=tk.X, pady=6)
        self.thr_var = tk.DoubleVar(value=0.6)
        self.thr_scale = ttk.Scale(
            thr, from_=0.0, to=0.98, variable=self.thr_var,
            orient=tk.HORIZONTAL, command=self._on_threshold,
        )
        self.thr_scale.pack(fill=tk.X)
        self.thr_lab = ttk.Label(thr, text="当前阈值: 0.60")
        self.thr_lab.pack(anchor=tk.W)

        list_frame = ttk.LabelFrame(right, text="候选（双击查看局部对照）", padding=4)
        list_frame.pack(fill=tk.BOTH, expand=True, pady=6)
        cols = ("id", "score", "angle", "scale", "flip", "decision")
        self.tree = ttk.Treeview(list_frame, columns=cols, show="headings", height=10)
        headings = {
            "id": ("ID", 70), "score": ("分数", 70), "angle": ("角度", 70),
            "scale": ("缩放", 60), "flip": ("翻面", 50), "decision": ("结论", 80),
        }
        for c, (text, width) in headings.items():
            self.tree.heading(c, text=text)
            self.tree.column(c, width=width, anchor=tk.CENTER)
        self.tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        sb = ttk.Scrollbar(list_frame, command=self.tree.yview)
        sb.pack(side=tk.RIGHT, fill=tk.Y)
        self.tree.configure(yscrollcommand=sb.set)
        self.tree.bind("<<TreeviewSelect>>", self._on_select)
        self.tree.bind("<Double-1>", self._open_comparison)

        decide = ttk.Frame(right)
        decide.pack(fill=tk.X)
        ttk.Button(decide, text="✓ 确实匹配", command=lambda: self._decide("confirmed")).pack(
            side=tk.LEFT, expand=True, fill=tk.X)
        ttk.Button(decide, text="✗ 误报", command=lambda: self._decide("false_positive")).pack(
            side=tk.LEFT, expand=True, fill=tk.X)
        ttk.Button(decide, text="撤销", command=lambda: self._decide("candidate")).pack(
            side=tk.LEFT, expand=True, fill=tk.X)

        nav = ttk.Frame(right)
        nav.pack(fill=tk.X, pady=(6, 0))
        ttk.Button(nav, text="上一张图", command=lambda: self._switch_image(-1)).pack(
            side=tk.LEFT, expand=True, fill=tk.X)
        ttk.Button(nav, text="下一张图", command=lambda: self._switch_image(1)).pack(
            side=tk.LEFT, expand=True, fill=tk.X)
        self.count_lab = ttk.Label(right, text="", justify=tk.LEFT)
        self.count_lab.pack(anchor=tk.W, pady=(6, 0))

        self._image_files: list[Path] = []
        self._image_index = -1

    def _spin(self, parent, key, label, default, lo, hi, increment: float = 0.1) -> None:
        row = ttk.Frame(parent)
        row.pack(fill=tk.X, pady=1)
        ttk.Label(row, text=label, width=10).pack(side=tk.LEFT)
        var = tk.StringVar(value=str(default))
        ttk.Spinbox(
            row, from_=lo, to=hi, increment=increment, textvariable=var, width=8
        ).pack(side=tk.RIGHT)
        self.vars[key] = var

    # ----------------------------------------------------------- 文件操作
    def ask_open_image(self) -> None:
        path = filedialog.askopenfilename(
            filetypes=[("图片", "*.png *.jpg *.jpeg *.bmp *.tif *.tiff"), ("所有文件", "*.*")]
        )
        if path:
            self.open_image(path)

    def open_image(self, path: str) -> None:
        try:
            img = load_image(path)
        except FileNotFoundError as exc:
            messagebox.showerror("打不开", str(exc))
            return
        self._save_current_state()
        self.image = img
        self.image_path = str(Path(path).resolve())
        self.image_key = image_identity(path, img.shape)
        p = Path(path)
        folder = p.parent
        self._image_files = sorted(
            q for q in folder.iterdir()
            if q.suffix.lower() in {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"}
        )
        self._image_index = self._image_files.index(p) if p in self._image_files else -1
        self.state = self.store.get_state(self.image_key, self.image_path)
        self.thr_var.set(self.state.last_threshold or 0.6)
        self._fit_view()
        self._render()
        self._refresh_list()

    def ask_extract_template(self) -> None:
        path = filedialog.askopenfilename(
            filetypes=[("图片", "*.png *.jpg *.jpeg *.bmp"), ("所有文件", "*.*")]
        )
        if not path:
            return
        img = load_image(path)
        dlg = ExtractDialog(self.root, img, path)
        self.root.wait_window(dlg)
        if dlg.result is not None:
            self.template = dlg.result
            self._show_template_preview()
            messagebox.showinfo("模板已载入", "可再用“保存模板 PNG”存成文件复用。")

    def ask_open_template(self) -> None:
        path = filedialog.askopenfilename(filetypes=[("PNG 模板", "*.png"), ("所有文件", "*.*")])
        if path:
            self._load_template(path)

    def _load_template(self, path: str) -> None:
        self.template = load_template(path)
        self._show_template_preview()

    def save_template_as(self) -> None:
        if not self.template:
            messagebox.showwarning("提示", "还没有模板")
            return
        path = filedialog.asksaveasfilename(defaultextension=".png", initialfile="template.png")
        if path:
            save_template(self.template, path)

    def _show_template_preview(self) -> None:
        if not self.template:
            return
        self._tpl_photo = _cv_to_photo(template_preview(self.template, 240))
        self.tpl_preview.configure(image=self._tpl_photo, text="")

    # ----------------------------------------------------------- 查找
    def _current_params(self) -> SearchParams:
        v = self.vars
        return SearchParams(
            min_angle=float(v["min_angle"].get()),
            max_angle=float(v["max_angle"].get()),
            angle_step=float(v["angle_step"].get()),
            min_scale=float(v["min_scale"].get()),
            max_scale=float(v["max_scale"].get()),
            num_scales=int(float(v["num_scales"].get())),
            allow_flip=self.flip_var.get(),
            score_threshold=float(self.thr_var.get()),
        )

    def run_search(self) -> None:
        if self._busy:
            return
        if self.image is None or self.template is None:
            messagebox.showwarning("提示", "请先打开目标图并载入/圈出模板")
            return
        if float(self.vars["max_scale"].get()) < float(self.vars["min_scale"].get()):
            messagebox.showerror("参数错误", "最大缩放不能小于最小缩放")
            return
        self._busy = True
        self.run_btn.configure(state=tk.DISABLED)
        params = self._current_params()
        total = max(1, params.pose_count())
        self.progress.configure(maximum=total, value=0)

        def progress_cb(done, tot, msg):
            self.root.after(0, lambda: self._progress(done, tot, msg))

        params.progress = progress_cb
        worker = threading.Thread(target=self._search_worker, args=(params,), daemon=True)
        worker.start()

    def _progress(self, done: int, total: int, msg: str) -> None:
        self.progress.configure(maximum=total, value=done)
        self.progress_lab.configure(text=msg)

    def _search_worker(self, params: SearchParams) -> None:
        try:
            matches = find_matches(self.template, self.image, params)
        except Exception as exc:  # noqa: BLE001 - 回主线程弹窗
            self.root.after(0, lambda: messagebox.showerror("查找失败", repr(exc)))
            self.root.after(0, self._unbusy)
            return
        self.root.after(0, lambda: self._after_search(matches, params))

    def _after_search(self, matches: list[Match], params: SearchParams) -> None:
        tol = 0.6 * min(self.template.width, self.template.height)
        self.store.replace_matches(
            self.state,
            matches,
            params={
                "min_angle": params.min_angle, "max_angle": params.max_angle,
                "angle_step": params.angle_step, "min_scale": params.min_scale,
                "max_scale": params.max_scale, "num_scales": params.num_scales,
                "allow_flip": params.allow_flip,
            },
            threshold=params.score_threshold,
            position_tol_px=tol,
        )
        self.store.save()
        self.store.apply_threshold_filter(self.state, float(self.thr_var.get()))
        self._unbusy()
        self._render()
        self._refresh_list()

    def _unbusy(self) -> None:
        self._busy = False
        self.run_btn.configure(state=tk.NORMAL)
        self.progress_lab.configure(text="完成")

    # ----------------------------------------------------------- 阈值与决策
    def _on_threshold(self, _value: str | None = None) -> None:
        t = float(self.thr_var.get())
        self.thr_lab.configure(text=f"当前阈值: {t:.2f}")
        if self.state:
            self.store.apply_threshold_filter(self.state, t)
            self.store.save()
            self._render()
            self._refresh_list()

    def _selected_match(self) -> Match | None:
        sel = self.tree.selection()
        if not sel:
            return None
        match_id = sel[0]
        return next((m for m in self.state.matches if m.id == match_id), None)

    def _decide(self, decision: str) -> None:
        m = self._selected_match()
        if not m:
            messagebox.showinfo("提示", "先在列表里选一个候选")
            return
        self.store.set_decision(self.state, m.id, decision)
        self.store.save()
        self._render()
        self._refresh_list(keep_select=m.id)

    def _open_comparison(self, _event=None) -> None:
        m = self._selected_match()
        if not m or not self.template:
            return
        panel = comparison_panel(self.image, self.template, m)
        win = tk.Toplevel(self.root)
        win.title(f"局部对照 {m.id}")
        photo = _cv_to_photo(panel, max_side=1100)
        lab = ttk.Label(win, image=photo)
        lab.image = photo
        lab.pack()

    # ----------------------------------------------------------- 列表与画布
    def _refresh_list(self, keep_select: str | None = None) -> None:
        for row in self.tree.get_children():
            self.tree.delete(row)
        if not self.state:
            self.count_lab.configure(text="")
            return
        for m in self.state.matches:
            if m.hidden:
                continue
            self.tree.insert(
                "", tk.END, iid=m.id,
                values=(m.id, f"{m.score:.3f}", f"{m.angle:.1f}", f"{m.scale:.2f}",
                        "是" if m.flipped else "",
                        {"confirmed": "确认", "false_positive": "误报", "candidate": "待复核"}[m.decision]),
            )
        c = self.state.counts()
        hidden = sum(1 for m in self.state.matches if m.hidden)
        self.count_lab.configure(
            text=(f"可见候选 {c['total'] - hidden}（隐藏 {hidden}）\n"
                  f"确认 {c['confirmed']}  误报 {c['false_positive']}  待复核 {c['candidate']}")
        )
        if keep_select and self.tree.exists(keep_select):
            self.tree.selection_set(keep_select)

    def _on_select(self, _event=None) -> None:
        self._render()

    def _render(self) -> None:
        self.canvas.delete("all")
        if self.image is None:
            return
        annotated = self.image
        if self.state and self.state.matches:
            annotated = draw_all(self.image, self.state.matches)
        # 选中项高亮加粗描边
        m = self._selected_match()
        if m:
            pts = np.round(m.bbox).astype(np.int32).reshape(-1, 1, 2)
            cv2.polylines(annotated, [pts], True, (255, 255, 0), 3)
        zoomed = cv2.resize(
            annotated, None, fx=self._zoom, fy=self._zoom, interpolation=cv2.INTER_NEAREST
        )
        self._photo = _cv_to_photo(zoomed)
        self.canvas.create_image(0, 0, anchor=tk.NW, image=self._photo)
        self.canvas.configure(scrollregion=self.canvas.bbox(tk.ALL))
        self.status.configure(
            text=f"{self.image_path}  {self.image.shape[1]}x{self.image.shape[0]}  缩放 {self._zoom:.2f}x"
        )

    def _fit_view(self) -> None:
        if self.image is None:
            return
        self.update_idletasks_safe()
        w = max(400, self.canvas.winfo_width() or 900)
        h = max(300, self.canvas.winfo_height() or 650)
        self._zoom = min(w / self.image.shape[1], h / self.image.shape[0], 1.0)

    def update_idletasks_safe(self) -> None:
        self.root.update_idletasks()

    def _wheel(self, event) -> None:
        factor = 1.15 if event.delta > 0 else 1 / 1.15
        self._zoom = float(np.clip(self._zoom * factor, 0.1, 12.0))
        self._render()

    def _pan_start(self, event) -> None:
        self.canvas.scan_mark(event.x, event.y)

    def _pan_move(self, event) -> None:
        self.canvas.scan_dragto(event.x, event.y, gain=1)

    def _canvas_click(self, event) -> None:
        if not self.state or self.image is None:
            return
        # 画布坐标 -> 原图坐标，点中候选则选中它
        cx = self.canvas.canvasx(event.x) / self._zoom
        cy = self.canvas.canvasy(event.y) / self._zoom
        best, best_d = None, 0.5 * min(self.template.width, self.template.height) if self.template else 30
        for m in self.state.matches:
            if m.hidden:
                continue
            d = float(np.hypot(m.x - cx, m.y - cy))
            if d < best_d:
                best, best_d = m, d
        if best:
            self.tree.selection_set(best.id)
            self._render()

    # ----------------------------------------------------------- 切图/导出
    def _switch_image(self, delta: int) -> None:
        if not self._image_files:
            return
        idx = (self._image_index + delta) % len(self._image_files)
        self.open_image(str(self._image_files[idx]))

    def _save_current_state(self) -> None:
        if self.store and self.state:
            self.store.save()

    def export_current(self) -> None:
        if not self.state or self.image is None:
            messagebox.showwarning("提示", "没有可导出的结果")
            return
        out = filedialog.askdirectory(initialdir=str(self.state_path.parent), mustexist=False)
        if not out:
            return
        paths = export_results(self.state, self.image, out, template=self.template)
        self.store.save()
        messagebox.showinfo("导出完成", "\n".join(f"{k}: {v}" for k, v in paths.items()))


def run_gui(initial_image: str | None = None, initial_template: str | None = None,
            state_path: str = "markfinder_out/review_state.json") -> int:
    root = tk.Tk()
    MarkFinderApp(root, initial_image, initial_template, state_path)
    root.mainloop()
    return 0
