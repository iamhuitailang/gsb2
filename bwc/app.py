"""tkinter 图形界面。

左侧控制面板(输入/阈值预览、连通性、处理步骤与顺序、约束、历史),
右侧画布(原图/结果/变化/三联/编号视图 + 点击拾取), 底部状态栏。
所有重活都在 pipeline/morphology/render 里, 本文件只做交互编排。
"""

from __future__ import annotations

import os
import sys
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

import numpy as np
from PIL import ImageTk

# 支持 `python -I bwc/app.py` 直跑
if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from bwc import export as exp
    from bwc import render
    from bwc.pipeline import (
        NoMergeConstraint,
        PreserveHoleConstraint,
        Project,
        Step,
        StepKind,
    )
    from bwc.sample import make_sample
else:
    from . import export as exp
    from . import render
    from .pipeline import (
        NoMergeConstraint,
        PreserveHoleConstraint,
        Project,
        Step,
        StepKind,
    )
    from .sample import make_sample

CANVAS_W = 620
CANVAS_H = 520

VIEW_MODES = [
    ("binary", "二值结果"),
    ("gray", "灰度原图"),
    ("diff", "变化像素"),
    ("triple", "三联对照"),
    ("labels", "编号标注"),
]


class App:
    def __init__(self, root: tk.Tk, image_path: str | None = None):
        self.root = root
        root.title("黑白图清理对照工具")
        root.geometry("1180x780")

        self.project: Project | None = None
        self.view_mode = tk.StringVar(value="binary")
        self.pick_mode = tk.StringVar(value="none")   # none|component|hole
        self.picked_components: list[int] = []
        self.drag_start = None
        self._photo = None  # 防止 PhotoImage 被 GC

        self._build_layout()
        if image_path:
            self._load_path(image_path)
        else:
            self._load_sample()

    # ------------------------------------------------------------------
    # 布局
    # ------------------------------------------------------------------
    def _build_layout(self) -> None:
        main = ttk.PanedWindow(self.root, orient=tk.HORIZONTAL)
        main.pack(fill=tk.BOTH, expand=True)

        left = ttk.Frame(main, width=380)
        right = ttk.Frame(main)
        main.add(left, weight=0)
        main.add(right, weight=1)

        self._build_controls(left)
        self._build_canvas(right)
        self.status = tk.StringVar(value="就绪")
        ttk.Label(self.root, textvariable=self.status, relief=tk.SUNKEN,
                  anchor=tk.W).pack(fill=tk.X, side=tk.BOTTOM)

    def _build_controls(self, parent: ttk.Frame) -> None:
        canvas = tk.Canvas(parent, width=372, highlightthickness=0)
        scroll = ttk.Scrollbar(parent, orient=tk.VERTICAL, command=canvas.yview)
        body = ttk.Frame(canvas)
        body.bind("<Configure>",
                  lambda _e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.create_window((0, 0), window=body, anchor="nw")
        canvas.configure(yscrollcommand=scroll.set)
        canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scroll.pack(side=tk.RIGHT, fill=tk.Y)

        row = 0

        # 输入
        box = ttk.LabelFrame(body, text="1. 输入与阈值")
        box.grid(row=row, column=0, sticky="ew", padx=6, pady=4)
        row += 1
        ttk.Button(box, text="读取本地图片…", command=self._open_file).grid(
            row=0, column=0, padx=4, pady=4, sticky="ew")
        ttk.Button(box, text="生成样例图", command=self._load_sample).grid(
            row=0, column=1, padx=4, pady=4, sticky="ew")
        ttk.Label(box, text="二值阈值(灰度≤阈值算黑):").grid(
            row=1, column=0, columnspan=2, sticky="w", padx=4)
        self.threshold = tk.IntVar(value=128)
        self.threshold_scale = ttk.Scale(box, from_=1, to=254, orient=tk.HORIZONTAL,
                                         variable=self.threshold,
                                         command=self._on_threshold)
        self.threshold_scale.grid(row=2, column=0, sticky="ew", padx=4)
        self.threshold_label = ttk.Label(box, text="128", width=5)
        self.threshold_label.grid(row=2, column=1, padx=4)
        box.columnconfigure(0, weight=1)

        # 连通性
        box = ttk.LabelFrame(body, text="2. 对角接触算连上还是分开")
        box.grid(row=row, column=0, sticky="ew", padx=6, pady=4)
        row += 1
        self.connectivity = tk.IntVar(value=8)
        ttk.Radiobutton(box, text="4-连通: 对角相接算分开", value=4,
                        variable=self.connectivity,
                        command=self._on_connectivity).grid(
            row=0, column=0, padx=4, pady=2, sticky="w")
        ttk.Radiobutton(box, text="8-连通: 对角相接算连上", value=8,
                        variable=self.connectivity,
                        command=self._on_connectivity).grid(
            row=1, column=0, padx=4, pady=2, sticky="w")

        # 处理步骤
        box = ttk.LabelFrame(body, text="3. 处理步骤(自上而下执行)")
        box.grid(row=row, column=0, sticky="ew", padx=6, pady=4)
        row += 1
        ttk.Button(box, text="＋ 去毛刺(开运算)",
                   command=lambda: self._add_step(StepKind.OPENING)).grid(
            row=0, column=0, columnspan=2, sticky="ew", padx=4, pady=2)
        ttk.Button(box, text="＋ 补短缝(闭运算)",
                   command=lambda: self._add_step(StepKind.CLOSING)).grid(
            row=1, column=0, columnspan=2, sticky="ew", padx=4, pady=2)
        ttk.Button(box, text="＋ 移除小孤岛",
                   command=lambda: self._add_step(StepKind.REMOVE_SMALL)).grid(
            row=2, column=0, columnspan=2, sticky="ew", padx=4, pady=2)

        self.steps_list = tk.Listbox(box, height=5, activestyle="dotbox")
        self.steps_list.grid(row=3, column=0, columnspan=2, sticky="ew", padx=4, pady=4)
        btns = ttk.Frame(box)
        btns.grid(row=4, column=0, columnspan=2, sticky="ew")
        ttk.Button(btns, text="上移", command=lambda: self._move_step(-1)).pack(
            side=tk.LEFT, expand=True, fill=tk.X, padx=2)
        ttk.Button(btns, text="下移", command=lambda: self._move_step(1)).pack(
            side=tk.LEFT, expand=True, fill=tk.X, padx=2)
        ttk.Button(btns, text="删除", command=self._remove_step).pack(
            side=tk.LEFT, expand=True, fill=tk.X, padx=2)

        param = ttk.Frame(box)
        param.grid(row=5, column=0, columnspan=2, sticky="ew", padx=4, pady=2)
        ttk.Label(param, text="半径 r:").pack(side=tk.LEFT)
        self.radius_var = tk.IntVar(value=1)
        ttk.Spinbox(param, from_=1, to=20, width=4,
                    textvariable=self.radius_var,
                    command=self._update_step_params).pack(side=tk.LEFT, padx=2)
        ttk.Label(param, text="孤岛阈值 px:").pack(side=tk.LEFT)
        self.minsize_var = tk.IntVar(value=20)
        ttk.Spinbox(param, from_=1, to=100000, width=7,
                    textvariable=self.minsize_var,
                    command=self._update_step_params).pack(side=tk.LEFT, padx=2)
        ttk.Button(box, text="应用参数到选中步骤",
                   command=self._update_step_params).grid(
            row=6, column=0, columnspan=2, sticky="ew", padx=4, pady=2)
        box.columnconfigure(0, weight=1)

        # 约束
        box = ttk.LabelFrame(body, text="4. 约束(在图上拾取)")
        box.grid(row=row, column=0, sticky="ew", padx=6, pady=4)
        row += 1
        ttk.Button(box, text="拾取两个连通块→禁并",
                   command=lambda: self._set_pick("component")).grid(
            row=0, column=0, columnspan=2, sticky="ew", padx=4, pady=2)
        ttk.Button(box, text="拖拽框选小孔→保留",
                   command=lambda: self._set_pick("hole")).grid(
            row=1, column=0, columnspan=2, sticky="ew", padx=4, pady=2)
        self.pick_hint = ttk.Label(box, text="拾取模式: 关", foreground="#a00")
        self.pick_hint.grid(row=2, column=0, columnspan=2, sticky="w", padx=4)
        self.constraint_list = tk.Listbox(box, height=4)
        self.constraint_list.grid(row=3, column=0, columnspan=2,
                                  sticky="ew", padx=4, pady=4)
        ttk.Button(box, text="删除选中约束",
                   command=self._remove_constraint).grid(
            row=4, column=0, columnspan=2, sticky="ew", padx=4, pady=2)
        box.columnconfigure(0, weight=1)

        # 历史
        box = ttk.LabelFrame(body, text="5. 历史版本(撤回)")
        box.grid(row=row, column=0, sticky="ew", padx=6, pady=4)
        row += 1
        self.history_list = tk.Listbox(box, height=6)
        self.history_list.grid(row=0, column=0, columnspan=2,
                               sticky="ew", padx=4, pady=4)
        self.history_list.bind("<<ListboxSelect>>", self._on_history_select)
        box.columnconfigure(0, weight=1)

        # 导出
        box = ttk.LabelFrame(body, text="6. 导出")
        box.grid(row=row, column=0, sticky="ew", padx=6, pady=4)
        row += 1
        ttk.Button(box, text="导出干净图+面积清单+元数据…",
                   command=self._export).grid(row=0, column=0, columnspan=2,
                                              sticky="ew", padx=4, pady=2)
        ttk.Button(box, text="回读校验导出图",
                   command=self._verify).grid(row=1, column=0, columnspan=2,
                                              sticky="ew", padx=4, pady=2)
        box.columnconfigure(0, weight=1)
        body.columnconfigure(0, weight=1)

    def _build_canvas(self, parent: ttk.Frame) -> None:
        bar = ttk.Frame(parent)
        bar.pack(fill=tk.X, padx=6, pady=4)
        ttk.Label(bar, text="视图:").pack(side=tk.LEFT)
        for value, text in VIEW_MODES:
            ttk.Radiobutton(bar, text=text, value=value,
                            variable=self.view_mode,
                            command=self.refresh).pack(side=tk.LEFT, padx=4)

        self.canvas = tk.Canvas(parent, width=CANVAS_W, height=CANVAS_H,
                                bg="#888", highlightthickness=0)
        self.canvas.pack(fill=tk.BOTH, expand=True, padx=6, pady=6)
        self.canvas.bind("<Button-1>", self._on_canvas_down)
        self.canvas.bind("<B1-Motion>", self._on_canvas_drag)
        self.canvas.bind("<ButtonRelease-1>", self._on_canvas_up)

        self.stats_var = tk.StringVar(value="")
        ttk.Label(parent, textvariable=self.stats_var, justify=tk.LEFT,
                  font=("Menlo", 11)).pack(fill=tk.X, padx=8, pady=4)

    # ------------------------------------------------------------------
    # 项目加载
    # ------------------------------------------------------------------
    def _new_project(self, gray: np.ndarray, name: str) -> None:
        self.project = Project(gray, threshold=self.threshold.get(),
                               connectivity=self.connectivity.get(), name=name)
        self.picked_components.clear()
        self.pick_mode.set("none")
        self.refresh()

    def _open_file(self) -> None:
        path = filedialog.askopenfilename(
            title="选择灰度/黑白图片",
            filetypes=[("图片", "*.png *.tif *.tiff *.bmp *.jpg *.jpeg"),
                       ("所有文件", "*.*")])
        if path:
            self._load_path(path)

    def _load_path(self, path: str) -> None:
        try:
            gray = render.load_gray(path)
        except Exception as exc:  # noqa: BLE001 - GUI 顶层兜底
            messagebox.showerror("读取失败", str(exc))
            return
        self._new_project(gray, os.path.basename(path))
        self._set_status(f"已载入 {path}  尺寸={gray.shape}")

    def _load_sample(self) -> None:
        gray = make_sample()
        self._new_project(gray, "样例图")
        self._set_status("已生成样例: 含细线/孔洞/对角块/毛刺/孤岛/窄缝")

    # ------------------------------------------------------------------
    # 参数回调
    # ------------------------------------------------------------------
    def _on_threshold(self, _value=None) -> None:
        if self.project is None:
            return
        t = int(round(float(self.threshold_scale.get())))
        self.threshold_label.config(text=str(t))
        if t != self.project.threshold:
            # 阈值变了基线重建, 约束保留并在新版本上重新追踪
            self.project.set_threshold(t)
            self.picked_components.clear()
            self.refresh()

    def _on_connectivity(self) -> None:
        if self.project is None:
            return
        self.project.set_connectivity(int(self.connectivity.get()))
        self.picked_components.clear()
        self.refresh()

    def _add_step(self, kind: StepKind) -> None:
        if self.project is None:
            return
        step = Step(kind=kind, radius=int(self.radius_var.get()),
                    min_size=int(self.minsize_var.get()))
        self.project.add_step(step)
        self.refresh()

    def _selected_step_index(self) -> int | None:
        sel = self.steps_list.curselection()
        return sel[0] if sel else None

    def _move_step(self, delta: int) -> None:
        idx = self._selected_step_index()
        if idx is None:
            return
        self.project.move_step(idx, delta)
        self.refresh()
        self.steps_list.selection_clear(0, tk.END)
        new_idx = max(0, min(len(self.project.steps) - 1, idx + delta))
        self.steps_list.selection_set(new_idx)

    def _remove_step(self) -> None:
        idx = self._selected_step_index()
        if idx is None:
            return
        self.project.remove_step(idx)
        self.refresh()

    def _update_step_params(self) -> None:
        idx = self._selected_step_index()
        if idx is None or self.project is None:
            return
        step = self.project.steps[idx]
        params = {}
        if step.kind in (StepKind.OPENING, StepKind.CLOSING):
            params["radius"] = max(1, int(self.radius_var.get()))
        else:
            params["min_size"] = max(1, int(self.minsize_var.get()))
        self.project.update_step(idx, **params)
        self.refresh()
        self.steps_list.selection_set(idx)

    # ------------------------------------------------------------------
    # 画布拾取
    # ------------------------------------------------------------------
    def _set_pick(self, mode: str) -> None:
        self.pick_mode.set(mode)
        self.picked_components.clear()
        self.drag_start = None
        if mode == "component":
            self.pick_hint.config(text="拾取: 请在图上点第 1 个连通块")
        elif mode == "hole":
            self.pick_hint.config(text="拾取: 在要保留的孔上拖拽画框")
        self.canvas.delete("pickrect")

    def _canvas_to_image(self, event) -> tuple[int, int]:
        """画布坐标 -> 原图坐标(按显示缩放比反算)。"""
        v = self.project.current
        h, w = v.mask.shape
        scale = min(CANVAS_W / w, CANVAS_H / h)
        ox = max(0, (CANVAS_W - w * scale) / 2)
        oy = max(0, (CANVAS_H - h * scale) / 2)
        x = int((event.x - ox) / scale)
        y = int((event.y - oy) / scale)
        return min(max(y, 0), h - 1), min(max(x, 0), w - 1)

    def _on_canvas_down(self, event) -> None:
        if self.project is None or self.pick_mode.get() == "none":
            return
        y, x = self._canvas_to_image(event)
        if self.pick_mode.get() == "component":
            lab = int(self.project.current.labels[y, x])
            if lab == 0:
                self._set_status("点到的是背景, 请点在黑色连通块上")
                return
            if lab in self.picked_components:
                return
            self.picked_components.append(lab)
            if len(self.picked_components) == 1:
                self.pick_hint.config(text=f"拾取: 已选块 {lab}, 再点第 2 个")
                self.refresh()
            else:
                a, b = self.picked_components
                try:
                    self.project.add_no_merge(a, b)
                    self._set_status(f"已加禁并约束: 块 {a} 与块 {b}")
                except ValueError as exc:
                    messagebox.showwarning("无法添加约束", str(exc))
                self.pick_mode.set("none")
                self.picked_components.clear()
                self.pick_hint.config(text="拾取模式: 关")
                self.refresh()
        else:  # hole 拖拽
            self.drag_start = (y, x)

    def _on_canvas_drag(self, event) -> None:
        if self.pick_mode.get() != "hole" or self.drag_start is None:
            return
        y, x = self._canvas_to_image(event)
        y0, x0 = self.drag_start
        h, w = self.project.current.mask.shape
        scale = min(CANVAS_W / w, CANVAS_H / h)
        ox = max(0, (CANVAS_W - w * scale) / 2)
        oy = max(0, (CANVAS_H - h * scale) / 2)
        self.canvas.delete("pickrect")
        self.canvas.create_rectangle(
            ox + x0 * scale, oy + y0 * scale,
            ox + x * scale, oy + y * scale,
            outline=(0, 200, 100), width=2, tags="pickrect")

    def _on_canvas_up(self, event) -> None:
        if self.pick_mode.get() != "hole" or self.drag_start is None:
            return
        y1, x1 = self._canvas_to_image(event)
        y0, x0 = self.drag_start
        self.drag_start = None
        if abs(y1 - y0) + abs(x1 - x0) < 3:
            self._set_status("框太小, 请拖拽出一个覆盖小孔的矩形")
            return
        c = self.project.add_preserve_hole((y0, x0, y1, x1))
        self._set_status(f"已加保留孔约束: 框 {c.rect}")
        self.pick_mode.set("none")
        self.pick_hint.config(text="拾取模式: 关")
        self.canvas.delete("pickrect")
        self.refresh()

    # ------------------------------------------------------------------
    # 历史
    # ------------------------------------------------------------------
    def _remove_constraint(self) -> None:
        sel = self.constraint_list.curselection()
        if not sel or self.project is None:
            return
        self.project.remove_constraint(sel[0])
        self.refresh()
        self._set_status(f"已删除约束 #{sel[0] + 1}")

    def _on_history_select(self, _event=None) -> None:
        sel = self.history_list.curselection()
        if not sel or self.project is None:
            return
        idx = sel[0]
        if idx == self.project.cursor:
            return
        self.project.rollback(idx)
        self._set_status(f"撤回到版本 {idx}: {self.project.current.name}")
        self.refresh(keep_history_selection=idx)

    # ------------------------------------------------------------------
    # 导出
    # ------------------------------------------------------------------
    def _export(self) -> None:
        if self.project is None:
            return
        d = filedialog.askdirectory(title="选择导出目录")
        if not d:
            return
        base = os.path.join(d, "bwc_clean")
        paths = exp.export_all(self.project, base)
        render.save_image(
            render.render_triple(self.project.gray, self.project.base.mask,
                                 self.project.current.mask),
            base + "_triple.png")
        self._set_status("已导出: " + ", ".join(os.path.basename(p) for p in paths.values()))
        messagebox.showinfo("导出完成", "\n".join(paths.values()))

    def _verify(self) -> None:
        if self.project is None:
            return
        d = filedialog.askdirectory(title="选择含导出图的目录")
        if not d:
            return
        clean = os.path.join(d, "bwc_clean_clean.png")
        if not os.path.exists(clean):
            messagebox.showwarning("找不到文件", clean)
            return
        report = exp.verify_roundtrip(self.project, clean)
        if report["ok"]:
            rb = report["readback"]
            messagebox.showinfo(
                "回读校验通过",
                f"连通块 {rb['n_components']}、孔洞 {rb['n_holes']}、"
                f"墨迹 {rb['ink_pixels']}px 与导出时完全一致")
        else:
            messagebox.showerror("回读校验失败", "\n".join(report["mismatches"]))
        self._set_status("回读校验: " + ("通过" if report["ok"] else "失败"))

    # ------------------------------------------------------------------
    # 刷新
    # ------------------------------------------------------------------
    def refresh(self, keep_history_selection: int | None = None) -> None:
        if self.project is None:
            return
        p = self.project
        v = p.current

        # 控件状态与项目同步(外部重建/撤回后保持一致)
        self.connectivity.set(p.connectivity)
        self.threshold.set(p.threshold)
        self.threshold_label.config(text=str(p.threshold))

        violations = p.violations_at()

        # 选图
        mode = self.view_mode.get()
        if mode == "gray":
            img = render.gray_to_image(p.gray)
        elif mode == "diff":
            img = render.render_diff(p.base.mask, v.mask)
        elif mode == "triple":
            img = render.render_triple(p.gray, p.base.mask, v.mask)
        elif mode == "labels":
            img = render.render_labels(v.mask, v.labels, v.n_components,
                                       v.component_stats, v.hole_labels,
                                       v.hole_stats)
        else:
            img = render.mask_to_image(v.mask)

        # 约束和违规叠在非三联视图上(三联太窄)
        if p.constraints and mode != "triple":
            img = render.render_constraints(img, p.constraints, violations)

        # 拾取过程中的临时高亮
        if self.picked_components and mode != "triple":
            from PIL import ImageDraw
            img = img.copy()
            draw = ImageDraw.Draw(img)
            for lab in self.picked_components:
                st = v.component_stats[lab]
                y0, x0, y1, x1 = st["bbox"]
                draw.rectangle([x0, y0, x1, y1], outline=(255, 0, 255), width=2)

        self._show_image(img)
        self._refresh_lists(violations, keep_history_selection)
        self._refresh_stats(violations)

    def _show_image(self, img) -> None:
        w, h = img.size
        scale = min(CANVAS_W / w, CANVAS_H / h)
        new_size = (max(1, int(w * scale)), max(1, int(h * scale)))
        resized = img.resize(new_size)
        self._photo = ImageTk.PhotoImage(resized)
        self.canvas.delete("all")
        self.canvas.create_image(CANVAS_W // 2, CANVAS_H // 2,
                                 image=self._photo, anchor=tk.CENTER)

    def _refresh_lists(self, violations, keep_history_selection) -> None:
        p = self.project

        self.steps_list.delete(0, tk.END)
        for i, step in enumerate(p.steps, start=1):
            self.steps_list.insert(tk.END, f"{i}. {step.describe()}")

        self.constraint_list.delete(0, tk.END)
        violated = {id(v.constraint) for v in violations}
        for i, c in enumerate(p.constraints):
            if isinstance(c, NoMergeConstraint):
                text = (f"禁并: 块{c.label_a} ↔ 块{c.label_b}")
            else:
                text = f"保留孔: 框{c.rect}"
            if id(c) in violated:
                text = "⚠ " + text
            self.constraint_list.insert(tk.END, text)

        self.history_list.delete(0, tk.END)
        for i, ver in enumerate(p.versions):
            marker = "▶ " if i == p.cursor else "   "
            self.history_list.insert(tk.END, f"{marker}v{i} {ver.name}")
        target = keep_history_selection if keep_history_selection is not None else p.cursor
        self.history_list.selection_clear(0, tk.END)
        self.history_list.selection_set(target)

    def _refresh_stats(self, violations) -> None:
        p = self.project
        v = p.current
        lines = [
            f"版本 v{p.cursor}: {v.name}",
            f"连通性={p.connectivity}  阈值={p.threshold}  "
            f"连通块={v.n_components}  孔洞={v.n_holes}  "
            f"墨迹像素={v.ink_pixels}  本步变化={v.changed_count}px",
            "各块面积: " + ", ".join(
                f"#{st['label']}={st['area']}" for st in v.component_stats[1:]),
        ]
        if v.hole_stats[1:]:
            lines.append("孔洞面积: " + ", ".join(
                f"H{st['hole']}={st['area']}" for st in v.hole_stats[1:]))
        if violations:
            lines.append("⚠ 约束违规:")
            for vio in violations:
                lines.append(f"  [{vio.kind}] {vio.detail}")
        else:
            lines.append("约束: 全部满足" if p.constraints else "约束: 未设置")
        self.stats_var.set("\n".join(lines))

    def _set_status(self, text: str) -> None:
        self.status.set(text)


def run_gui(image_path: str | None = None) -> int:
    root = tk.Tk()
    App(root, image_path)
    root.mainloop()
    return 0
