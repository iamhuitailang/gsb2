"""页 5：保存与工程管理（需求 5）。

保存内容：
- project.json：原图相对引用与顺序、配准矩阵与状态、矢量 pin、全部参数
- cache.npz：清晰度栈/标签/权重（重开后点击回看无需立即重算）
- sources/：源图副本（工程可整体迁移）
- composite.png / source_map.png：合成图与来源图
另支持单独导出 PNG。
"""
from __future__ import annotations

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from .project import CACHE_FILE, COMPOSITE_FILE, PROJECT_FILE, SOURCE_MAP_FILE


class SaveTab(ttk.Frame):
    def __init__(self, master, state, app):
        super().__init__(master)
        self.state = state
        self.app = app
        self._build()

    def _build(self):
        wrap = ttk.Frame(self, padding=16)
        wrap.pack(fill="both", expand=True)

        ttk.Button(wrap, text="保存工程到文件夹…", style="Accent.TButton",
                   command=self._save_project).pack(anchor="w", pady=4)
        ttk.Button(wrap, text="打开工程…", command=self._open_project).pack(anchor="w", pady=4)
        ttk.Separator(wrap, orient="horizontal").pack(fill="x", pady=10)
        ttk.Button(wrap, text="导出合成图 PNG…",
                   command=lambda: self._export("composite")).pack(anchor="w", pady=4)
        ttk.Button(wrap, text="导出来源图 PNG…",
                   command=lambda: self._export("source_map")).pack(anchor="w", pady=4)

        self.info = ttk.Label(wrap, text="", justify="left")
        self.info.pack(anchor="w", pady=(16, 0))

    def _save_project(self):
        if not self.state.result:
            messagebox.showinfo("提示", "请先完成一次合成")
            return
        initial = self.state.project_dir or filedialog.askdirectory(
            title="选择工程保存文件夹（建议新建空文件夹）")
        if not initial:
            return
        try:
            path = self.state.save_project(initial)
        except Exception as exc:  # noqa: BLE001
            messagebox.showerror("保存失败", str(exc))
            return
        self._show_info(initial)
        self.app.set_status(f"工程已保存：{initial}")

    def _open_project(self):
        d = filedialog.askdirectory(title="选择工程文件夹")
        if not d:
            return
        try:
            self.state.open_project(d)
        except Exception as exc:  # noqa: BLE001
            messagebox.showerror("打开失败", str(exc))
            return
        self.app.after_open_project(d)

    def _export(self, kind):
        if not self.state.result:
            messagebox.showinfo("提示", "请先完成一次合成")
            return
        path = filedialog.asksaveasfilename(
            defaultextension=".png",
            initialfile="composite.png" if kind == "composite" else "source_map.png",
            filetypes=[("PNG", "*.png")])
        if not path:
            return
        if kind == "composite":
            out = self.state.export_composite(path)
        else:
            out = self.state.export_source_map(path)
        self.app.set_status(f"已导出：{out}")

    def _show_info(self, root):
        import os
        lines = [f"工程目录：{root}", ""]
        for name, desc in [
            (PROJECT_FILE, "原图引用/顺序、配准矩阵、pin、参数"),
            (CACHE_FILE, "清晰度栈、标签、权重缓存（可删除后重算）"),
            (COMPOSITE_FILE, "合成图 PNG"),
            (SOURCE_MAP_FILE, "来源图 PNG"),
        ]:
            p = os.path.join(root, name)
            mark = "✓" if os.path.exists(p) else " "
            lines.append(f"[{mark}] {name:<16} {desc}")
        src_dir = os.path.join(root, "sources")
        if os.path.isdir(src_dir):
            lines.append(f"[✓] sources/         源图副本 {len(os.listdir(src_dir))} 张")
        self.info.configure(text="\n".join(lines))

    def refresh_after_run(self):
        if self.state.project_dir:
            self._show_info(self.state.project_dir)
