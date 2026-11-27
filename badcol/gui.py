"""matplotlib 交互视图。

功能:
- 同一视图切换不同帧, 以及 原图/修补后 对照;
- 下图为列剖面(每列灰度均值与检测残差), 直观看到坏列尖峰;
- 点击图中任意位置: 普通点击补选/取消补选(按当前帧 or 全帧),
  Shift+点击排除, 右键(或 Alt+点击)保护;
- 修补状态颜色区分可靠插值/边沿复制/不可靠/未修补/保护;
- 一键校验未选位置逐字节不变;
- 保存/加载坏列表, 导出修补图与统计。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import matplotlib

matplotlib.use("TkAgg")  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.widgets import Button, CheckButtons, RadioButtons, Slider  # noqa: E402

from .badlist import BadList, BadListError
from .detect import ColumnSelection, DetectionResult, detect_columns
from .io_utils import to_gray
from .repair import (
    EDGE_COPY,
    PROTECTED,
    REPAIRED,
    UNRELIABLE,
    UNREPAIRED,
    RepairConfig,
    repair_batch,
)
from .report import compare_with_clean, export_repaired, write_change_stats

STATE_COLORS = {
    REPAIRED: (0.2, 0.8, 0.2),
    EDGE_COPY: (1.0, 0.75, 0.1),
    UNRELIABLE: (1.0, 0.45, 0.1),
    UNREPAIRED: (0.9, 0.1, 0.1),
    PROTECTED: (0.3, 0.5, 1.0),
}


class BadColumnGUI:
    def __init__(
        self,
        frames: np.ndarray,
        frame_names: list[str],
        detection: DetectionResult,
        clean: np.ndarray | None = None,
        selection: ColumnSelection | None = None,
        repair_config: RepairConfig | None = None,
    ) -> None:
        if frames.ndim not in (3, 4):
            raise ValueError("frames 需为 (N,H,W) 或 (N,H,W,C)")
        self.frames = frames
        self.names = frame_names
        self.det = detection
        self.clean = clean
        self.sel = selection or ColumnSelection()
        self.repair_cfg = repair_config or RepairConfig()
        self.gray = frames if frames.ndim == 3 else np.stack(
            [to_gray(f) for f in frames]
        )
        self.idx = 0
        self.show_repaired = False
        self.mark_scope = "current"  # current | all
        self._repair_result = None
        self._build()

    # ---------- 界面搭建 ----------
    def _build(self) -> None:
        self.fig = plt.figure(figsize=(11.5, 9.5))
        self.ax_img = self.fig.add_axes([0.06, 0.56, 0.62, 0.38])
        self.ax_prof = self.fig.add_axes([0.06, 0.08, 0.62, 0.38])
        self.ax_img.set_title("")
        self.ax_prof.set_xlabel("列号")
        self.ax_prof.set_ylabel("列灰度均值 / 残差")

        x0, w0 = 0.72, 0.25
        self.ax_frame = self.fig.add_axes([0.06, 0.49, 0.62, 0.03])
        self.slider = Slider(
            self.ax_frame, "帧", 0, self.frames.shape[0] - 1,
            valinit=0, valstep=1,
        )
        self.slider.on_changed(self._on_slider)

        self.ax_view = self.fig.add_axes([x0, 0.80, w0, 0.12])
        self.radio_view = RadioButtons(
            self.ax_view, ["原图", "修补后"], active=0
        )
        self.radio_view.on_clicked(self._on_view)

        self.ax_scope = self.fig.add_axes([x0, 0.66, w0, 0.12])
        self.radio_scope = RadioButtons(
            self.ax_scope, ["点击标记: 当前帧", "点击标记: 所有帧"], active=0
        )
        self.radio_scope.on_clicked(self._on_scope)

        self.ax_check = self.fig.add_axes([x0, 0.52, w0, 0.12])
        self.checks = CheckButtons(
            self.ax_check,
            ["显示选中覆盖", "显示残差曲线"],
            [True, True],
        )
        self.checks.on_clicked(self._on_check)
        self.show_overlay = True
        self.show_resid = True

        buttons = [
            ("上一帧", self._prev),
            ("下一帧", self._next),
            ("立即修补", self._do_repair),
            ("校验未选位置不变", self._verify),
            ("保存坏列表…", self._save_badlist),
            ("加载坏列表…", self._load_badlist),
            ("导出修补图/统计…", self._export),
        ]
        self._buttons = []
        top, step = 0.46, 0.052
        for i, (label, cb) in enumerate(buttons):
            ax = self.fig.add_axes([x0, top - i * step, w0, 0.04])
            b = Button(ax, label)
            b.on_clicked(cb)
            self._buttons.append(b)

        self.status = self.fig.text(
            0.06, 0.025, "", fontsize=9, color="tab:blue", wrap=True
        )
        self.fig.canvas.mpl_connect("pick_event", self._on_pick)
        self.fig.canvas.mpl_connect("button_press_event", self._on_click)
        self.fig.canvas.mpl_connect("close_event", self._on_close)
        self._refresh()

    # ---------- 事件 ----------
    def _on_slider(self, val: float) -> None:
        self.idx = int(val)
        self._refresh()

    def _on_view(self, label: str) -> None:
        self.show_repaired = label == "修补后"
        if self.show_repaired and self._repair_result is None:
            self._do_repair()
        self._refresh()

    def _on_scope(self, label: str) -> None:
        self.mark_scope = "all" if "所有帧" in label else "current"

    def _on_check(self, label: str) -> None:
        if "覆盖" in label:
            self.show_overlay = not self.show_overlay
        if "残差" in label:
            self.show_resid = not self.show_resid
        self._refresh()

    def _prev(self, _event=None) -> None:
        self.idx = (self.idx - 1) % self.frames.shape[0]
        self.slider.set_val(self.idx)

    def _next(self, _event=None) -> None:
        self.idx = (self.idx + 1) % self.frames.shape[0]
        self.slider.set_val(self.idx)

    def _on_close(self, _event=None) -> None:
        self._repair_result = None

    def _on_pick(self, event) -> None:  # 保留扩展点
        pass

    def _on_click(self, event) -> None:
        if event.inaxes not in (self.ax_img, self.ax_prof) or event.xdata is None:
            return
        col = int(round(event.xdata))
        if not 0 <= col < self.frames.shape[2]:
            return
        if event.key == "shift":
            self.sel.toggle_exclude(col)
            msg = f"列 {col} 已{('恢复候选' if col not in self.sel.excluded else '排除')}"
        elif event.button == 3 or event.key == "alt":
            self.sel.toggle_protect(col)
            msg = f"列 {col} 保护状态切换: {col in self.sel.protected}"
        else:
            frames = None if self.mark_scope == "all" else [self.idx]
            self.sel.toggle_include(col, frames)
            msg = (
                f"列 {col} 补选(所有帧)"
                if frames is None
                else f"列 {col} 补选(仅帧 {self.idx})"
            )
            if col not in self.sel.included:
                msg = f"列 {col} 已取消补选"
        self._repair_result = None
        self._set_status(msg)
        self._refresh()

    # ---------- 修补与校验 ----------
    def _per_frame_selection(self) -> list[list[int]]:
        eff = self.sel.effective(self.det)
        per_frame = [[] for _ in range(self.frames.shape[0])]
        for col, frames in eff.items():
            targets = range(self.frames.shape[0]) if frames is None else frames
            for f in targets:
                if col not in self.sel.protected:
                    per_frame[f].append(col)
        return [sorted(set(x)) for x in per_frame]

    def _do_repair(self, _event=None) -> None:
        per_frame = self._per_frame_selection()
        self._repair_result = repair_batch(
            self.frames, per_frame, self.sel.protected, self.repair_cfg
        )
        unreliable = self._repair_result.unreliable_columns()
        if unreliable:
            self._set_status(
                "修补完成; 不可靠/未修补位置: "
                + ", ".join(f"帧{f}:{cols}" for f, cols in unreliable.items())
            )
        else:
            self._set_status("修补完成, 全部选中列均可可靠插值")
        self._refresh()

    def _verify(self, _event=None) -> None:
        from .repair import assert_unchanged

        if self._repair_result is None:
            self._do_repair()
        per_frame = self._per_frame_selection()
        try:
            assert_unchanged(
                self.frames, self._repair_result.repaired,
                per_frame, self.sel.protected,
            )
        except AssertionError as exc:
            self._set_status(f"校验失败: {exc}", bad=True)
            return
        n_touched = sum(len(c) for c in per_frame)
        self._set_status(
            f"校验通过: 共 {n_touched} 个(帧,列)被修改, 其余像素与原图完全一致"
        )

    # ---------- 坏列表与导出 ----------
    def _save_badlist(self, _event=None) -> None:
        from tkinter import Tk, filedialog

        root = Tk(); root.withdraw()
        path = filedialog.asksaveasfilename(
            defaultextension=".json", filetypes=[("坏列表", "*.json")]
        )
        root.destroy()
        if not path:
            return
        eff = self.sel.effective(self.det)
        bl = BadList.from_selection(
            eff, self.sel.protected,
            self.det.height, self.det.width, self.det.n_frames,
        )
        bl.save(path)
        self._set_status(f"坏列表已保存: {path}")

    def _load_badlist(self, _event=None) -> None:
        from tkinter import Tk, filedialog

        root = Tk(); root.withdraw()
        path = filedialog.askopenfilename(filetypes=[("坏列表", "*.json")])
        root.destroy()
        if not path:
            return
        try:
            bl = BadList.load(path)
            bl.check_shape(self.frames)
        except BadListError as exc:
            self._set_status(f"加载被拒绝: {exc}", bad=True)
            return
        self.sel = ColumnSelection(
            included={c: None for c in bl.persistent}
            | {d["col"]: d["frames"] for d in bl.intermittent},
            protected=set(bl.protected),
        )
        self._repair_result = None
        self._set_status(f"已应用坏列表: {path}")
        self._refresh()

    def _export(self, _event=None) -> None:
        from tkinter import Tk, filedialog

        if self._repair_result is None:
            self._do_repair()
        root = Tk(); root.withdraw()
        out = filedialog.askdirectory(title="选择导出目录")
        root.destroy()
        if not out:
            return
        out = Path(out)
        paths = export_repaired(out / "repaired", self.names, self._repair_result)
        write_change_stats(out / "change_stats.csv", self.names, self._repair_result)
        msg = f"已导出 {len(paths)} 张修补图与 change_stats.csv 到 {out}"
        if self.clean is not None:
            cmp_ = compare_with_clean(
                self.frames, self._repair_result.repaired, self.clean,
                self._per_frame_selection(), self.sel.protected,
            )
            from .report import write_comparison_report

            write_comparison_report(out / "clean_comparison.csv", cmp_)
            msg += (
                f"; 参考对比 恢复MAE={cmp_['recovery_mae']:.3f} "
                f"误伤MAE={cmp_['damage_mae']:.3f} [{cmp_['verdict']}]"
            )
        self._set_status(msg)

    # ---------- 重绘 ----------
    def _set_status(self, text: str, bad: bool = False) -> None:
        self.status.set_text(text)
        self.status.set_color("tab:red" if bad else "tab:blue")
        self.fig.canvas.draw_idle()

    def _current_image(self) -> np.ndarray:
        if self.show_repaired and self._repair_result is not None:
            return self._repair_result.repaired[self.idx]
        return self.frames[self.idx]

    def _refresh(self) -> None:
        self.ax_img.cla()
        img = self._current_image()
        self.ax_img.imshow(
            img if img.ndim == 3 else img,
            cmap="gray", interpolation="nearest",
        )
        title = f"{self.names[self.idx]} — {'修补后' if self.show_repaired else '原图'}"
        self.ax_img.set_title(title)

        if self.show_overlay:
            states = (
                self._repair_result.states[self.idx]
                if self._repair_result is not None
                else {}
            )
            eff = self.sel.effective(self.det)
            for col in range(img.shape[1]):
                if col in self.sel.protected:
                    color = STATE_COLORS[PROTECTED]
                elif col in states:
                    color = STATE_COLORS[states[col]]
                elif col in eff and col not in self.sel.excluded:
                    color = (0.2, 0.6, 1.0)
                else:
                    continue
                self.ax_img.axvline(col, color=color, alpha=0.35, linewidth=1.0)
            for col in self.sel.excluded:
                self.ax_img.axvline(col, color="white", alpha=0.6,
                                    linewidth=0.8, linestyle="--")

        self.ax_prof.cla()
        prof_img = self._current_image()
        gray = prof_img if prof_img.ndim == 2 else to_gray(prof_img)
        self.ax_prof.plot(gray.mean(axis=0), color="0.25", label="列均值")
        if self.show_resid and not self.show_repaired:
            scale = max(np.abs(self.det.frame_median_resid[self.idx]).max(), 1.0)
            mean0 = gray.mean()
            self.ax_prof.plot(
                mean0 + self.det.frame_median_resid[self.idx],
                color="tab:red", linewidth=0.9,
                label="基线残差(偏移后叠加显示)",
            )
        eff = self.sel.effective(self.det)
        for col, frames in eff.items():
            active = frames is None or self.idx in frames
            if not active or col in self.sel.protected:
                continue
            self.ax_prof.axvline(
                col, color="tab:blue", alpha=0.25, linewidth=0.8
            )
        for col in self.sel.protected:
            self.ax_prof.axvline(col, color="tab:green", alpha=0.4,
                                 linewidth=0.8, linestyle=":")
        self.ax_prof.set_title(
            f"帧 {self.idx} 列剖面(点击图/剖面补选, Shift+点击排除, 右键保护)"
        )
        self.ax_prof.legend(fontsize=8, loc="upper right")
        self.fig.canvas.draw_idle()


def launch_gui(
    frames: np.ndarray,
    frame_names: list[str],
    detection: DetectionResult | None = None,
    clean: np.ndarray | None = None,
    selection: ColumnSelection | None = None,
) -> BadColumnGUI:
    if detection is None:
        gray = frames if frames.ndim == 3 else np.stack([to_gray(f) for f in frames])
        detection = detect_columns(gray)
    gui = BadColumnGUI(frames, frame_names, detection, clean, selection)
    return gui
