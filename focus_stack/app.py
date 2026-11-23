"""Tkinter 主窗口：组织 5 个页签 + 后台任务 + 样例生成。"""
from __future__ import annotations

import tempfile
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, ttk

from .app_state import AppState
from .samples import SAMPLE_SETS, generate_focus_stack
from .ui_tab_composite import CompositeTab
from .ui_tab_edges import EdgeTab
from .ui_tab_load import LoadTab
from .ui_tab_pins import PinTab
from .ui_tab_save import SaveTab


class FocusStackApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("本地多焦点照片合成工具（focus stacking）")
        self.geometry("1280x820")
        self.minsize(960, 640)
        self._setup_style()

        self.state_ = AppState(self)
        self._sample_root = Path(tempfile.gettempdir()) / "focus_stack_samples"

        self.nb = ttk.Notebook(self)
        self.nb.pack(fill="both", expand=True)
        self.tabs = {
            "load": LoadTab(self.nb, self.state_, self),
            "composite": CompositeTab(self.nb, self.state_, self),
            "pins": PinTab(self.nb, self.state_, self),
            "edges": EdgeTab(self.nb, self.state_, self),
            "save": SaveTab(self.nb, self.state_, self),
        }
        for key, tab in self.tabs.items():
            title = {
                "load": "1. 导入与配准",
                "composite": "2. 合成与回看",
                "pins": "3. 固定区域与重影",
                "edges": "4. 边缘检查",
                "save": "5. 保存",
            }[key]
            self.nb.add(tab, text=title)

        self.status = tk.StringVar(value="就绪：打开 3~5 张同场景图片，或生成自带样例")
        bar = ttk.Frame(self)
        bar.pack(fill="x", side="bottom")
        ttk.Separator(bar).pack(fill="x")
        ttk.Label(bar, textvariable=self.status, anchor="w",
                  padding=(8, 4)).pack(fill="x")

    def _setup_style(self):
        style = ttk.Style(self)
        # macOS 自带 aqua 主题不支持 Accent.TButton，做个容错
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure("Accent.TButton", font=("Helvetica", 12, "bold"))

    # ------------------------------------------------------------------ #
    def set_status(self, text: str):
        self.status.set(text)

    def make_samples(self, set_name: str):
        spec = SAMPLE_SETS[set_name]
        out = self._sample_root / set_name
        try:
            paths = generate_focus_stack(
                out, n=spec["n"], failure=spec["failure"])
            self.state_.load_sample_dir(paths)
        except Exception as exc:  # noqa: BLE001
            messagebox.showerror("样例生成失败", str(exc))
            return
        self.tabs["load"].refresh_files()
        self.set_status(f"已生成样例（{spec['description']}）：{out}")
        self.run_pipeline()

    def run_pipeline(self):
        if not self.state_.images:
            messagebox.showinfo("提示", "请先打开图片或生成样例")
            return
        self.set_status("后台计算中：配准 → 清晰度 → 选择 → 融合 …")
        self.configure(cursor="watch")

        def done(_result):
            self.configure(cursor="")
            for tab in self.tabs.values():
                if hasattr(tab, "refresh_after_run"):
                    tab.refresh_after_run()
            self.nb.select(self.tabs["composite"])

        def error(exc):
            self.configure(cursor="")
            messagebox.showerror("处理失败", str(exc))
            self.set_status(f"处理失败：{exc}")

        self.state_.run(on_done=done, on_error=error)

    def refresh_refusion(self):
        """只重算选择/融合（pin 改动、模式切换后），保留配准与其他 pin。"""
        if not self.state_.result:
            return
        try:
            self.state_.refusion()
        except Exception as exc:  # noqa: BLE001
            messagebox.showerror("融合失败", str(exc))
            return
        # 各页按自身可见内容刷新
        self.tabs["composite"].refresh_after_run()
        self.tabs["pins"].refresh_view()
        self.tabs["edges"].refresh_after_run()
        if hasattr(self.tabs["save"], "refresh_after_run"):
            self.tabs["save"].refresh_after_run()
        self.set_status("已按当前固定区域与参数重新融合")

    def after_open_project(self, project_dir: str):
        # 工程里保存了配准，直接跑管线（配准被复用）
        self.tabs["load"].refresh_files()
        self.run_pipeline()
        self.set_status(f"已打开工程：{project_dir}")


def main():
    app = FocusStackApp()
    app.mainloop()


if __name__ == "__main__":
    main()
