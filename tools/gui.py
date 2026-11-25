#!/usr/bin/env python3
"""SeamSqueeze 本地交互界面（matplotlib，无需网络）。

用法：
  python tools/gui.py examples/sparse.png
  python tools/gui.py --demo sparse      # 自动生成演示图再打开
  python tools/gui.py --demo dense

交互：
  * 左侧先选「画保护区 / 画留白」，再在图上拖拽矩形；
  * 填目标宽高、选宽高顺序；
  * 「预览下一缝」高亮拟抽位置（触碰保护区会红字警示）；
  * 「抽走一缝」「撤销一步」逐步推进，撤销后蒙版随源像素映射还原；
  * 「缩到目标」自动完成；保护区放不下时弹明确提示；
  * 「三联对照」对比普通缩放与直接裁边；「导出」保存全套产物。
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np

import matplotlib

# 尊重外部 MPLBACKEND（无头测试用 Agg）；未指定时才按平台选交互后端。
if not os.environ.get("MPLBACKEND"):
    matplotlib.use("macosx" if sys.platform == "darwin" else "TkAgg")
import matplotlib.pyplot as plt  # noqa: E402

# 让 matplotlib 界面里的中文标题正常显示（找不到中文字体时静默回退）。
matplotlib.rcParams["font.sans-serif"] = [
    "PingFang SC", "Hiragino Sans GB", "Arial Unicode MS", "DejaVu Sans",
]
matplotlib.rcParams["axes.unicode_minus"] = False
from matplotlib.widgets import Button, RadioButtons, RectangleSelector, TextBox  # noqa: E402

from seamsqueeze import MaskSet, Rect, SeamEngine  # noqa: E402
from seamsqueeze.demo import build_demo_images, make_dense, make_sparse  # noqa: E402
from seamsqueeze.engine import (  # noqa: E402
    VERTICAL,
    EngineError,
    ProtectionBlockedError,
    TargetTooSmallError,
)
from seamsqueeze.project import load_rgb  # noqa: E402
from seamsqueeze.viz import contact_sheet, draw_masks, draw_seam  # noqa: E402
from tools.exportutil import export_all  # noqa: E402


class SeamSqueezeGUI:
    def __init__(self, source_path: str, source: np.ndarray, masks: MaskSet) -> None:
        self.source_path = os.path.abspath(source_path)
        self.source = source
        self.masks = masks
        self.applied: list[str] = []          # 已抽缝方向（源坐标复现用）
        self.engine = self._build_engine()
        self._preview_path: list[tuple[int, int]] | None = None

        self.fig = plt.figure(figsize=(13.5, 7.6))
        self.ax = self.fig.add_axes([0.04, 0.08, 0.66, 0.86])
        self.ax.set_title("拖拽框选；红色=保护区  蓝色=优先缩减留白  黄线=拟抽缝")
        self._im = None

        panel = self.fig.add_axes([0.72, 0.05, 0.26, 0.9])
        panel.axis("off")
        self._build_panel(panel)

        self.selector = RectangleSelector(
            self.ax, self._on_rect,
            useblit=True, button=[1], minspanx=4, minspany=4,
            spancoords="pixels", interactive=False,
        )
        self.fig.canvas.mpl_connect("close_event", lambda _e: plt.close(self.fig))
        self.refresh()

    # ------------------------------------------------------------------
    def _build_engine(self) -> SeamEngine:
        engine = SeamEngine(self.source, self.masks)
        engine.apply_directions(self.applied)
        return engine

    def _build_panel(self, panel) -> None:
        # 全部使用相对面板的绝对 y 坐标布局，避免增量排布导致底部溢出。
        panel.text(0.0, 0.985, "SeamSqueeze", fontsize=15, weight="bold")
        # 固定信息行（尺寸 / 下界 / 矩形数），每次 refresh 整体替换。
        self.info = panel.text(
            0.0, 0.945, "", fontsize=9, va="top", transform=panel.transAxes
        )
        # 瞬时状态行（操作提示 / 警示），由 _set_status 写入。
        self.status = panel.text(
            0.0, 0.815, "", fontsize=9, va="top", color="dimgray",
            transform=panel.transAxes,
        )

        panel.text(0.0, 0.745, "框选类型", fontsize=10, weight="bold")
        ax_radio_type = panel.inset_axes([0.0, 0.62, 0.95, 0.115])
        self.radio_type = RadioButtons(ax_radio_type, ("画保护区", "画留白"))
        ax_del = panel.inset_axes([0.0, 0.60, 0.95, 0.045])
        self.btn_del_rect = Button(ax_del, "删除最后一个矩形")
        self.btn_del_rect.on_clicked(lambda _e: self._delete_last_rect())

        panel.text(0.0, 0.555, "目标尺寸 / 顺序", fontsize=10, weight="bold")
        self.tb_w = TextBox(
            panel.inset_axes([0.0, 0.50, 0.6, 0.045]),
            "宽 ", initial=str(self.engine.size[0]), textalignment="center",
        )
        self.tb_h = TextBox(
            panel.inset_axes([0.0, 0.445, 0.6, 0.045]),
            "高 ", initial=str(self.engine.size[1]), textalignment="center",
        )
        ax_order = panel.inset_axes([0.0, 0.315, 0.98, 0.12])
        self.radio_order = RadioButtons(
            ax_order,
            ("alternate 交替", "width_first 先宽", "height_first 先高"),
        )

        specs = [
            ("预览下一缝", self._preview),
            ("抽走一缝", self._step),
            ("撤销一步", self._undo),
            ("缩到目标", self._auto),
            ("重置全部", self._reset),
            ("三联对照", self._compare),
            ("导出结果", self._export),
        ]
        self.buttons: list[Button] = []
        top, step, height = 0.275, 0.038, 0.032
        for i, (label, cb) in enumerate(specs):
            ax_b = panel.inset_axes([0.0, top - i * step, 0.95, height])
            btn = Button(ax_b, label)
            btn.on_clicked(lambda _e, fn=cb: fn())
            self.buttons.append(btn)

        self._panel = panel

    # ------------------------------------------------------------------
    # 矩形框选（当前帧坐标 -> 源坐标矩形）
    # ------------------------------------------------------------------
    def _on_rect(self, eclick, erelease) -> None:
        x0, x1 = sorted((int(eclick.xdata), int(erelease.xdata)))
        y0, y1 = sorted((int(eclick.ydata), int(erelease.ydata)))
        h, w = self.engine.protect.shape
        x0, x1 = max(0, x0), min(w - 1, x1)
        y0, y1 = max(0, y0), min(h - 1, y1)
        if x1 <= x0 or y1 <= y0:
            return

        # 通过 src_map 把当前帧框反算成源坐标闭区间矩形。
        sub = self.engine.src_map[y0 : y1 + 1, x0 : x1 + 1]
        ids = np.unique(sub)
        sy, sx = np.divmod(ids, self.engine.src_w)
        rect = Rect(int(sx.min()), int(sy.min()), int(sx.max()), int(sy.max()),
                    name="保护区" if self.radio_type.value_selected == "画保护区"
                    else "留白")
        kind = "protect" if self.radio_type.value_selected == "画保护区" else "shrink"
        try:
            new_masks = MaskSet(
                protect=list(self.masks.protect) + ([rect] if kind == "protect" else []),
                shrink=list(self.masks.shrink) + ([rect] if kind == "shrink" else []),
            )
            new_masks.validate(self.engine.src_h, self.engine.src_w)
        except ValueError as exc:
            self._set_status(f"矩形无效：{exc}", error=True)
            return
        self._apply_masks(new_masks)

    def _delete_last_rect(self) -> None:
        if self.radio_type.value_selected == "画保护区":
            if not self.masks.protect:
                self._set_status("没有可删除的保护区", error=True)
                return
            new_masks = MaskSet(
                protect=self.masks.protect[:-1], shrink=list(self.masks.shrink)
            )
        else:
            if not self.masks.shrink:
                self._set_status("没有可删除的留白", error=True)
                return
            new_masks = MaskSet(
                protect=list(self.masks.protect), shrink=self.masks.shrink[:-1]
            )
        self._apply_masks(new_masks)

    def _apply_masks(self, new_masks: MaskSet) -> None:
        """切换蒙版并从源图回放；非法或与已抽缝冲突时回滚，保留原状态。"""
        old_masks = self.masks
        self.masks = new_masks
        try:
            self._build_engine()
        except (EngineError, ValueError) as exc:
            self.masks = old_masks
            self._set_status(
                f"蒙版未生效：新区域非法或与已抽掉的 {len(self.applied)} 条缝冲突"
                f"（{exc}）。请先撤销到更早一步再框选。",
                error=True,
            )
            return
        self._rebuild()

    # ------------------------------------------------------------------
    def _order(self) -> str:
        return self.radio_order.value_selected.split()[0]

    def _target(self) -> tuple[int, int]:
        return int(self.tb_w.text), int(self.tb_h.text)

    def _next_direction(self) -> str | None:
        tw, th = self._target()
        w, h = self.engine.size
        n_w, n_h = w - tw, h - th
        if n_w <= 0 and n_h <= 0:
            return None
        seq = SeamEngine._plan_sequence(max(0, n_w), max(0, n_h), self._order())
        return seq[0] if seq else None

    def _preview(self) -> None:
        direction = self._next_direction()
        if direction is None:
            self._set_status("已达到目标尺寸，没有拟抽的缝")
            self._preview_path = None
            self.refresh()
            return
        rec = self.engine.preview_seam(direction)
        self._preview_path = rec.current_path
        if rec.hits_protection:
            self._set_status(
                "警示：最小代价缝仍穿过保护区！继续抽缝会破坏完整物件，"
                "请放宽目标尺寸或调整保护区域。",
                error=True,
            )
        else:
            self._set_status(
                f"拟抽{'竖直' if direction == VERTICAL else '水平'}缝 "
                f"（代价 {rec.cost:,.0f}），不触碰保护区；点「抽走一缝」执行"
            )
        self.refresh(seam=True)

    def _step(self) -> None:
        direction = self._next_direction()
        if direction is None:
            self._set_status("已达到目标尺寸")
            return
        try:
            self.engine.remove_seam(direction)
        except ProtectionBlockedError as exc:
            self._set_status(f"已阻止：{exc}", error=True)
            return
        self.applied.append(direction)
        self._preview_path = None
        self.refresh()

    def _undo(self) -> None:
        if not self.applied:
            self._set_status("没有可撤销的步骤", error=True)
            return
        self.applied.pop()
        self._rebuild()
        self._set_status("已撤销一步，保护/留白蒙版随源像素映射还原")

    def _auto(self) -> None:
        tw, th = self._target()
        try:
            self.engine.check_target(tw, th)
            records = self.engine.resize_to(tw, th, order=self._order())
        except TargetTooSmallError as exc:
            self._set_status(f"无法缩到目标：{exc}", error=True)
            self.refresh()
            return
        except ProtectionBlockedError as exc:
            self._set_status(f"中途被保护区挡住：{exc}", error=True)
            self.refresh()
            return
        self.applied.extend(r.direction for r in records)
        self._preview_path = None
        self.refresh()

    def _reset(self) -> None:
        self.applied = []
        self.masks = MaskSet()
        self._rebuild()
        w, h = self.engine.source_size
        self.tb_w.set_val(str(w))
        self.tb_h.set_val(str(h))

    def _compare(self) -> None:
        from seamsqueeze.compare import build_comparison

        tw, th = self.engine.size
        panels = build_comparison(self.source, self.engine.image, tw, th)
        sheet = contact_sheet(
            [
                (f"seam carving {tw}x{th}", panels["seam"]),
                (f"普通缩放 {tw}x{th}", panels["scale"]),
                (f"直接裁边 {tw}x{th}", panels["crop"]),
            ]
        )
        fig = plt.figure(figsize=(14, 5))
        ax = fig.add_subplot(111)
        ax.imshow(sheet)
        ax.axis("off")
        ax.set_title("同尺寸三联对照（关闭窗口返回主界面）")
        fig.show()

    def _export(self) -> None:
        out_dir = os.path.join(
            os.path.dirname(self.source_path) or ".",
            "gui_export",
        )
        try:
            paths = export_all(
                out_dir, self.source_path, self.source, self.engine,
                self.masks, self._order(),
            )
        except (EngineError, ValueError) as exc:
            self._set_status(f"导出失败：{exc}", error=True)
            return
        self._set_status("已导出：\n" + "\n".join(paths.values()))

    # ------------------------------------------------------------------
    def _rebuild(self) -> None:
        """蒙版变化后从源图重建并按已执行方向确定性回放。"""
        self.engine = self._build_engine()
        self._preview_path = None
        self.refresh()

    def _set_status(self, text: str, error: bool = False) -> None:
        self.status.set_text(("✘ " if error else "• ") + text)
        self.status.set_color("crimson" if error else "dimgray")
        self.fig.canvas.draw_idle()

    def refresh(self, seam: bool = False) -> None:
        frame = draw_masks(
            self.engine.image, self.engine.protect, self.engine.shrink
        )
        if seam and self._preview_path is not None:
            frame = draw_seam(frame, self._preview_path, self.engine.protect)
        if self._im is None:
            self._im = self.ax.imshow(frame)
        else:
            self._im.set_data(frame)
        self.ax.set_xlim(-0.5, frame.shape[1] - 0.5)
        self.ax.set_ylim(frame.shape[0] - 0.5, -0.5)

        w, h = self.engine.size
        sw, sh = self.engine.source_size
        self.info.set_text(
            f"当前 {w}x{h}（源 {sw}x{sh}）  步数 {len(self.applied)}\n"
            f"保护区下界：最小宽 {self.engine.min_width()}px / "
            f"最小高 {self.engine.min_height()}px\n"
            f"保护矩形 {len(self.masks.protect)} 个 / "
            f"留白矩形 {len(self.masks.shrink)} 个"
        )
        self.ax.figure.canvas.draw_idle()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="SeamSqueeze 本地交互界面")
    parser.add_argument("image", nargs="?", help="源图路径")
    parser.add_argument("--demo", choices=("sparse", "dense"),
                        help="不提供源图时，生成指定几何演示图")
    parser.add_argument("--demo-dir", default="examples")
    args = parser.parse_args(argv)

    if args.image:
        source_path = args.image
        source = load_rgb(source_path)
        masks = MaskSet()
    elif args.demo:
        paths = build_demo_images(args.demo_dir)
        source_path = paths[args.demo]
        builder = make_sparse if args.demo == "sparse" else make_dense
        _, masks = builder()
        source = load_rgb(source_path)
    else:
        parser.error("请提供源图路径，或使用 --demo sparse|dense")

    gui = SeamSqueezeGUI(source_path, source, masks)
    plt.show()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
